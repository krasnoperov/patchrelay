import path from "node:path";
import type { Logger } from "pino";
import { CodexAppServerClient, type CodexNotification } from "./codex-app-server.js";
import { PatchRelayDatabase } from "./db.js";
import { resolveProject, triggerEventAllowed } from "./project-resolution.js";
import { acceptIncomingWebhook } from "./service-webhooks.js";
import { buildStageLaunchPlan, isCodexThreadId } from "./stage-launch.js";
import {
  buildFailedStageReport,
  buildPendingMaterializationThread,
  buildStageReport,
  countEventMethods,
  extractStageSummary,
  extractTurnId,
  resolveStageRunStatus,
  summarizeCurrentThread,
} from "./stage-reporting.js";
import type {
  AppConfig,
  CodexThreadSummary,
  LinearWebhookPayload,
  StageReport,
  StageRunRecord,
  TrackedIssueRecord,
} from "./types.js";
import { ensureDir, execCommand, safeJsonParse } from "./utils.js";
import { normalizeWebhook } from "./webhooks.js";
import { resolveWorkflowStage } from "./workflow-policy.js";

const ISSUE_KEY_DELIMITER = "::";

class InMemoryQueue<T> {
  private items: T[] = [];
  private pending = false;

  constructor(private readonly onDequeue: (item: T) => Promise<void>, private readonly logger: Logger) {}

  enqueue(item: T): void {
    this.items.push(item);
    if (!this.pending) {
      this.pending = true;
      queueMicrotask(() => {
        void this.drain();
      });
    }
  }

  private async drain(): Promise<void> {
    while (this.items.length > 0) {
      const next = this.items.shift();
      if (next === undefined) {
        continue;
      }

      try {
        await this.onDequeue(next);
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        this.logger.error({ item: next, error: err.message, stack: err.stack }, "Queue item processing failed");
      }
    }
    this.pending = false;
  }
}

function makeIssueQueueKey(projectId: string, issueId: string): string {
  return `${projectId}${ISSUE_KEY_DELIMITER}${issueId}`;
}

function parseIssueQueueKey(value: string): { projectId: string; issueId: string } {
  const [projectId, issueId] = value.split(ISSUE_KEY_DELIMITER);
  if (!projectId || !issueId) {
    throw new Error(`Invalid issue queue key: ${value}`);
  }
  return { projectId, issueId };
}

export class PatchRelayService {
  readonly webhookQueue: InMemoryQueue<number>;
  readonly issueQueue: InMemoryQueue<string>;

  constructor(
    readonly config: AppConfig,
    readonly db: PatchRelayDatabase,
    readonly codex: CodexAppServerClient,
    readonly logger: Logger,
  ) {
    this.webhookQueue = new InMemoryQueue((eventId) => this.processWebhookEvent(eventId), logger);
    this.issueQueue = new InMemoryQueue((issueKey) => this.processIssue(issueKey), logger);
    this.codex.on("notification", (notification: CodexNotification) => {
      void this.handleCodexNotification(notification);
    });
  }

  async start(): Promise<void> {
    await this.codex.start();
    await this.reconcileActiveStageRuns();
    for (const issue of this.db.listIssuesReadyForExecution()) {
      this.issueQueue.enqueue(makeIssueQueueKey(issue.projectId, issue.linearIssueId));
    }
  }

  stop(): void {
    void this.codex.stop();
  }

  async acceptWebhook(params: {
    webhookId: string;
    headers: Record<string, string | string[] | undefined>;
    rawBody: Buffer;
  }): Promise<{
    status: number;
    body: Record<string, string | number | boolean>;
  }> {
    const result = await acceptIncomingWebhook({
      config: this.config,
      db: this.db,
      logger: this.logger,
      webhookId: params.webhookId,
      headers: params.headers,
      rawBody: params.rawBody,
    });
    if (result.accepted) {
      this.webhookQueue.enqueue(result.accepted.id);
    }
    return {
      status: result.status,
      body: result.body,
    };
  }

