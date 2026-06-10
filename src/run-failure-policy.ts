import type { Logger } from "pino";
import type { IssueRecord, RunRecord } from "./db-types.ts";
import type { PatchRelayDatabase } from "./db.ts";
import type { UpsertIssueParams } from "./db/issue-store.ts";
import type { FactoryState, RunType } from "./factory-state.ts";
import type { ReleaseIssueSessionLease, WithHeldIssueSessionLease } from "./issue-session-lease-service.ts";
import { buildRunFailureActivity } from "./linear-session-reporting.ts";
import type { LinearSessionSync } from "./linear-session-sync.ts";
import type { OperatorEventFeed } from "./operator-feed.ts";
import type { AppendWakeEventWithLease } from "./run-wake-planner.ts";
import type { WakeDispatcher } from "./wake-dispatcher.ts";
import { getRemainingZombieRecoveryDelayMs, getZombieRecoveryBudget } from "./run-budgets.ts";
import { resolvePostRunFactoryState } from "./run-completion-policy.ts";
import type { RunCompletionPolicy } from "./run-completion-policy.ts";
import { isRequestedChangesRunType } from "./reactive-pr-state.ts";
import { settleRun } from "./run-settlement.ts";
import type { ProjectConfig } from "./workflow-types.ts";

const WRITER = "run-failure-policy";

// Roll back the attempt counter consumed by the interrupted run and clear the
// attempted-failure provenance for repair runs, as a single issue update so
// the whole repair commits (and conflict-recomputes) atomically.
function buildInterruptedAttemptRepairUpdate(
  runType: RunType,
  issue: Pick<IssueRecord, "projectId" | "linearIssueId" | "ciRepairAttempts" | "queueRepairAttempts" | "reviewFixAttempts">,
): UpsertIssueParams | undefined {
  const counter = runType === "ci_repair" && issue.ciRepairAttempts > 0
    ? { ciRepairAttempts: issue.ciRepairAttempts - 1 }
    : runType === "queue_repair" && issue.queueRepairAttempts > 0
      ? { queueRepairAttempts: issue.queueRepairAttempts - 1 }
      : isRequestedChangesRunType(runType) && issue.reviewFixAttempts > 0
        ? { reviewFixAttempts: issue.reviewFixAttempts - 1 }
        : undefined;
  const provenance = runType === "ci_repair" || runType === "queue_repair"
    ? {
        lastAttemptedFailureHeadSha: null,
        lastAttemptedFailureSignature: null,
        lastAttemptedFailureAt: null,
      }
    : undefined;
  if (!counter && !provenance) return undefined;
  return {
    projectId: issue.projectId,
    linearIssueId: issue.linearIssueId,
    ...counter,
    ...provenance,
  };
}

function resolveRetryRunType(runType: RunType, context: Record<string, unknown> | undefined): "review_fix" | "branch_upkeep" {
  if (runType === "branch_upkeep") {
    return "branch_upkeep";
  }
  return context?.reviewFixMode === "branch_upkeep" || context?.branchUpkeepRequired === true
    ? "branch_upkeep"
    : "review_fix";
}

// Plan §B4: the one run-failure policy. Merges the former
// RunRecoveryService (zombie retry/escalate + backoff) and
// InterruptedRunRecovery (interrupted-turn handling, counter decrements,
// re-enqueue) into a single module that answers: given a stranded or
// failed run + its issue — retry (with which backoff/budget), re-enqueue
// (which runType/context), or escalate?
//
// Ownership: run-reconciler and service-startup-recovery only DETECT
// stranded states and hand them here; this policy DECIDES; execution of
// the run/slot writes goes through settleRun, and dispatch of follow-up
// work goes through the WakeDispatcher.
export class RunFailurePolicy {
  constructor(
    private readonly db: PatchRelayDatabase,
    private readonly logger: Logger,
    private readonly linearSync: LinearSessionSync,
    private readonly withHeldLease: WithHeldIssueSessionLease,
    private readonly releaseLease: ReleaseIssueSessionLease,
    private readonly appendWakeEventWithLease: AppendWakeEventWithLease,
    private readonly wakeDispatcher: WakeDispatcher,
    private readonly restoreIdleWorktree: (issue: Pick<IssueRecord, "issueKey" | "worktreePath" | "branchName">) => Promise<void>,
    private readonly completionPolicy: RunCompletionPolicy,
    private readonly resolveProject: (projectId: string) => ProjectConfig | undefined,
    private readonly feed?: OperatorEventFeed,
  ) {}

