import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Logger } from "pino";
import { CodexAppServerClient, type CodexNotification } from "./codex-app-server.js";
import { PatchRelayDatabase } from "./db.js";
import { resolveProject, triggerEventAllowed } from "./project-resolution.js";
import type {
  AppConfig,
  CodexThreadItem,
  CodexThreadSummary,
  LinearWebhookPayload,
  NormalizedEvent,
  ProjectConfig,
  StageLaunchPlan,
  StageReport,
  StageRunRecord,
  TrackedIssueRecord,
  WorkflowStage,
} from "./types.js";
import { ensureDir, execCommand, safeJsonParse, timestampMsWithinSkew, verifyHmacSha256Hex } from "./utils.js";
import { archiveWebhook } from "./webhook-archive.js";
import { normalizeWebhook } from "./webhooks.js";

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

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-");
}

function isCodexThreadId(value: string | undefined): value is string {
  if (!value) {
    return false;
  }

  return !value.startsWith("missing-thread-") && !value.startsWith("launch-failed-");
}

function resolveStage(project: ProjectConfig, stateName?: string): WorkflowStage | undefined {
  const normalized = stateName?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }

  if (normalized === project.workflowStatuses.development.trim().toLowerCase()) {
    return "development";
  }
  if (normalized === project.workflowStatuses.review.trim().toLowerCase()) {
    return "review";
  }
  if (normalized === project.workflowStatuses.deploy.trim().toLowerCase()) {
    return "deploy";
  }
  if (project.workflowStatuses.cleanup && normalized === project.workflowStatuses.cleanup.trim().toLowerCase()) {
    return "cleanup";
  }

  return undefined;
}

function buildStageLaunchPlan(project: ProjectConfig, issue: TrackedIssueRecord, stage: WorkflowStage): StageLaunchPlan {
  const issueRef = sanitizePathSegment(issue.issueKey ?? issue.linearIssueId);
  const slug = issue.title ? slugify(issue.title) : "";
  const branchSuffix = slug ? `${issueRef}-${slug}` : issueRef;
  const workflowFile = project.workflowFiles[stage];

  return {
    branchName: `${project.branchPrefix}/${branchSuffix}`,
    worktreePath: path.join(project.worktreeRoot, issueRef),
    workflowFile,
    stage,
    prompt: buildStagePrompt(issue, stage, workflowFile),
  };
}

function buildStagePrompt(issue: TrackedIssueRecord, stage: WorkflowStage, workflowFile: string): string {
  const workflowBody = existsSync(workflowFile) ? readFileSync(workflowFile, "utf8").trim() : "";
  return [
    `Issue: ${issue.issueKey ?? issue.linearIssueId}`,
    issue.title ? `Title: ${issue.title}` : undefined,
    issue.issueUrl ? `Linear URL: ${issue.issueUrl}` : undefined,
    issue.currentLinearState ? `Current Linear State: ${issue.currentLinearState}` : undefined,
    `Stage: ${stage}`,
    "",
    "Operate only inside the prepared worktree for this issue. Continue the issue lifecycle in this workspace.",
    "Capture a crisp summary of what you did, what changed, and what remains blocked so PatchRelay can publish a read-only report.",
    "",
    `Workflow File: ${path.basename(workflowFile)}`,
    workflowBody,
  ]
    .filter(Boolean)
    .join("\n");
}

function extractStageSummary(report: StageReport): Record<string, unknown> {
  return {
    assistantMessageCount: report.assistantMessages.length,
    commandCount: report.commands.length,
    fileChangeCount: report.fileChanges.length,
    toolCallCount: report.toolCalls.length,
    latestAssistantMessage: report.assistantMessages.at(-1) ?? null,
  };
}

function summarizeCurrentThread(thread: CodexThreadSummary): {
  threadId: string;
  threadStatus: string;
  latestTurnId?: string;
  latestTurnStatus?: string;
  latestAgentMessage?: string;
} {
  const latestTurn = thread.turns.at(-1);
  const latestAgentMessage = latestTurn?.items
    .filter((item): item is Extract<CodexThreadItem, { type: "agentMessage" }> => item.type === "agentMessage")
    .at(-1)?.text;

  return {
    threadId: thread.id,
    threadStatus: thread.status,
    ...(latestTurn ? { latestTurnId: latestTurn.id, latestTurnStatus: latestTurn.status } : {}),
    ...(latestAgentMessage ? { latestAgentMessage } : {}),
  };
}

