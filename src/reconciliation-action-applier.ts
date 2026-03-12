import type { CodexThreadSummary, StageRunRecord, TrackedIssueRecord } from "./types.ts";
import type { ReconciliationDecision } from "./reconciliation-types.ts";
import type { ReconciliationSnapshot } from "./reconciliation-snapshot-builder.ts";

export interface ReconciliationActionCallbacks {
  enqueueIssue(projectId: string, issueId: string): void;
  deliverPendingObligations(projectId: string, linearIssueId: string, threadId: string, turnId?: string): Promise<void>;
  completeStageRun(
    stageRun: StageRunRecord,
    issue: TrackedIssueRecord,
    thread: CodexThreadSummary,
    status: StageRunRecord["status"],
    params: { threadId: string; turnId?: string; nextLifecycleStatus?: TrackedIssueRecord["lifecycleStatus"] },
  ): void;
  failStageRunDuringReconciliation(
    stageRun: StageRunRecord,
    threadId: string,
    message: string,
    options?: { turnId?: string },
  ): Promise<void>;
}

export class ReconciliationActionApplier {
  constructor(private readonly callbacks: ReconciliationActionCallbacks) {}

  async apply(params: {
    snapshot: ReconciliationSnapshot;
    decision: ReconciliationDecision;
    stageRun: StageRunRecord;
    issue?: TrackedIssueRecord;
  }): Promise<void> {
    const { snapshot, decision, stageRun, issue } = params;
    const threadId = snapshot.runLease.threadId ?? stageRun.threadId;
    const turnId = snapshot.runLease.turnId ?? stageRun.turnId;
    const clearAction = decision.actions.find((action) => action.type === "clear_active_run" || action.type === "release_issue_ownership");
    const nextLifecycleStatus =
      clearAction?.type === "clear_active_run" || clearAction?.type === "release_issue_ownership"
        ? clearAction.nextLifecycleStatus
        : undefined;

    if (decision.outcome === "launch") {
      this.callbacks.enqueueIssue(snapshot.runLease.projectId, snapshot.runLease.linearIssueId);
      return;
    }

    if (decision.outcome === "continue") {
      if (threadId) {
        await this.callbacks.deliverPendingObligations(snapshot.runLease.projectId, snapshot.runLease.linearIssueId, threadId, turnId);
      }
      return;
    }

    if (decision.outcome === "complete") {
      const liveThread = snapshot.input.live?.codex?.status === "found" ? snapshot.input.live.codex.thread : undefined;
      if (!issue || !liveThread) {
        return;
      }
      const latestTurn = liveThread.turns.at(-1);
      this.callbacks.completeStageRun(stageRun, issue, liveThread, "completed", {
        threadId: liveThread.id,
        ...(latestTurn?.id ? { turnId: latestTurn.id } : {}),
        ...(nextLifecycleStatus ? { nextLifecycleStatus } : {}),
      });
      return;
    }

    if (decision.outcome === "fail" || decision.outcome === "release") {
      const failedAction = decision.actions.find((action) => action.type === "mark_run_failed");
      await this.callbacks.failStageRunDuringReconciliation(
        stageRun,
        failedAction?.type === "mark_run_failed" && failedAction.threadId ? failedAction.threadId : threadId ?? `missing-thread-${stageRun.id}`,
        decision.reasons[0] ?? "Thread was not found during startup reconciliation",
        ...(failedAction?.type === "mark_run_failed" && failedAction.turnId ? [{ turnId: failedAction.turnId }] : []),
      );
    }
  }
}