  // ─── Stranded runs (zombie / stale thread) ───────────────────────

  /**
   * Detector entry point: the reconciler found a run that can never make
   * progress (no Codex thread after a restart, or the thread is gone).
   * Settle the run (mark failed, release the slot) and decide retry vs
   * escalate via the zombie budget/backoff.
   */
  settleStrandedRunAndRecover(params: {
    run: RunRecord;
    issue: IssueRecord;
    reason: string;
    failureReason: string;
  }): void {
    const { run, issue } = params;
    this.withHeldLease(run.projectId, run.linearIssueId, (lease) =>
      settleRun({
        db: this.db,
        run,
        finish: { status: "failed", failureReason: params.failureReason },
        lease,
      }));
    this.recoverOrEscalate({ issue, runType: run.runType, reason: params.reason });
  }

  /**
   * Decide what happens after a run died without doing its work: PR
   * already merged → done; zombie budget exhausted → escalate; backoff
   * not elapsed → keep the wake but defer; otherwise consume one budget
   * unit, append a recovery wake, and dispatch.
   */
  recoverOrEscalate(params: {
    issue: IssueRecord;
    runType: RunType;
    reason: string;
  }): void {
    const { issue, runType, reason } = params;
    const fresh = this.db.issues.getIssue(issue.projectId, issue.linearIssueId);
    if (!fresh) return;

    if (isRequestedChangesRunType(runType)) {
      const updated = this.withHeldLease(fresh.projectId, fresh.linearIssueId, (lease) => {
        this.db.issueSessions.clearPendingIssueSessionEventsWithLease(lease);
        this.db.issueSessions.commitIssueState({
          writer: WRITER,
          lease,
          update: {
            projectId: fresh.projectId,
            linearIssueId: fresh.linearIssueId,
            pendingRunType: null,
            pendingRunContextJson: null,
            factoryState: "escalated",
          },
        });
        return true;
      });
      if (!updated) {
        this.logger.warn({ issueKey: fresh.issueKey, reason }, "Skipping review-fix recovery escalation after losing issue-session lease");
        this.releaseLease(fresh.projectId, fresh.linearIssueId);
        return;
      }
      this.logger.warn({ issueKey: fresh.issueKey, reason }, "Requested-changes run failed before a new head was published - escalating");
      this.feed?.publish({
        level: "error",
        kind: "workflow",
        issueKey: fresh.issueKey,
        projectId: fresh.projectId,
        stage: runType,
        status: "escalated",
        summary: `Requested-changes run failed before publishing a new head (${reason})`,
      });
      this.releaseLease(fresh.projectId, fresh.linearIssueId);
      return;
    }

    if (fresh.prState === "merged") {
      const updated = this.withHeldLease(fresh.projectId, fresh.linearIssueId, (lease) => {
        this.db.issueSessions.commitIssueState({
          writer: WRITER,
          lease,
          update: {
            projectId: fresh.projectId,
            linearIssueId: fresh.linearIssueId,
            factoryState: "done",
            zombieRecoveryAttempts: 0,
            lastZombieRecoveryAt: null,
          },
        });
        return true;
      });
      if (!updated) {
        this.logger.warn({ issueKey: fresh.issueKey, reason }, "Skipping merged recovery completion after losing issue-session lease");
        this.releaseLease(fresh.projectId, fresh.linearIssueId);
        return;
      }
      this.logger.info({ issueKey: fresh.issueKey, reason }, "Recovery: PR already merged - transitioning to done");
      this.releaseLease(fresh.projectId, fresh.linearIssueId);
      return;
    }

    const zombieRecoveryBudget = getZombieRecoveryBudget(this.resolveProject(fresh.projectId));
    const attempts = fresh.zombieRecoveryAttempts + 1;
    if (attempts > zombieRecoveryBudget) {
      const updated = this.withHeldLease(fresh.projectId, fresh.linearIssueId, (lease) => {
        this.db.issueSessions.commitIssueState({
          writer: WRITER,
          lease,
          update: {
            projectId: fresh.projectId,
            linearIssueId: fresh.linearIssueId,
            factoryState: "escalated",
          },
        });
        return true;
      });
      if (!updated) {
        this.logger.warn({ issueKey: fresh.issueKey, attempts, reason }, "Skipping recovery escalation after losing issue-session lease");
        this.releaseLease(fresh.projectId, fresh.linearIssueId);
        return;
      }
      this.logger.warn({ issueKey: fresh.issueKey, attempts, reason }, "Recovery: budget exhausted - escalating");
      this.feed?.publish({
        level: "error",
        kind: "workflow",
        issueKey: fresh.issueKey,
        projectId: fresh.projectId,
        stage: "escalated",
        status: "budget_exhausted",
        summary: `${reason} recovery failed after ${zombieRecoveryBudget} attempts`,
      });
      this.releaseLease(fresh.projectId, fresh.linearIssueId);
      return;
    }

    if (fresh.lastZombieRecoveryAt) {
      const remainingDelayMs = getRemainingZombieRecoveryDelayMs(
        fresh.lastZombieRecoveryAt,
        fresh.zombieRecoveryAttempts,
      );
      if (remainingDelayMs > 0) {
        this.withHeldLease(fresh.projectId, fresh.linearIssueId, (lease) => {
          this.appendWakeEventWithLease(lease, fresh, runType, undefined, `recovery:${attempts}`);
        });
        this.logger.debug(
          { issueKey: fresh.issueKey, attempts: fresh.zombieRecoveryAttempts, remainingDelayMs },
          "Recovery: backoff not elapsed, deferring retry",
        );
        return;
      }
    }

    const requeued = this.withHeldLease(fresh.projectId, fresh.linearIssueId, (lease) => {
      // `attempts` is read-modify-write against the fresh row read above; on
      // conflict recompute the counter from the current row.
      const buildRequeueUpdate = (record: Pick<IssueRecord, "zombieRecoveryAttempts">) => ({
        projectId: fresh.projectId,
        linearIssueId: fresh.linearIssueId,
        pendingRunType: null,
        pendingRunContextJson: null,
        zombieRecoveryAttempts: record.zombieRecoveryAttempts + 1,
        lastZombieRecoveryAt: new Date().toISOString(),
      });
      this.db.issueSessions.commitIssueState({
        writer: WRITER,
        lease,
        expectedVersion: fresh.version,
        update: buildRequeueUpdate(fresh),
        onConflict: (current) => buildRequeueUpdate(current),
      });
      return this.appendWakeEventWithLease(lease, fresh, runType, undefined, `recovery:${attempts}`);
    });
    if (!requeued) {
      this.logger.warn({ issueKey: fresh.issueKey, attempts, reason }, "Skipping recovery re-enqueue after losing issue-session lease");
      this.releaseLease(fresh.projectId, fresh.linearIssueId);
      return;
    }
    this.wakeDispatcher.dispatchIfWakePending(fresh.projectId, fresh.linearIssueId);
    this.logger.info({ issueKey: fresh.issueKey, attempts, reason }, "Recovery: re-enqueued with backoff");
  }