  async processWebhookEvent(webhookEventId: number): Promise<void> {
    const event = this.db.getWebhookEvent(webhookEventId);
    if (!event) {
      return;
    }

    const payload = safeJsonParse<LinearWebhookPayload>(event.payloadJson);
    if (!payload) {
      this.db.markWebhookProcessed(webhookEventId, "failed");
      throw new Error(`Stored webhook payload is invalid JSON: event ${webhookEventId}`);
    }

    const normalized = normalizeWebhook({
      webhookId: event.webhookId,
      payload,
    });
    const project = resolveProject(this.config, normalized.issue);
    if (!project) {
      this.db.markWebhookProcessed(webhookEventId, "processed");
      return;
    }

    this.db.assignWebhookProject(webhookEventId, project.id);
    const desiredStage = triggerEventAllowed(project, normalized.triggerEvent)
      ? resolveWorkflowStage(project, normalized.issue.stateName)
      : undefined;

    this.db.recordDesiredStage({
      projectId: project.id,
      linearIssueId: normalized.issue.id,
      ...(normalized.issue.identifier ? { issueKey: normalized.issue.identifier } : {}),
      ...(normalized.issue.title ? { title: normalized.issue.title } : {}),
      ...(normalized.issue.url ? { issueUrl: normalized.issue.url } : {}),
      ...(normalized.issue.stateName ? { currentLinearState: normalized.issue.stateName } : {}),
      ...(desiredStage ? { desiredStage } : {}),
      ...(desiredStage ? { desiredWebhookId: normalized.webhookId } : {}),
      lastWebhookAt: new Date().toISOString(),
    });

    this.db.markWebhookProcessed(webhookEventId, "processed");
    if (desiredStage) {
      this.issueQueue.enqueue(makeIssueQueueKey(project.id, normalized.issue.id));
    }
  }

  async processIssue(issueQueueKey: string): Promise<void> {
    const { projectId, issueId } = parseIssueQueueKey(issueQueueKey);
    const project = this.config.projects.find((candidate) => candidate.id === projectId);
    if (!project) {
      return;
    }

    const issue = this.db.getTrackedIssue(projectId, issueId);
    if (!issue || !issue.desiredStage || !issue.desiredWebhookId || issue.activeStageRunId) {
      return;
    }

    const plan = buildStageLaunchPlan(project, issue, issue.desiredStage);
    const claim = this.db.claimStageRun({
      projectId,
      linearIssueId: issueId,
      stage: issue.desiredStage,
      triggerWebhookId: issue.desiredWebhookId,
      branchName: plan.branchName,
      worktreePath: plan.worktreePath,
      workflowFile: plan.workflowFile,
      promptText: plan.prompt,
    });
    if (!claim) {
      return;
    }

    await ensureDir(project.worktreeRoot);
    await this.ensureWorktree(project.repoPath, plan.worktreePath, plan.branchName);

    try {
      const previousStageRun = this.db
        .listStageRunsForIssue(projectId, issueId)
        .filter((stageRun) => stageRun.id !== claim.stageRun.id)
        .at(-1);
      const parentThreadId =
        previousStageRun?.id !== claim.stageRun.id &&
        previousStageRun?.status === "completed" &&
        isCodexThreadId(previousStageRun.threadId)
          ? previousStageRun.threadId
          : undefined;

      let thread;
      let actualParentThreadId: string | undefined;
      if (parentThreadId) {
        try {
          thread = await this.codex.forkThread(parentThreadId, plan.worktreePath);
          actualParentThreadId = parentThreadId;
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error));
          this.logger.warn(
            {
              issueKey: issue.issueKey,
              stage: claim.stageRun.stage,
              parentThreadId,
              error: err.message,
            },
            "Falling back to a fresh Codex thread after parent thread fork failed",
          );
          thread = await this.codex.startThread({ cwd: plan.worktreePath });
        }
      } else {
        thread = await this.codex.startThread({ cwd: plan.worktreePath });
      }

      const turn = await this.codex.startTurn({
        threadId: thread.id,
        cwd: plan.worktreePath,
        input: plan.prompt,
      });

      this.db.updateStageRunThread({
        stageRunId: claim.stageRun.id,
        threadId: thread.id,
        ...(actualParentThreadId ? { parentThreadId: actualParentThreadId } : {}),
        turnId: turn.turnId,
      });

