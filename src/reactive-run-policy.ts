import type { Logger } from "pino";
import type { IssueRecord, RunRecord } from "./db-types.ts";
import type { PatchRelayDatabase } from "./db.ts";
import type { RunType } from "./factory-state.ts";
import type { WithHeldIssueSessionLease } from "./issue-session-lease-service.ts";
import {
  buildReviewFixBranchUpkeepContext,
  isDirtyMergeStateStatus,
  isRequestedChangesRunType,
  readReactivePrSnapshot,
} from "./reactive-pr-state.ts";
import type { AppConfig } from "./types.ts";
import type { PostRunFollowUp } from "./run-completion-policy.ts";

export class ReactiveRunPolicy {
  constructor(
    private readonly config: AppConfig,
    private readonly db: PatchRelayDatabase,
    private readonly logger: Logger,
    private readonly withHeldLease: WithHeldIssueSessionLease,
  ) {}

  async verifyReactiveRunAdvancedBranch(run: RunRecord, issue: IssueRecord): Promise<string | undefined> {
    if (run.runType !== "ci_repair" && run.runType !== "queue_repair") {
      return undefined;
    }
    if (!issue.prNumber || issue.prState !== "open" || !issue.lastGitHubFailureHeadSha) {
      return undefined;
    }
    try {
      const snapshot = await readReactivePrSnapshot(this.config, run.projectId, issue.prNumber);
      if (!snapshot || snapshot.prState !== "open") return undefined;
      if (!snapshot.headSha || snapshot.headSha !== issue.lastGitHubFailureHeadSha) return undefined;
      // For queue repairs, the agent's no-op is legitimate when the incident has
      // already self-resolved: GitHub reports the PR as mergeable, so there is no
      // conflict left to push. Only flag as failed when the merge state is still
      // DIRTY after the run — then the agent really did miss the fix.
      if (run.runType === "queue_repair" && !isDirtyMergeStateStatus(snapshot.pr.mergeStateStatus)) {
        return undefined;
      }
      return `Repair finished but PR #${issue.prNumber} is still on failing head ${issue.lastGitHubFailureHeadSha.slice(0, 8)}`;
    } catch (error) {
      this.logger.debug({
        issueKey: issue.issueKey,
        prNumber: issue.prNumber,
        error: error instanceof Error ? error.message : String(error),
      }, "Failed to verify PR head advancement after repair");
      return undefined;
    }
  }

  async verifyReviewFixAdvancedHead(run: RunRecord, issue: IssueRecord): Promise<string | undefined> {
    if (!isRequestedChangesRunType(run.runType)) {
      return undefined;
    }
    if (!issue.prNumber || issue.prState !== "open") {
      return undefined;
    }
    if (!run.sourceHeadSha) {
      return `Requested-changes run finished for PR #${issue.prNumber} without a recorded starting head SHA. PatchRelay cannot verify that a new head was published.`;
    }
    try {
      const snapshot = await readReactivePrSnapshot(this.config, run.projectId, issue.prNumber);
      if (!snapshot || snapshot.prState !== "open") return undefined;
      if (!snapshot.headSha) {
        return `Requested-changes run finished for PR #${issue.prNumber} but GitHub did not report a current head SHA.`;
      }
      if (snapshot.headSha === run.sourceHeadSha) {
        return `Requested-changes run finished for PR #${issue.prNumber} without pushing a new head; PatchRelay must not hand the same SHA back to review.`;
      }
      return undefined;
    } catch (error) {
      this.logger.debug({
        issueKey: issue.issueKey,
        prNumber: issue.prNumber,
        error: error instanceof Error ? error.message : String(error),
      }, "Failed to verify PR head advancement after requested-changes work");
      return undefined;
    }
  }

  async refreshIssueAfterReactivePublish(run: RunRecord, issue: IssueRecord): Promise<IssueRecord> {
    if (run.runType !== "ci_repair" && run.runType !== "queue_repair" && !isRequestedChangesRunType(run.runType)) {
      return this.db.issues.getIssue(run.projectId, run.linearIssueId) ?? issue;
    }
    if (!issue.prNumber) {
      return this.db.issues.getIssue(run.projectId, run.linearIssueId) ?? issue;
    }

    try {
      const snapshot = await readReactivePrSnapshot(this.config, run.projectId, issue.prNumber);
      if (!snapshot) {
        return this.db.issues.getIssue(run.projectId, run.linearIssueId) ?? issue;
      }

      const headAdvanced = Boolean(snapshot.headSha && snapshot.headSha !== issue.lastGitHubFailureHeadSha);
      const reviewFixHeadAdvanced = isRequestedChangesRunType(run.runType)
        && Boolean(snapshot.headSha && run.sourceHeadSha && snapshot.headSha !== run.sourceHeadSha);

      this.upsertIssueIfLeaseHeld(
        run.projectId,
        run.linearIssueId,
        {
          projectId: run.projectId,
          linearIssueId: run.linearIssueId,
          ...(snapshot.prState ? { prState: snapshot.prState } : {}),
          ...(snapshot.headSha ? { prHeadSha: snapshot.headSha } : {}),
          ...(snapshot.reviewState ? { prReviewState: snapshot.reviewState } : {}),
          ...((headAdvanced || reviewFixHeadAdvanced)
            ? {
                prCheckStatus: "pending",
                lastGitHubFailureSource: null,
                lastGitHubFailureHeadSha: null,
                lastGitHubFailureSignature: null,
                lastGitHubFailureCheckName: null,
                lastGitHubFailureCheckUrl: null,
                lastGitHubFailureContextJson: null,
                lastGitHubFailureAt: null,
                lastQueueIncidentJson: null,
                lastAttemptedFailureHeadSha: null,
                lastAttemptedFailureSignature: null,
                lastAttemptedFailureAt: null,
                lastGitHubCiSnapshotHeadSha: snapshot.headSha ?? null,
                lastGitHubCiSnapshotGateCheckName: snapshot.gateCheckName,
                lastGitHubCiSnapshotGateCheckStatus: "pending",
                lastGitHubCiSnapshotJson: null,
                lastGitHubCiSnapshotSettledAt: null,
              }
            : {}),
        },
        "reactive publish refresh",
      );
    } catch (error) {
      this.logger.debug({
        issueKey: issue.issueKey,
        prNumber: issue.prNumber,
        error: error instanceof Error ? error.message : String(error),
      }, "Failed to refresh PR state after reactive publish");
    }

    return this.db.issues.getIssue(run.projectId, run.linearIssueId) ?? issue;
  }