  // ─── Terminal decisions ──────────────────────────────────────────

  escalate(params: {
    issue: IssueRecord;
    runType: string;
    reason: string;
  }): void {
    const { issue, runType, reason } = params;
    this.logger.warn({ issueKey: issue.issueKey, runType, reason }, "Escalating to human");
    const escalated = this.withHeldLease(issue.projectId, issue.linearIssueId, (lease) => {
      // Escalation is an operator-facing decision: the issue write and the
      // run release ride in the held-lease transaction. When a run still
      // holds the slot, settleRun owns the paired run-release + slot-clear;
      // it refuses to clear a slot that was re-pointed at another run.
      const escalateFields = {
        pendingRunType: null,
        pendingRunContextJson: null,
        factoryState: "escalated" as const,
      };
      if (issue.activeRunId !== undefined) {
        const settled = settleRun({
          db: this.db,
          run: { id: issue.activeRunId, projectId: issue.projectId, linearIssueId: issue.linearIssueId },
          finish: { status: "released" },
          lease,
          buildIssueUpdate: () => escalateFields,
        });
        if (!settled.slotCleared) return false;
      } else {
        const commit = this.db.issueSessions.commitIssueState({
          writer: WRITER,
          lease,
          update: {
            projectId: issue.projectId,
            linearIssueId: issue.linearIssueId,
            ...escalateFields,
          },
        });
        if (commit.outcome !== "applied") return false;
      }
      this.db.issueSessions.clearPendingIssueSessionEventsWithLease(lease);
      return true;
    });
    if (!escalated) {
      this.logger.warn({ issueKey: issue.issueKey, runType }, "Skipping escalation write after losing issue-session lease");
      this.releaseLease(issue.projectId, issue.linearIssueId);
      return;
    }
    this.feed?.publish({
      level: "error",
      kind: "workflow",
      issueKey: issue.issueKey,
      projectId: issue.projectId,
      stage: runType,
      status: "escalated",
      summary: `Escalated: ${reason}`,
    });
    const escalatedIssue = this.db.issues.getIssue(issue.projectId, issue.linearIssueId) ?? issue;
    void this.linearSync.emitActivity(escalatedIssue, {
      type: "error",
      body: `PatchRelay needs human help to continue.\n\n${reason}`,
    });
    void this.linearSync.syncSession(escalatedIssue);
    this.releaseLease(issue.projectId, issue.linearIssueId);
  }

