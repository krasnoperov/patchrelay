import type { Logger } from "pino";
import type { IssueRecord, RunRecord } from "./db-types.ts";
import type { PatchRelayDatabase } from "./db.ts";
import { ACTIVE_RUN_STATES, type FactoryState, type RunType } from "./factory-state.ts";
import type { WithHeldIssueSessionLease } from "./issue-session-lease-service.ts";
import { deriveIssueSessionReactiveIntent } from "./issue-session.ts";
import type { AppConfig } from "./types.ts";
import { execCommand } from "./utils.ts";
import {
  resolveImplementationDeliveryMode,
} from "./prompting/patchrelay.ts";

interface RemotePrState {
  headRefOid?: string;
  state?: string;
  reviewDecision?: string;
  mergeStateStatus?: string;
}

export interface PostRunFollowUp {
  pendingRunType: RunType;
  factoryState: FactoryState;
  context?: Record<string, unknown> | undefined;
  summary: string;
}

function isRequestedChangesRunType(runType: RunType): boolean {
  return runType === "review_fix" || runType === "branch_upkeep";
}

function resolvePostRunState(issue: IssueRecord): FactoryState | undefined {
  if (ACTIVE_RUN_STATES.has(issue.factoryState) && issue.prNumber) {
    if (issue.prState === "merged") return "done";
    if (issue.prReviewState === "approved") return "awaiting_queue";
    return "pr_open";
  }
  return undefined;
}

export function resolveCompletedRunState(
  issue: IssueRecord,
  run: Pick<RunRecord, "runType" | "promptText">,
): FactoryState | undefined {
  if (run.runType === "implementation" && resolveImplementationDeliveryMode(issue, undefined, run.promptText) === "linear_only") {
    return "done";
  }
  return resolvePostRunState(issue);
}

function normalizeRemotePrState(value: string | undefined): "open" | "closed" | "merged" | undefined {
  const normalized = value?.trim().toUpperCase();
  if (normalized === "OPEN") return "open";
  if (normalized === "CLOSED") return "closed";
  if (normalized === "MERGED") return "merged";
  return undefined;
}

function normalizeRemoteReviewDecision(value: string | undefined): "approved" | "changes_requested" | "commented" | undefined {
  const normalized = value?.trim().toUpperCase();
  if (normalized === "APPROVED") return "approved";
  if (normalized === "CHANGES_REQUESTED") return "changes_requested";
  if (normalized === "REVIEW_REQUIRED") return "commented";
  return undefined;
}

function isDirtyMergeStateStatus(value: string | undefined): boolean {
  return value?.trim().toUpperCase() === "DIRTY";
}

function buildReviewFixBranchUpkeepContext(
  prNumber: number,
  baseBranch: string,
  pr: RemotePrState,
  context?: Record<string, unknown>,
): Record<string, unknown> {
  const promptContext = [
    `The requested code change may already be present, but GitHub still reports PR #${prNumber} as ${String(pr.mergeStateStatus)} against latest ${baseBranch}.`,
    `This turn is branch upkeep on the existing PR branch: update onto latest ${baseBranch}, resolve any conflicts, rerun the narrowest relevant verification, and push a newer head.`,
    "Do not stop just because the requested code change is already present. Review can only move forward after a new pushed head.",
  ].join(" ");

  return {
    ...(context ?? {}),
    branchUpkeepRequired: true,
    reviewFixMode: "branch_upkeep",
    wakeReason: "branch_upkeep",
    promptContext,
    ...(pr.mergeStateStatus ? { mergeStateStatus: pr.mergeStateStatus } : {}),
    ...(pr.headRefOid ? { failingHeadSha: pr.headRefOid } : {}),
    baseBranch,
  };
}

