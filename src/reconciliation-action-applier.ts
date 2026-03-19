import type { CodexThreadSummary } from "./types.ts";
import type { ReconciliationDecision } from "./reconciliation-types.ts";
import type { ReconciliationSnapshot } from "./reconciliation-snapshot-builder.ts";
import type { IssueLifecycleStatus } from "./workflow-types.ts";

export interface ReconciliationActionCallbacks {
  enqueueIssue(projectId: string, issueId: string): void;
  deliverPendingObligations(projectId: string, linearIssueId: string, threadId: string, turnId?: string): Promise<void>;
  completeRun(
    projectId: string,
    linearIssueId: string,
    thread: CodexThreadSummary,
    params: { threadId: string; turnId?: string; nextLifecycleStatus?: IssueLifecycleStatus },
  ): void;
  failRunDuringReconciliation(
    projectId: string,
    linearIssueId: string,
    threadId: string,
    message: string,
    options?: { turnId?: string },
  ): Promise<void>;
  releaseRunDuringReconciliation(
    projectId: string,
    linearIssueId: string,
    params: {
      runId: number | string;
      threadId?: string;
      turnId?: string;
      nextLifecycleStatus?: IssueLifecycleStatus;
      currentLinearState?: string;
    },
  ): Promise<void>;
}

export class ReconciliationActionApplier {
  constructor(private readonly callbacks: ReconciliationActionCallbacks) {}

  async apply(params: {
    snapshot: ReconciliationSnapshot;
    decision: ReconciliationDecision;
  }): Promise<void> {
    const { snapshot, decision } = params;
    const threadId = snapshot.runLease.threadId;
    const turnId = snapshot.runLease.turnId;
    const obligationTargetAction = decision.actions.find((action) => action.type === "deliver_obligation" || action.type === "route_obligation");
    const targetThreadId =
      obligationTargetAction?.type === "deliver_obligation" || obligationTargetAction?.type === "route_obligation"
        ? obligationTargetAction.threadId
        : threadId;
    const targetTurnId =
      obligationTargetAction?.type === "deliver_obligation" || obligationTargetAction?.type === "route_obligation"
        ? obligationTargetAction.turnId
        : turnId;
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
      if (targetThreadId) {
        await this.callbacks.deliverPendingObligations(
          snapshot.runLease.projectId,
          snapshot.runLease.linearIssueId,
          targetThreadId,
          targetTurnId,
        );
      }
      return;
    }

    const completedAction = decision.actions.find((action) => action.type === "mark_run_completed");
    if (decision.outcome === "complete" || (decision.outcome === "release" && completedAction?.type === "mark_run_completed")) {
      const liveThread = snapshot.input.live?.codex?.status === "found" ? snapshot.input.live.codex.thread : undefined;
      if (!liveThread) {
        return;
      }
      const latestTurn = liveThread.turns.at(-1);
      this.callbacks.completeRun(snapshot.runLease.projectId, snapshot.runLease.linearIssueId, liveThread, {
        threadId: liveThread.id,
        ...(latestTurn?.id ? { turnId: latestTurn.id } : {}),
        ...(nextLifecycleStatus ? { nextLifecycleStatus } : {}),
      });
      return;
    }

    if (decision.outcome === "fail" || decision.outcome === "release") {
      const failedAction = decision.actions.find((action) => action.type === "mark_run_failed");
      if (decision.outcome === "release" && failedAction?.type !== "mark_run_failed") {
        const releasedAction = decision.actions.find((action) => action.type === "release_issue_ownership");
        if (releasedAction?.type !== "release_issue_ownership") {
          return;
        }
        await this.callbacks.releaseRunDuringReconciliation(snapshot.runLease.projectId, snapshot.runLease.linearIssueId, {
          runId: snapshot.runLease.id,
          ...(threadId ? { threadId } : {}),
          ...(turnId ? { turnId } : {}),
          ...(nextLifecycleStatus ? { nextLifecycleStatus } : {}),
          ...(snapshot.input.live?.linear?.status === "known" && snapshot.input.live.linear.issue?.stateName
            ? { currentLinearState: snapshot.input.live.linear.issue.stateName }
            : {}),
        });
        return;
      }
      await this.callbacks.failRunDuringReconciliation(
        snapshot.runLease.projectId,
        snapshot.runLease.linearIssueId,
        failedAction?.type === "mark_run_failed" && failedAction.threadId
          ? failedAction.threadId
          : threadId ?? `missing-thread-${snapshot.runLease.id}`,
        decision.reasons[0] ?? "Thread was not found during startup reconciliation",
        ...(failedAction?.type === "mark_run_failed" && failedAction.turnId ? [{ turnId: failedAction.turnId }] : []),
      );
    }
  }
}
