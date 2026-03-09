import type { CodexNotification } from "./codex-app-server.js";
import type { CodexAppServerClient } from "./codex-app-server.js";
import type { PatchRelayDatabase } from "./db.js";
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
import type { CodexThreadSummary, StageRunRecord, TrackedIssueRecord } from "./types.js";

export class ServiceStageFinalizer {
  constructor(
    private readonly db: PatchRelayDatabase,
    private readonly codex: CodexAppServerClient,
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

      if (latestTurn.status !== "completed") {
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
      this.enqueueIssue(stageRun.projectId, stageRun.linearIssueId);
      return;
    }

    if (pipeline) {
      this.db.markPipelineCompleted(pipeline.id);
    }
  }
}
