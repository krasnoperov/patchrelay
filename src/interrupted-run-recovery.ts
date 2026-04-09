import type { Logger } from "pino";
import type { IssueRecord, RunRecord } from "./db-types.ts";
import type { PatchRelayDatabase } from "./db.ts";
import { ACTIVE_RUN_STATES, type FactoryState, type RunType } from "./factory-state.ts";
import type { ReleaseIssueSessionLease, WithHeldIssueSessionLease } from "./issue-session-lease-service.ts";
import { buildRunFailureActivity } from "./linear-session-reporting.ts";
import type { LinearSessionSync } from "./linear-session-sync.ts";
import type { OperatorEventFeed } from "./operator-feed.ts";
import { deriveIssueSessionReactiveIntent } from "./issue-session.ts";

function isRequestedChangesRunType(runType: RunType): boolean {
  return runType === "review_fix" || runType === "branch_upkeep";
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
    private readonly refreshIssueAfterReactivePublish: (run: RunRecord, issue: IssueRecord) => Promise<IssueRecord>,
    private readonly resolveRequestedChangesWakeContext: (
      issue: IssueRecord,
      runType: RunType,
      context: Record<string, unknown> | undefined,
    ) => Promise<Record<string, unknown> | undefined>,
    private readonly enqueueIssue: (projectId: string, issueId: string) => void,
    private readonly feed?: OperatorEventFeed,
  ) {}

  async handle(run: RunRecord, issue: IssueRecord): Promise<void> {
    this.logger.warn(
      { issueKey: issue.issueKey, runType: run.runType, threadId: run.threadId },
      "Run has interrupted turn - marking as failed",
    );

    const repairedCounters = this.withHeldLease(issue.projectId, issue.linearIssueId, (lease) => {
      if (run.runType === "ci_repair" && issue.ciRepairAttempts > 0) {
        this.db.issueSessions.upsertIssueWithLease(lease, {
          projectId: issue.projectId,
          linearIssueId: issue.linearIssueId,
          ciRepairAttempts: issue.ciRepairAttempts - 1,
        });
      } else if (run.runType === "queue_repair" && issue.queueRepairAttempts > 0) {
        this.db.issueSessions.upsertIssueWithLease(lease, {
          projectId: issue.projectId,
          linearIssueId: issue.linearIssueId,
          queueRepairAttempts: issue.queueRepairAttempts - 1,
        });
      }
      if (run.runType === "ci_repair" || run.runType === "queue_repair") {
        this.db.issueSessions.upsertIssueWithLease(lease, {
          projectId: issue.projectId,
          linearIssueId: issue.linearIssueId,
          lastAttemptedFailureHeadSha: null,
          lastAttemptedFailureSignature: null,
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

  private async handleInterruptedRequestedChangesRun(run: RunRecord, issue: IssueRecord): Promise<void> {
    const freshIssue = this.db.issues.getIssue(run.projectId, run.linearIssueId) ?? issue;
    const refreshedIssue = await this.refreshIssueAfterReactivePublish(run, freshIssue);
    const retryContext = await this.resolveRequestedChangesWakeContext(
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
      this.db.issues.upsertIssue({
        projectId: run.projectId,
        linearIssueId: run.linearIssueId,
        pendingRunType: retryRunType,
        pendingRunContextJson: retryContext ? JSON.stringify(retryContext) : null,
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
