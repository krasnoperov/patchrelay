import type { CodexNotification } from "./codex-app-server.ts";
import type { CodexAppServerClient } from "./codex-app-server.ts";
import type { PatchRelayDatabase } from "./db.ts";
import {
  buildAwaitingHandoffComment,
  resolveActiveLinearState,
  resolveWorkflowLabelCleanup,
  resolveWorkflowLabelNames,
} from "./linear-workflow.ts";
import { syncFailedStageToLinear } from "./stage-failure.ts";
import {
  buildFailedStageReport,
  buildPendingMaterializationThread,
  buildStageReport,
  countEventMethods,
  extractStageSummary,
  extractTurnId,
  resolveStageRunStatus,
  summarizeCurrentThread,
} from "./stage-reporting.ts";
import type { AppConfig, CodexThreadSummary, LinearClientProvider, StageRunRecord, TrackedIssueRecord } from "./types.ts";

export class ServiceStageFinalizer {
  constructor(
    private readonly config: AppConfig,
    private readonly db: PatchRelayDatabase,
    private readonly codex: CodexAppServerClient,
    private readonly linearProvider: LinearClientProvider,
    private readonly enqueueIssue: (projectId: string, issueId: string) => void,
  ) {}

  async getActiveStageStatus(issueKey: string) {
    const issue = this.db.getTrackedIssueByKey(issueKey);
    if (!issue?.activeStageRunId) {
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

  async handleCodexNotification(notification: CodexNotification): Promise<void> {
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

    if (notification.method === "turn/started" || notification.method.startsWith("item/")) {
      await this.flushQueuedTurnInputs(stageRun);
    }

    if (notification.method !== "turn/completed") {
      return;
    }

    const thread = await this.codex.readThread(threadId, true);
    const issue = this.db.getTrackedIssue(stageRun.projectId, stageRun.linearIssueId);
    if (!issue) {
      return;
    }

    const completedTurnId = extractTurnId(notification.params);
    this.completeStageRun(stageRun, issue, thread, resolveStageRunStatus(notification.params), {
      threadId,
      ...(completedTurnId ? { turnId: completedTurnId } : {}),
    });
  }

  async reconcileActiveStageRuns(): Promise<void> {
    const activeStageRuns = this.db.listActiveStageRuns();
    for (const stageRun of activeStageRuns) {
      if (!stageRun.threadId) {
        await this.failStageRunDuringReconciliation(
          stageRun,
          `missing-thread-${stageRun.id}`,
          "Stage run had no persisted thread id during reconciliation",
        );
        continue;
      }

      const thread = await this.codex.readThread(stageRun.threadId, true).catch(() => undefined);
      if (!thread) {
        await this.failStageRunDuringReconciliation(stageRun, stageRun.threadId, "Thread was not found during startup reconciliation", {
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

      if (latestTurn.status !== "completed") {
        await this.failStageRunDuringReconciliation(stageRun, stageRun.threadId, "Thread completed reconciliation in a failed state", {
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

    void this.advanceAfterStageCompletion(stageRun);
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

  private async failStageRunDuringReconciliation(
    stageRun: StageRunRecord,
    threadId: string,
    message: string,
    options?: {
      turnId?: string;
    },
  ): Promise<void> {
    this.failStageRun(stageRun, threadId, message, options);

    const issue = this.db.getTrackedIssue(stageRun.projectId, stageRun.linearIssueId);
    const project = this.config.projects.find((candidate) => candidate.id === stageRun.projectId);
    if (!issue || !project) {
      return;
    }

    await syncFailedStageToLinear({
      db: this.db,
      linearProvider: this.linearProvider,
      project,
      issue,
      stageRun: {
        ...stageRun,
        threadId,
        ...(options?.turnId ? { turnId: options.turnId } : {}),
      },
      message,
      mode: "failed",
      requireActiveLinearStateMatch: true,
    });
  }

  async flushQueuedTurnInputs(stageRun: StageRunRecord): Promise<void> {
    if (!stageRun.threadId || !stageRun.turnId) {
      return;
    }

    const pending = this.db.listPendingTurnInputs(stageRun.id);
    for (const input of pending) {
      try {
        await this.codex.steerTurn({
          threadId: stageRun.threadId,
          turnId: stageRun.turnId,
          input: input.body,
        });
        this.db.markTurnInputDelivered(input.id);
      } catch {
        break;
      }
    }
  }

  private async advanceAfterStageCompletion(stageRun: StageRunRecord): Promise<void> {
    const refreshedIssue = this.db.getTrackedIssue(stageRun.projectId, stageRun.linearIssueId);
    const pipeline = this.db.getPipelineRun(stageRun.pipelineRunId);
    if (refreshedIssue?.desiredStage) {
      this.enqueueIssue(stageRun.projectId, stageRun.linearIssueId);
      return;
    }

    const project = this.config.projects.find((candidate) => candidate.id === stageRun.projectId);
    const activeState = project ? resolveActiveLinearState(project, stageRun.stage) : undefined;
    const linear = project ? await this.linearProvider.forProject(stageRun.projectId) : undefined;
    if (refreshedIssue && pipeline && linear && project && activeState) {
      try {
        const linearIssue = await linear.getIssue(stageRun.linearIssueId);
        if (linearIssue.stateName?.trim().toLowerCase() === activeState.trim().toLowerCase()) {
          const labels = resolveWorkflowLabelNames(project, "awaitingHandoff");
          if (labels.add.length > 0 || labels.remove.length > 0) {
            await linear.updateIssueLabels({
              issueId: stageRun.linearIssueId,
              ...(labels.add.length > 0 ? { addNames: labels.add } : {}),
              ...(labels.remove.length > 0 ? { removeNames: labels.remove } : {}),
            });
          }
          this.db.setIssueLifecycleStatus(stageRun.projectId, stageRun.linearIssueId, "paused");
          this.db.setPipelineStatus(pipeline.id, "paused");

          const finalStageRun = this.db.getStageRun(stageRun.id) ?? stageRun;
          const result = await linear.upsertIssueComment({
            issueId: stageRun.linearIssueId,
            ...(refreshedIssue.statusCommentId ? { commentId: refreshedIssue.statusCommentId } : {}),
            body: buildAwaitingHandoffComment({
              issue: refreshedIssue,
              stageRun: finalStageRun,
              activeState,
            }),
          });
          this.db.setIssueStatusComment(stageRun.projectId, stageRun.linearIssueId, result.id);
          return;
        }

        const cleanup = resolveWorkflowLabelCleanup(project);
        if (cleanup.remove.length > 0) {
          await linear.updateIssueLabels({
            issueId: stageRun.linearIssueId,
            removeNames: cleanup.remove,
          });
        }
      } catch {
        // Preserve the completed stage locally even if Linear read-back failed.
      }
    }

    if (pipeline) {
      this.db.markPipelineCompleted(pipeline.id);
    }
  }
}