export class RunCompletionPolicy {
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
    const project = this.config.projects.find((entry) => entry.id === run.projectId);
    if (!project?.github?.repoFullName) {
      return undefined;
    }
    try {
      const pr = await this.loadRemotePrState(project.github.repoFullName, issue.prNumber);
      if (!pr || pr.state?.toUpperCase() !== "OPEN") return undefined;
      if (!pr.headRefOid || pr.headRefOid !== issue.lastGitHubFailureHeadSha) return undefined;
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
    const project = this.config.projects.find((entry) => entry.id === run.projectId);
    if (!project?.github?.repoFullName) {
      return undefined;
    }
    try {
      const pr = await this.loadRemotePrState(project.github.repoFullName, issue.prNumber);
      if (!pr || pr.state?.toUpperCase() !== "OPEN") return undefined;
      if (!pr.headRefOid) {
        return `Requested-changes run finished for PR #${issue.prNumber} but GitHub did not report a current head SHA.`;
      }
      if (pr.headRefOid === run.sourceHeadSha) {
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
    const project = this.config.projects.find((entry) => entry.id === run.projectId);
    const repoFullName = project?.github?.repoFullName;
    if (!repoFullName) {
      return this.db.issues.getIssue(run.projectId, run.linearIssueId) ?? issue;
    }

    try {
      const pr = await this.loadRemotePrState(repoFullName, issue.prNumber);
      if (!pr) {
        return this.db.issues.getIssue(run.projectId, run.linearIssueId) ?? issue;
      }

      const nextPrState = normalizeRemotePrState(pr.state);
      const nextReviewState = normalizeRemoteReviewDecision(pr.reviewDecision);
      const gateCheckName = project?.gateChecks?.find((entry) => entry.trim())?.trim() ?? "verify";
      const headAdvanced = Boolean(pr.headRefOid && pr.headRefOid !== issue.lastGitHubFailureHeadSha);
      const reviewFixHeadAdvanced = isRequestedChangesRunType(run.runType)
        && Boolean(pr.headRefOid && run.sourceHeadSha && pr.headRefOid !== run.sourceHeadSha);

      this.upsertIssueIfLeaseHeld(
        run.projectId,
        run.linearIssueId,
        {
          projectId: run.projectId,
          linearIssueId: run.linearIssueId,
          ...(nextPrState ? { prState: nextPrState } : {}),
          ...(pr.headRefOid ? { prHeadSha: pr.headRefOid } : {}),
          ...(nextReviewState ? { prReviewState: nextReviewState } : {}),
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
                lastGitHubCiSnapshotHeadSha: pr.headRefOid ?? null,
                lastGitHubCiSnapshotGateCheckName: gateCheckName,
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

    const project = this.config.projects.find((entry) => entry.id === issue.projectId);
    const repoFullName = project?.github?.repoFullName;
    if (!repoFullName) {
      return context;
    }

    try {
      const pr = await this.loadRemotePrState(repoFullName, issue.prNumber);
      if (!pr) return context;

      const nextPrState = normalizeRemotePrState(pr.state);
      const nextReviewState = normalizeRemoteReviewDecision(pr.reviewDecision);
      this.upsertIssueIfLeaseHeld(
        issue.projectId,
        issue.linearIssueId,
        {
          projectId: issue.projectId,
          linearIssueId: issue.linearIssueId,
          ...(nextPrState ? { prState: nextPrState } : {}),
          ...(pr.headRefOid ? { prHeadSha: pr.headRefOid } : {}),
          ...(nextReviewState ? { prReviewState: nextReviewState } : {}),
        },
        "review-fix wake refresh",
      );

      if (nextPrState !== "open") return context;
      if (nextReviewState && nextReviewState !== "changes_requested") return context;
      if (!isDirtyMergeStateStatus(pr.mergeStateStatus)) return context;

      return buildReviewFixBranchUpkeepContext(
        issue.prNumber,
        project?.github?.baseBranch ?? "main",
        pr,
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

    const project = this.config.projects.find((entry) => entry.id === run.projectId);
    const repoFullName = project?.github?.repoFullName;
    if (!repoFullName) {
      return undefined;
    }

    try {
      const pr = await this.loadRemotePrState(repoFullName, issue.prNumber);
      if (!pr) return undefined;

      const nextPrState = normalizeRemotePrState(pr.state);
      const nextReviewState = normalizeRemoteReviewDecision(pr.reviewDecision);
      this.upsertIssueIfLeaseHeld(
        issue.projectId,
        issue.linearIssueId,
        {
          projectId: issue.projectId,
          linearIssueId: issue.linearIssueId,
          ...(nextPrState ? { prState: nextPrState } : {}),
          ...(pr.headRefOid ? { prHeadSha: pr.headRefOid } : {}),
          ...(nextReviewState ? { prReviewState: nextReviewState } : {}),
        },
        "post-run follow-up refresh",
      );

      if (nextPrState !== "open") return undefined;
      if (nextReviewState && nextReviewState !== "changes_requested") return undefined;
      if (!isDirtyMergeStateStatus(pr.mergeStateStatus)) return undefined;

      return {
        pendingRunType: "branch_upkeep",
        factoryState: "changes_requested",
        context: buildReviewFixBranchUpkeepContext(
          issue.prNumber,
          project?.github?.baseBranch ?? "main",
          pr,
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

  async verifyPublishedRunOutcome(run: RunRecord, issue: IssueRecord): Promise<string | undefined> {
    if (run.runType !== "implementation") {
      return undefined;
    }
    const project = this.config.projects.find((entry) => entry.id === run.projectId);
    const baseBranch = project?.github?.baseBranch ?? "main";
    const deliveryMode = resolveImplementationDeliveryMode(issue, undefined, run.promptText);
    if (deliveryMode === "linear_only") {
      if (issue.prNumber !== undefined) {
        return `Planning-only implementation should not open a PR, but PR #${issue.prNumber} was observed`;
      }
      return this.describeLocalImplementationOutcome(issue, baseBranch, deliveryMode);
    }
    if (issue.prNumber && issue.prState && issue.prState !== "closed") {
      return undefined;
    }

    if (project?.github?.repoFullName && issue.branchName) {
      try {
        const { stdout, exitCode } = await execCommand("gh", [
          "pr",
          "list",
          "--repo",
          project.github.repoFullName,
          "--head",
          issue.branchName,
          "--state",
          "all",
          "--json",
          "number,url,state,author,headRefOid",
        ], { timeoutMs: 10_000 });
        if (exitCode === 0) {
          const matches = JSON.parse(stdout) as Array<{
            number?: number;
            url?: string;
            state?: string;
            headRefOid?: string;
            author?: { login?: string };
          }>;
          const pr = matches[0];
          if (pr?.number) {
            this.upsertIssueIfLeaseHeld(
              issue.projectId,
              issue.linearIssueId,
              {
                projectId: issue.projectId,
                linearIssueId: issue.linearIssueId,
                prNumber: pr.number,
                ...(pr.url ? { prUrl: pr.url } : {}),
                ...(pr.state ? { prState: pr.state.toLowerCase() } : {}),
                ...(pr.headRefOid ? { prHeadSha: pr.headRefOid } : {}),
                ...(pr.author?.login ? { prAuthorLogin: pr.author.login } : {}),
              },
              "published PR verification refresh",
            );
            return undefined;
          }
        }
      } catch (error) {
        this.logger.debug({
          issueKey: issue.issueKey,
          branchName: issue.branchName,
          repoFullName: project.github.repoFullName,
          error: error instanceof Error ? error.message : String(error),
        }, "Failed to verify published PR state after implementation");
      }
    }

    const details = await this.describeLocalImplementationOutcome(issue, baseBranch, deliveryMode);
    return details ?? `Implementation completed without opening a PR for branch ${issue.branchName ?? issue.linearIssueId}`;
  }

  private async loadRemotePrState(repoFullName: string, prNumber: number): Promise<RemotePrState | undefined> {
    const { stdout, exitCode } = await execCommand("gh", [
      "pr", "view", String(prNumber),
      "--repo", repoFullName,
      "--json", "headRefOid,state,reviewDecision,mergeStateStatus",
    ], { timeoutMs: 10_000 });
    if (exitCode !== 0) return undefined;
    return JSON.parse(stdout) as RemotePrState;
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

  private async describeLocalImplementationOutcome(
    issue: IssueRecord,
    baseBranch: string,
    deliveryMode: "publish_pr" | "linear_only" = "publish_pr",
  ): Promise<string | undefined> {
    if (!issue.worktreePath) {
      return undefined;
    }

    try {
      const status = await execCommand(this.config.runner.gitBin, [
        "-C",
        issue.worktreePath,
        "status",
        "--short",
      ], { timeoutMs: 10_000 });
      const dirtyEntries = status.exitCode === 0
        ? status.stdout.split("\n").map((line) => line.trim()).filter(Boolean)
        : [];
      if (dirtyEntries.length > 0) {
        if (deliveryMode === "linear_only") {
          return `Planning-only implementation should not modify the repo; worktree still has ${dirtyEntries.length} uncommitted change(s)`;
        }
        return `Implementation completed without opening a PR; worktree still has ${dirtyEntries.length} uncommitted change(s)`;
      }
    } catch {
      // Best effort only.
    }

    try {
      const ahead = await execCommand(this.config.runner.gitBin, [
        "-C",
        issue.worktreePath,
        "rev-list",
        "--count",
        `origin/${baseBranch}..HEAD`,
      ], { timeoutMs: 10_000 });
      if (ahead.exitCode === 0) {
        const count = Number(ahead.stdout.trim());
        if (Number.isFinite(count) && count > 0) {
          if (deliveryMode === "linear_only") {
            return `Planning-only implementation should not create repo commits; worktree is ${count} local commit(s) ahead of origin/${baseBranch}`;
          }
          return `Implementation completed with ${count} local commit(s) ahead of origin/${baseBranch} but no PR was observed`;
        }
      }
    } catch {
      // Best effort only.
    }

    return undefined;
  }
}