  failRunAndClear(params: {
    run: RunRecord;
    message: string;
    nextState: FactoryState;
  }): void {
    const { run, message, nextState } = params;
    const updated = this.withHeldLease(run.projectId, run.linearIssueId, (lease) => {
      settleRun({
        db: this.db,
        run,
        finish: { status: "failed", failureReason: message },
        lease,
        buildIssueUpdate: () => ({ factoryState: nextState }),
      });
      if (nextState === "failed" || nextState === "escalated" || nextState === "awaiting_input" || nextState === "done") {
        this.db.issueSessions.clearPendingIssueSessionEventsWithLease(lease);
      }
      return true;
    });
    if (!updated) {
      this.logger.warn({ runId: run.id, issueId: run.linearIssueId }, "Skipping failure cleanup after losing issue-session lease");
    }
    this.releaseLease(run.projectId, run.linearIssueId);
  }

  // ─── Interrupted turns (formerly InterruptedRunRecovery) ─────────

  async handleInterruptedRun(run: RunRecord, issue: IssueRecord): Promise<void> {
    this.logger.warn(
      { issueKey: issue.issueKey, runType: run.runType, threadId: run.threadId },
      "Run has interrupted turn - marking as failed",
    );

    const repairedCounters = this.withHeldLease(issue.projectId, issue.linearIssueId, (lease) => {
      // The decrement is read-modify-write against an issue row read before
      // the awaits that led here; on conflict, recompute from the fresh row.
      const update = buildInterruptedAttemptRepairUpdate(run.runType, issue);
      if (update) {
        this.db.issueSessions.commitIssueState({
          writer: WRITER,
          lease,
          expectedVersion: issue.version,
          update,
          onConflict: (current) => buildInterruptedAttemptRepairUpdate(run.runType, current),
        });
      }
      return true;
    });
    if (!repairedCounters) {
      this.logger.warn({ runId: run.id, issueId: run.linearIssueId }, "Skipping interrupted-run recovery after losing issue-session lease");
      this.releaseLease(run.projectId, run.linearIssueId);
      return;
    }

    if (isRequestedChangesRunType(run.runType)) {
      await this.handleInterruptedRequestedChangesRun(run, issue);
      return;
    }

    if (run.runType === "implementation" && !issue.prNumber) {
      await this.handleInterruptedImplementationRun(run, issue);
      return;
    }

    const recoveredState = resolvePostRunFactoryState(
      this.db.issues.getIssue(run.projectId, run.linearIssueId) ?? issue,
      run,
      { outcome: "recovered" },
    );
    this.failRunAndClear({ run, message: "Codex turn was interrupted", nextState: recoveredState ?? "failed" });
    await this.restoreIdleWorktree(issue);
    const failedIssue = this.db.issues.getIssue(run.projectId, run.linearIssueId) ?? issue;
    if (recoveredState) {
      this.feed?.publish({
        level: "info",
        kind: "stage",
        issueKey: issue.issueKey,
        projectId: run.projectId,
        stage: recoveredState,
        status: "reconciled",
        summary: `Interrupted ${run.runType} recovered -> ${recoveredState}`,
      });
    } else {
      void this.linearSync.emitActivity(failedIssue, buildRunFailureActivity(run.runType, "The Codex turn was interrupted."));
    }
    void this.linearSync.syncSession(failedIssue, { activeRunType: run.runType });
    this.releaseLease(run.projectId, run.linearIssueId);
  }