function buildStageReport(stageRun: StageRunRecord, issue: TrackedIssueRecord, thread: CodexThreadSummary, eventCounts: Record<string, number>): StageReport {
  const assistantMessages: string[] = [];
  const plans: string[] = [];
  const reasoning: string[] = [];
  const commands: StageReport["commands"] = [];
  const fileChanges: Array<Record<string, unknown>> = [];
  const toolCalls: StageReport["toolCalls"] = [];

  for (const turn of thread.turns) {
    for (const rawItem of turn.items as CodexThreadItem[]) {
      const item = rawItem as CodexThreadItem & Record<string, unknown>;
      if (item.type === "agentMessage" && typeof item.text === "string") {
        assistantMessages.push(item.text);
      } else if (item.type === "plan" && typeof item.text === "string") {
        plans.push(item.text);
      } else if (
        item.type === "reasoning" &&
        Array.isArray(item.summary) &&
        Array.isArray(item.content)
      ) {
        reasoning.push(...(item.summary as string[]), ...(item.content as string[]));
      } else if (item.type === "commandExecution" && typeof item.command === "string" && typeof item.cwd === "string") {
        commands.push({
          command: item.command,
          cwd: item.cwd,
          status: typeof item.status === "string" ? item.status : "unknown",
          ...(typeof item.exitCode === "number" || item.exitCode === null ? { exitCode: item.exitCode as number | null } : {}),
          ...(typeof item.durationMs === "number" || item.durationMs === null
            ? { durationMs: item.durationMs as number | null }
            : {}),
        });
      } else if (item.type === "fileChange" && Array.isArray(item.changes)) {
        fileChanges.push(...(item.changes as Array<Record<string, unknown>>));
      } else if (item.type === "mcpToolCall" && typeof item.server === "string" && typeof item.tool === "string") {
        toolCalls.push({
          type: "mcp",
          name: `${item.server}/${item.tool}`,
          status: typeof item.status === "string" ? item.status : "unknown",
          ...(typeof item.durationMs === "number" || item.durationMs === null
            ? { durationMs: item.durationMs as number | null }
            : {}),
        });
      } else if (item.type === "dynamicToolCall" && typeof item.tool === "string") {
        toolCalls.push({
          type: "dynamic",
          name: item.tool,
          status: typeof item.status === "string" ? item.status : "unknown",
          ...(typeof item.durationMs === "number" || item.durationMs === null
            ? { durationMs: item.durationMs as number | null }
            : {}),
        });
      }
    }
  }

  return {
    ...(issue.issueKey ? { issueKey: issue.issueKey } : {}),
    stage: stageRun.stage,
    status: stageRun.status,
    ...(stageRun.threadId ? { threadId: stageRun.threadId } : {}),
    ...(stageRun.parentThreadId ? { parentThreadId: stageRun.parentThreadId } : {}),
    ...(stageRun.turnId ? { turnId: stageRun.turnId } : {}),
    prompt: stageRun.promptText,
    workflowFile: stageRun.workflowFile,
    assistantMessages,
    plans,
    reasoning,
    commands,
    fileChanges,
    toolCalls,
    eventCounts,
  };
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
    const receivedAt = new Date().toISOString();
    let payload: LinearWebhookPayload;
    try {
      payload = JSON.parse(params.rawBody.toString("utf8")) as LinearWebhookPayload;
    } catch {
      this.logger.warn({ webhookId: params.webhookId }, "Rejecting malformed webhook payload");
      return { status: 400, body: { ok: false, reason: "invalid_json" } };
    }

    let normalized: NormalizedEvent;
    try {
      normalized = normalizeWebhook({
        webhookId: params.webhookId,
        payload,
      });
    } catch (error) {
      this.logger.warn({ webhookId: params.webhookId, error }, "Rejecting unsupported webhook payload");
      return { status: 400, body: { ok: false, reason: "unsupported_payload" } };
    }

    const issueRef = normalized.issue.identifier ?? normalized.issue.id;
    const stateName = normalized.issue.stateName;
    const title = normalized.issue.title;
    const summary = [
      `Linear webhook for ${issueRef}`,
      normalized.triggerEvent,
      stateName ? `to ${stateName}` : undefined,
      title ? `(${title})` : undefined,
    ]
      .filter(Boolean)
      .join(" ");

    this.logger.info(
      {
        issueKey: normalized.issue.identifier,
        triggerEvent: normalized.triggerEvent,
        state: stateName,
        title,
      },
      summary,
    );
    this.logger.debug(
      {
        webhookId: params.webhookId,
        eventType: normalized.eventType,
        issueId: normalized.issue.id,
      },
      "Webhook metadata",
    );

    if (configHasArchiveDir(this.config)) {
      try {
        const archivePath = await archiveWebhook({
          archiveDir: this.config.logging.webhookArchiveDir,
          webhookId: params.webhookId,
          receivedAt,
          headers: params.headers,
          rawBody: params.rawBody,
          payload,
        });
        this.logger.debug({ webhookId: params.webhookId, archivePath }, "Archived webhook to local file");
      } catch (error) {
        this.logger.error({ webhookId: params.webhookId, error }, "Failed to archive webhook to local file");
      }
    }

    const signature = typeof params.headers["linear-signature"] === "string" ? params.headers["linear-signature"] : "";
    const validSignature = verifyHmacSha256Hex(params.rawBody, this.config.linear.webhookSecret, signature);
    if (!validSignature) {
      this.db.insertWebhookEvent({
        webhookId: params.webhookId,
        receivedAt,
        eventType: normalized.eventType,
        issueId: normalized.issue.id,
        headersJson: JSON.stringify(params.headers),
        payloadJson: JSON.stringify(payload),
        signatureValid: false,
        dedupeStatus: "rejected",
      });
      return { status: 401, body: { ok: false, reason: "invalid_signature" } };
    }

    if (!timestampMsWithinSkew(payload.webhookTimestamp, this.config.ingress.maxTimestampSkewSeconds)) {
      this.db.insertWebhookEvent({
        webhookId: params.webhookId,
        receivedAt,
        eventType: normalized.eventType,
        issueId: normalized.issue.id,
        headersJson: JSON.stringify(params.headers),
        payloadJson: JSON.stringify(payload),
        signatureValid: true,
        dedupeStatus: "rejected",
      });
      return { status: 401, body: { ok: false, reason: "stale_timestamp" } };
    }

    const stored = this.db.insertWebhookEvent({
      webhookId: params.webhookId,
      receivedAt,
      eventType: normalized.eventType,
      issueId: normalized.issue.id,
      headersJson: JSON.stringify(params.headers),
      payloadJson: JSON.stringify(payload),
      signatureValid: true,
      dedupeStatus: "accepted",
    });
    if (!stored.inserted) {
      return { status: 200, body: { ok: true, duplicate: true } };
    }

    this.webhookQueue.enqueue(stored.id);
    return { status: 200, body: { ok: true, accepted: true, webhookEventId: stored.id } };
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
      ? resolveStage(project, normalized.issue.stateName)
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
        reportJson: JSON.stringify({
          stage: claim.stageRun.stage,
          status: "failed",
          threadId: failureThreadId,
          prompt: claim.stageRun.promptText,
          workflowFile: claim.stageRun.workflowFile,
          assistantMessages: [],
          plans: [],
          reasoning: [],
          commands: [],
          fileChanges: [],
          toolCalls: [],
          eventCounts: {},
        }),
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
      return {
        id: stageRun.threadId!,
        preview: "",
        cwd: "",
        status: "pending-materialization",
        turns: [
          {
            id: stageRun.turnId ?? "pending-turn",
            status: "inProgress",
            error: {
              message: err.message,
            },
            items: [],
          },
        ],
      } as CodexThreadSummary;
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

    const latestStageRun = this.db.getStageRun(stageRun.id);
    if (!latestStageRun) {
      return;
    }

    const thread = await this.codex.readThread(threadId, true);
    const eventCounts = this.db.listThreadEvents(stageRun.id).reduce<Record<string, number>>((counts, event) => {
      counts[event.method] = (counts[event.method] ?? 0) + 1;
      return counts;
    }, {});
    const stageStatus = this.resolveStageStatus(notification.params);
    const issue = this.db.getTrackedIssue(stageRun.projectId, stageRun.linearIssueId);
    if (!issue) {
      return;
    }

    const refreshedStageRun = this.db.getStageRun(stageRun.id) ?? stageRun;
    const report = buildStageReport(
      {
        ...refreshedStageRun,
        status: stageStatus,
        threadId,
      },
      issue,
      thread,
      eventCounts,
    );

    const completedTurnId = extractTurnId(notification.params);
    this.db.finishStageRun({
      stageRunId: stageRun.id,
      status: stageStatus,
      threadId,
      ...(completedTurnId ? { turnId: completedTurnId } : {}),
      summaryJson: JSON.stringify(extractStageSummary(report)),
      reportJson: JSON.stringify(report),
    });

    const refreshedIssue = this.db.getTrackedIssue(stageRun.projectId, stageRun.linearIssueId);
    const pipeline = this.db.getPipelineRun(stageRun.pipelineRunId);
    if (stageStatus === "completed" && refreshedIssue?.desiredStage) {
      this.issueQueue.enqueue(makeIssueQueueKey(stageRun.projectId, stageRun.linearIssueId));
      return;
    }

    if (stageStatus === "completed" && pipeline && !refreshedIssue?.desiredStage) {
      this.db.markPipelineCompleted(pipeline.id);
    }
  }

  private async reconcileActiveStageRuns(): Promise<void> {
    const activeStageRuns = this.db.listActiveStageRuns();
    for (const stageRun of activeStageRuns) {
      if (!stageRun.threadId) {
        this.db.finishStageRun({
          stageRunId: stageRun.id,
          status: "failed",
          threadId: `missing-thread-${stageRun.id}`,
          summaryJson: JSON.stringify({ message: "Stage run had no persisted thread id during reconciliation" }),
          reportJson: JSON.stringify({
            stage: stageRun.stage,
            status: "failed",
            prompt: stageRun.promptText,
            workflowFile: stageRun.workflowFile,
            assistantMessages: [],
            plans: [],
            reasoning: [],
            commands: [],
            fileChanges: [],
            toolCalls: [],
            eventCounts: {},
          }),
        });
        continue;
      }

      const thread = await this.codex.readThread(stageRun.threadId, true).catch(() => undefined);
      if (!thread) {
        this.db.finishStageRun({
          stageRunId: stageRun.id,
          status: "failed",
          threadId: stageRun.threadId,
          ...(stageRun.turnId ? { turnId: stageRun.turnId } : {}),
          summaryJson: JSON.stringify({ message: "Thread was not found during startup reconciliation" }),
          reportJson: JSON.stringify({
            stage: stageRun.stage,
            status: "failed",
            threadId: stageRun.threadId,
            ...(stageRun.turnId ? { turnId: stageRun.turnId } : {}),
            prompt: stageRun.promptText,
            workflowFile: stageRun.workflowFile,
            assistantMessages: [],
            plans: [],
            reasoning: [],
            commands: [],
            fileChanges: [],
            toolCalls: [],
            eventCounts: {},
          }),
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

      const eventCounts = this.db.listThreadEvents(stageRun.id).reduce<Record<string, number>>((counts, event) => {
        counts[event.method] = (counts[event.method] ?? 0) + 1;
        return counts;
      }, {});
      const resolvedStatus = latestTurn.status === "completed" ? "completed" : "failed";
      const report = buildStageReport(
        {
          ...stageRun,
          status: resolvedStatus,
          threadId: stageRun.threadId,
          ...(latestTurn.id ? { turnId: latestTurn.id } : {}),
        },
        issue,
        thread,
        eventCounts,
      );

      this.db.finishStageRun({
        stageRunId: stageRun.id,
        status: resolvedStatus,
        threadId: stageRun.threadId,
        ...(latestTurn.id ? { turnId: latestTurn.id } : {}),
        summaryJson: JSON.stringify(extractStageSummary(report)),
        reportJson: JSON.stringify(report),
      });

      const refreshedIssue = this.db.getTrackedIssue(stageRun.projectId, stageRun.linearIssueId);
      const pipeline = this.db.getPipelineRun(stageRun.pipelineRunId);
      if (resolvedStatus === "completed" && refreshedIssue?.desiredStage) {
        this.issueQueue.enqueue(makeIssueQueueKey(stageRun.projectId, stageRun.linearIssueId));
      } else if (resolvedStatus === "completed" && pipeline && !refreshedIssue?.desiredStage) {
        this.db.markPipelineCompleted(pipeline.id);
      }
    }
  }

  private resolveStageStatus(params: Record<string, unknown>): StageRunRecord["status"] {
    const turn = params.turn;
    if (!turn || typeof turn !== "object") {
      return "failed";
    }

    const status = String((turn as Record<string, unknown>).status ?? "failed");
    return status === "completed" ? "completed" : "failed";
  }

  private async ensureWorktree(repoPath: string, worktreePath: string, branchName: string): Promise<void> {
    await ensureDir(path.dirname(worktreePath));
    await execCommand(this.config.runner.gitBin, ["-C", repoPath, "worktree", "add", "--force", "-B", branchName, worktreePath, "HEAD"], {
      timeoutMs: 120_000,
    });
  }
}

function configHasArchiveDir(config: AppConfig): config is AppConfig & { logging: { webhookArchiveDir: string } } {
  return typeof config.logging.webhookArchiveDir === "string" && config.logging.webhookArchiveDir.length > 0;
}

function extractTurnId(params: Record<string, unknown>): string | undefined {
  const turn = params.turn;
  if (!turn || typeof turn !== "object") {
    return undefined;
  }

  const id = (turn as Record<string, unknown>).id;
  return typeof id === "string" ? id : undefined;
}