  async resolveRequestedChangesWakeContext(
    issue: IssueRecord,
    runType: RunType,
    context: Record<string, unknown> | undefined,
  ): Promise<Record<string, unknown> | undefined> {
    if (runType === "branch_upkeep" || context?.branchUpkeepRequired === true) {
      return context;
    }
    if (!issue.prNumber || issue.prState !== "open" || issue.prReviewState !== "changes_requested") {
      return context;
    }

    try {
      const snapshot = await readReactivePrSnapshot(this.config, issue.projectId, issue.prNumber);
      if (!snapshot) return context;

      this.upsertIssueIfLeaseHeld(
        issue.projectId,
        issue.linearIssueId,
        {
          projectId: issue.projectId,
          linearIssueId: issue.linearIssueId,
          ...(snapshot.prState ? { prState: snapshot.prState } : {}),
          ...(snapshot.headSha ? { prHeadSha: snapshot.headSha } : {}),
          ...(snapshot.reviewState ? { prReviewState: snapshot.reviewState } : {}),
        },
        "review-fix wake refresh",
      );

      if (snapshot.prState !== "open") return context;
      if (snapshot.reviewState && snapshot.reviewState !== "changes_requested") return context;
      if (!isDirtyMergeStateStatus(snapshot.pr.mergeStateStatus)) return context;

      return buildReviewFixBranchUpkeepContext(
        issue.prNumber,
        snapshot.baseBranch,
        snapshot.pr,
        context,
      );
    } catch (error) {
      this.logger.debug({
        issueKey: issue.issueKey,
        prNumber: issue.prNumber,
        error: error instanceof Error ? error.message : String(error),
      }, "Failed to resolve requested-changes wake context");
      return context;
    }
  }

  async resolvePostRunFollowUp(
    run: Pick<RunRecord, "runType" | "projectId">,
    issue: IssueRecord,
  ): Promise<PostRunFollowUp | undefined> {
    if (run.runType !== "review_fix") {
      return undefined;
    }
    if (!issue.prNumber || issue.prState !== "open") {
      return undefined;
    }
    if (issue.prReviewState !== "changes_requested") {
      return undefined;
    }

    try {
      const snapshot = await readReactivePrSnapshot(this.config, run.projectId, issue.prNumber);
      if (!snapshot) return undefined;

      this.upsertIssueIfLeaseHeld(
        issue.projectId,
        issue.linearIssueId,
        {
          projectId: issue.projectId,
          linearIssueId: issue.linearIssueId,
          ...(snapshot.prState ? { prState: snapshot.prState } : {}),
          ...(snapshot.headSha ? { prHeadSha: snapshot.headSha } : {}),
          ...(snapshot.reviewState ? { prReviewState: snapshot.reviewState } : {}),
        },
        "post-run follow-up refresh",
      );

      if (snapshot.prState !== "open") return undefined;
      if (snapshot.reviewState && snapshot.reviewState !== "changes_requested") return undefined;
      if (!isDirtyMergeStateStatus(snapshot.pr.mergeStateStatus)) return undefined;

      return {
        pendingRunType: "branch_upkeep",
        factoryState: "changes_requested",
        context: buildReviewFixBranchUpkeepContext(
          issue.prNumber,
          snapshot.baseBranch,
          snapshot.pr,
        ),
        summary: `PR #${issue.prNumber} is still dirty after review fix; queued branch upkeep`,
      };
    } catch (error) {
      this.logger.debug({
        issueKey: issue.issueKey,
        prNumber: issue.prNumber,
        error: error instanceof Error ? error.message : String(error),
      }, "Failed to resolve post-run PR upkeep");
      return undefined;
    }
  }

  private upsertIssueIfLeaseHeld(
    projectId: string,
    linearIssueId: string,
    params: Parameters<PatchRelayDatabase["upsertIssue"]>[0],
    context: string,
  ): IssueRecord | undefined {
    const updated = this.withHeldLease(projectId, linearIssueId, (lease) =>
      this.db.issueSessions.upsertIssueWithLease(lease, params)
    );
    if (updated === undefined) {
      this.logger.warn({ projectId, linearIssueId, context }, "Skipping issue write after losing issue-session lease");
    }
    return updated;
  }
}