  private async handleInterruptedImplementationRun(run: RunRecord, issue: IssueRecord): Promise<void> {
    const interruptedMessage = "Implementation run was interrupted before PatchRelay could publish a PR";
    this.failRunAndClear({ run, message: "Codex turn was interrupted", nextState: "delegated" });
    await this.restoreIdleWorktree(issue);

    const refreshedIssue = this.db.issues.getIssue(run.projectId, run.linearIssueId) ?? issue;
    this.db.issueSessions.appendIssueSessionEventRespectingActiveLease(run.projectId, run.linearIssueId, {
      projectId: run.projectId,
      linearIssueId: run.linearIssueId,
      eventType: "delegated",
      dedupeKey: `interrupted_implementation:implementation:${run.linearIssueId}`,
    });

    if (!this.db.workflowWakes.peekIssueWake(run.projectId, run.linearIssueId)) {
      const failedIssue = this.db.issues.getIssue(run.projectId, run.linearIssueId) ?? refreshedIssue;
      this.feed?.publish({
        level: "error",
        kind: "workflow",
        issueKey: issue.issueKey,
        projectId: run.projectId,
        stage: run.runType,
        status: "escalated",
        summary: interruptedMessage,
      });
      void this.linearSync.emitActivity(failedIssue, buildRunFailureActivity(run.runType, interruptedMessage));
      void this.linearSync.syncSession(failedIssue, { activeRunType: run.runType });
      this.releaseLease(run.projectId, run.linearIssueId);
      return;
    }

    this.feed?.publish({
      level: "warn",
      kind: "workflow",
      issueKey: issue.issueKey,
      projectId: run.projectId,
      stage: run.runType,
      status: "retry_queued",
      summary: "Implementation run was interrupted; PatchRelay will retry automatically",
    });
    const recoveredIssue = this.db.issues.getIssue(run.projectId, run.linearIssueId) ?? refreshedIssue;
    void this.linearSync.syncSession(recoveredIssue, { activeRunType: run.runType });
    this.wakeDispatcher.dispatchIfWakePending(run.projectId, run.linearIssueId);
    this.releaseLease(run.projectId, run.linearIssueId);
  }

  private async handleInterruptedRequestedChangesRun(run: RunRecord, issue: IssueRecord): Promise<void> {
    const freshIssue = this.db.issues.getIssue(run.projectId, run.linearIssueId) ?? issue;
    const refreshedIssue = await this.completionPolicy.refreshIssueAfterReactivePublish(run, freshIssue);
    const retryContext = await this.completionPolicy.resolveRequestedChangesWakeContext(
      refreshedIssue,
      run.runType,
      run.runType === "branch_upkeep"
        ? {
            branchUpkeepRequired: true,
            reviewFixMode: "branch_upkeep",
            wakeReason: "branch_upkeep",
          }
        : undefined,
    );
    const retryRunType = resolveRetryRunType(run.runType, retryContext);
    const recoveredState = resolvePostRunFactoryState(refreshedIssue, run, { outcome: "recovered" }) ?? "failed";
    const interruptedMessage = "Requested-changes run was interrupted before PatchRelay could verify that a new PR head was published";
    this.failRunAndClear({ run, message: interruptedMessage, nextState: recoveredState });
    await this.restoreIdleWorktree(issue);
    const recoveredIssue = this.db.issues.getIssue(run.projectId, run.linearIssueId) ?? refreshedIssue;

    if (recoveredState === "changes_requested") {
      this.db.issueSessions.commitIssueState({
        writer: WRITER,
        update: {
          projectId: run.projectId,
          linearIssueId: run.linearIssueId,
          pendingRunType: retryRunType,
          pendingRunContextJson: retryContext ? JSON.stringify(retryContext) : null,
        },
      });
      this.feed?.publish({
        level: "warn",
        kind: "workflow",
        issueKey: issue.issueKey,
        projectId: run.projectId,
        stage: run.runType,
        status: "retry_queued",
        summary: "Requested-changes run was interrupted; PatchRelay will retry from fresh GitHub truth",
      });
      this.wakeDispatcher.dispatchIfWakePending(run.projectId, run.linearIssueId);
    } else {
      this.feed?.publish({
        level: "error",
        kind: "workflow",
        issueKey: issue.issueKey,
        projectId: run.projectId,
        stage: run.runType,
        status: "escalated",
        summary: interruptedMessage,
      });
    }

    void this.linearSync.emitActivity(recoveredIssue, buildRunFailureActivity(run.runType, interruptedMessage));
    void this.linearSync.syncSession(recoveredIssue, { activeRunType: run.runType });
    this.releaseLease(run.projectId, run.linearIssueId);
  }
}