      this.logger.info(
        {
          issueKey: issue.issueKey,
          stage: claim.stageRun.stage,
          worktreePath: plan.worktreePath,
          branchName: plan.branchName,
          threadId: thread.id,
          turnId: turn.turnId,
        },
        "Started Codex stage run",
      );
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      const failureThreadId = `launch-failed-${claim.stageRun.id}`;
      this.db.finishStageRun({
        stageRunId: claim.stageRun.id,
        status: "failed",
        threadId: failureThreadId,
        summaryJson: JSON.stringify({ message: err.message }),
        reportJson: JSON.stringify(buildFailedStageReport(claim.stageRun, "failed", { threadId: failureThreadId })),
      });
      this.logger.error(
        {
          issueKey: issue.issueKey,
          stage: claim.stageRun.stage,
          worktreePath: plan.worktreePath,
          branchName: plan.branchName,
          error: err.message,
          stack: err.stack,
        },
        "Failed to launch Codex stage run",
      );
      throw err;
    }
  }

  async getIssueOverview(issueKey: string) {
    const result = this.db.getIssueOverview(issueKey);
    if (!result) {
      return undefined;
    }

    const latestStageRun = this.db.getLatestStageRunForIssue(result.issue.projectId, result.issue.linearIssueId);
    let liveThread;
    if (result.activeStageRun?.threadId) {
      liveThread = await this.codex.readThread(result.activeStageRun.threadId, true).catch(() => undefined);
    }

    return {
      ...result,
      ...(latestStageRun ? { latestStageRun } : {}),
      ...(liveThread ? { liveThread: summarizeCurrentThread(liveThread) } : {}),
    };
  }

  async getIssueReport(issueKey: string): Promise<
    | {
        issue: TrackedIssueRecord;
        stages: Array<{
          stageRun: StageRunRecord;
          report?: StageReport;
        }>;
      }
    | undefined
  > {
    const issue = this.db.getTrackedIssueByKey(issueKey);
    if (!issue) {
      return undefined;
    }

    return {
      issue,
      stages: this.db.listStageRunsForIssue(issue.projectId, issue.linearIssueId).map((stageRun) => ({
        stageRun,
        ...(stageRun.reportJson ? { report: JSON.parse(stageRun.reportJson) as StageReport } : {}),
      })),
    };
  }

  async getStageEvents(issueKey: string, stageRunId: number) {
    const issue = this.db.getTrackedIssueByKey(issueKey);
    if (!issue) {
      return undefined;
    }

    const stageRun = this.db.getStageRun(stageRunId);
    if (!stageRun || stageRun.projectId !== issue.projectId || stageRun.linearIssueId !== issue.linearIssueId) {
      return undefined;
    }

    return {
      issue,
      stageRun,
      events: this.db.listThreadEvents(stageRunId).map((event) => ({
        ...event,
        parsedEvent: safeJsonParse<Record<string, unknown>>(event.eventJson),
      })),
    };
  }

  async getActiveStageStatus(issueKey: string) {
    const issue = this.db.getTrackedIssueByKey(issueKey);
    if (!issue || !issue.activeStageRunId) {
      return undefined;
    }

    const stageRun = this.db.getStageRun(issue.activeStageRunId);
    if (!stageRun || !stageRun.threadId) {
      return undefined;
    }

    const thread = await this.codex.readThread(stageRun.threadId, true).catch((error) => {
      const err = error instanceof Error ? error : new Error(String(error));
      return buildPendingMaterializationThread(stageRun, err);
    });

    return {
      issue,
      stageRun,
      liveThread: summarizeCurrentThread(thread),
    };
  }

  private async handleCodexNotification(notification: CodexNotification): Promise<void> {
    const threadId = typeof notification.params.threadId === "string" ? notification.params.threadId : undefined;
    if (!threadId) {
      return;
    }

    const stageRun = this.db.getStageRunByThreadId(threadId);
    if (!stageRun) {
      return;
    }

    const turnId = typeof notification.params.turnId === "string" ? notification.params.turnId : undefined;
    this.db.saveThreadEvent({
      stageRunId: stageRun.id,
      threadId,
      ...(turnId ? { turnId } : {}),
      method: notification.method,
      eventJson: JSON.stringify(notification.params),
    });

    if (notification.method !== "turn/completed") {
      return;
    }

    const thread = await this.codex.readThread(threadId, true);
    const stageStatus = resolveStageRunStatus(notification.params);
    const issue = this.db.getTrackedIssue(stageRun.projectId, stageRun.linearIssueId);
    if (!issue) {
      return;
    }

    const completedTurnId = extractTurnId(notification.params);
    this.completeStageRun(stageRun, issue, thread, stageStatus, {
      threadId,
      ...(completedTurnId ? { turnId: completedTurnId } : {}),
    });
  }

  private async reconcileActiveStageRuns(): Promise<void> {
    const activeStageRuns = this.db.listActiveStageRuns();
    for (const stageRun of activeStageRuns) {
      if (!stageRun.threadId) {
        this.failStageRun(stageRun, `missing-thread-${stageRun.id}`, "Stage run had no persisted thread id during reconciliation");
        continue;
      }

      const thread = await this.codex.readThread(stageRun.threadId, true).catch(() => undefined);
      if (!thread) {
        this.failStageRun(stageRun, stageRun.threadId, "Thread was not found during startup reconciliation", {
          ...(stageRun.turnId ? { turnId: stageRun.turnId } : {}),
        });
        continue;
      }

      const latestTurn = thread.turns.at(-1);
      if (!latestTurn || latestTurn.status === "inProgress") {
        continue;
      }

      const issue = this.db.getTrackedIssue(stageRun.projectId, stageRun.linearIssueId);
      if (!issue) {
        continue;
      }

      const resolvedStatus = latestTurn.status === "completed" ? "completed" : "failed";
      if (resolvedStatus === "failed") {
        this.failStageRun(stageRun, stageRun.threadId, "Thread completed reconciliation in a failed state", {
          ...(latestTurn.id ? { turnId: latestTurn.id } : {}),
        });
        continue;
      }

      this.completeStageRun(stageRun, issue, thread, "completed", {
        threadId: stageRun.threadId,
        ...(latestTurn.id ? { turnId: latestTurn.id } : {}),
      });
    }
  }

  private completeStageRun(
    stageRun: StageRunRecord,
    issue: TrackedIssueRecord,
    thread: CodexThreadSummary,
    status: StageRunRecord["status"],
    params: { threadId: string; turnId?: string },
  ): void {
    const refreshedStageRun = this.db.getStageRun(stageRun.id) ?? stageRun;
    const finalizedStageRun = {
      ...refreshedStageRun,
      status,
      threadId: params.threadId,
      ...(params.turnId ? { turnId: params.turnId } : {}),
    };
    const report = buildStageReport(finalizedStageRun, issue, thread, countEventMethods(this.db.listThreadEvents(stageRun.id)));

    this.db.finishStageRun({
      stageRunId: stageRun.id,
      status,
      threadId: params.threadId,
      ...(params.turnId ? { turnId: params.turnId } : {}),
      summaryJson: JSON.stringify(extractStageSummary(report)),
      reportJson: JSON.stringify(report),
    });

    this.advanceAfterStageCompletion(stageRun);
  }

  private failStageRun(
    stageRun: StageRunRecord,
    threadId: string,
    message: string,
    options?: {
      turnId?: string;
    },
  ): void {
    this.db.finishStageRun({
      stageRunId: stageRun.id,
      status: "failed",
      threadId,
      ...(options?.turnId ? { turnId: options.turnId } : {}),
      summaryJson: JSON.stringify({ message }),
      reportJson: JSON.stringify(
        buildFailedStageReport(stageRun, "failed", {
          threadId,
          ...(options?.turnId ? { turnId: options.turnId } : {}),
        }),
      ),
    });
  }

  private advanceAfterStageCompletion(stageRun: StageRunRecord): void {
    const refreshedIssue = this.db.getTrackedIssue(stageRun.projectId, stageRun.linearIssueId);
    const pipeline = this.db.getPipelineRun(stageRun.pipelineRunId);
    if (refreshedIssue?.desiredStage) {
      this.issueQueue.enqueue(makeIssueQueueKey(stageRun.projectId, stageRun.linearIssueId));
      return;
    }

    if (pipeline) {
      this.db.markPipelineCompleted(pipeline.id);
    }
  }
  private async ensureWorktree(repoPath: string, worktreePath: string, branchName: string): Promise<void> {
    await ensureDir(path.dirname(worktreePath));
    await execCommand(this.config.runner.gitBin, ["-C", repoPath, "worktree", "add", "--force", "-B", branchName, worktreePath, "HEAD"], {
      timeoutMs: 120_000,
    });
  }
}
