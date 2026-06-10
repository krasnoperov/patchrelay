import type { Logger } from "pino";
import type { IssueRecord, RunRecord } from "./db-types.ts";
import type { PatchRelayDatabase } from "./db.ts";
import type { UpsertIssueParams } from "./db/issue-store.ts";
import { ACTIVE_RUN_STATES, type FactoryState, type RunType } from "./factory-state.ts";
import type { ReleaseIssueSessionLease, WithHeldIssueSessionLease } from "./issue-session-lease-service.ts";
import { buildRunFailureActivity } from "./linear-session-reporting.ts";
import type { LinearSessionSync } from "./linear-session-sync.ts";
import type { OperatorEventFeed } from "./operator-feed.ts";
import type { RunCompletionPolicy } from "./run-completion-policy.ts";
import { deriveIssueSessionReactiveIntent } from "./issue-session.ts";
import { isRequestedChangesRunType } from "./reactive-pr-state.ts";

const WRITER = "interrupted-run-recovery";

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

function resolvePostRunState(issue: IssueRecord): FactoryState | undefined {
  if (ACTIVE_RUN_STATES.has(issue.factoryState) && issue.prNumber) {
    if (issue.prState === "merged") return "done";
    if (issue.prReviewState === "approved") return "awaiting_queue";
    return "pr_open";
  }
  return undefined;
}

export function resolveRecoverablePostRunState(issue: IssueRecord): FactoryState | undefined {
  if (!issue.prNumber) {
    return resolvePostRunState(issue);
  }
  if (issue.prState === "merged") return "done";
  if (issue.prState === "open") {
    const reactiveIntent = deriveIssueSessionReactiveIntent({
      prNumber: issue.prNumber,
      prState: issue.prState,
      prReviewState: issue.prReviewState,
      prCheckStatus: issue.prCheckStatus,
      latestFailureSource: issue.lastGitHubFailureSource,
    });
    if (reactiveIntent) return reactiveIntent.compatibilityFactoryState;
    if (issue.prReviewState === "approved") return "awaiting_queue";
    return "pr_open";
  }
  return resolvePostRunState(issue);
}

export class InterruptedRunRecovery {
  constructor(
    private readonly db: PatchRelayDatabase,
    private readonly logger: Logger,
    private readonly linearSync: LinearSessionSync,
    private readonly withHeldLease: WithHeldIssueSessionLease,
    private readonly releaseLease: ReleaseIssueSessionLease,
    private readonly failRunAndClear: (run: RunRecord, message: string, nextState?: FactoryState) => void,
    private readonly restoreIdleWorktree: (issue: IssueRecord) => Promise<void>,
    private readonly completionPolicy: RunCompletionPolicy,
    private readonly enqueueIssue: (projectId: string, issueId: string) => void,
    private readonly feed?: OperatorEventFeed,
  ) {}

  async handle(run: RunRecord, issue: IssueRecord): Promise<void> {
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

    const recoveredState = resolveRecoverablePostRunState(this.db.issues.getIssue(run.projectId, run.linearIssueId) ?? issue);
    this.failRunAndClear(run, "Codex turn was interrupted", recoveredState);
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
    this.failRunAndClear(run, "Codex turn was interrupted", "delegated");
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
    this.enqueueIssue(run.projectId, run.linearIssueId);
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
    const recoveredState = resolveRecoverablePostRunState(refreshedIssue) ?? "failed";
    const interruptedMessage = "Requested-changes run was interrupted before PatchRelay could verify that a new PR head was published";
    this.failRunAndClear(run, interruptedMessage, recoveredState);
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
      this.enqueueIssue(run.projectId, run.linearIssueId);
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
