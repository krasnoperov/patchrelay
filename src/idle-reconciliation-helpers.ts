import type { IssueRecord } from "./db-types.ts";
import { parseGitHubFailureContext } from "./github-failure-context.ts";
import type { GitHubStatusRollupEntry } from "./github-rollup.ts";
import { parseStoredQueueRepairContext } from "./merge-queue-incident.ts";
import type { RunContext } from "./run-context.ts";
import type { AppConfig } from "./types.ts";

export function isFailingCheckStatus(status: string | undefined): boolean {
  return status === "failed" || status === "failure";
}

export function isReviewDecisionApproved(value: string | undefined): boolean {
  return value?.trim().toUpperCase() === "APPROVED";
}

export function isReviewDecisionChangesRequested(value: string | undefined): boolean {
  return value?.trim().toUpperCase() === "CHANGES_REQUESTED";
}

export function isReviewDecisionReviewRequired(value: string | undefined): boolean {
  return value?.trim().toUpperCase() === "REVIEW_REQUIRED";
}

export function buildBranchUpkeepContext(
  prNumber: number,
  baseBranch: string,
  mergeStateStatus?: string,
  headSha?: string,
): RunContext {
  const promptContext = [
    `The requested code change may already be present, but GitHub still reports PR #${prNumber} as ${mergeStateStatus ?? "DIRTY"} against latest ${baseBranch}.`,
    `This turn is branch upkeep on the existing PR branch: update onto latest ${baseBranch}, resolve any conflicts, rerun the narrowest relevant verification, and push a newer head.`,
    "Do not stop just because the requested code change is already present. Review can only move forward after a new pushed head.",
  ].join(" ");
  return {
    branchUpkeepRequired: true,
    reviewFixMode: "branch_upkeep",
    wakeReason: "branch_upkeep",
    promptContext,
    ...(mergeStateStatus ? { mergeStateStatus } : {}),
    ...(headSha ? { failingHeadSha: headSha } : {}),
    baseBranch,
  };
}

export function hasCompletedReviewQuillVerdict(entries: GitHubStatusRollupEntry[] | undefined): boolean {
  return (entries ?? []).some((entry) => entry.__typename === "CheckRun"
    && entry.name === "review-quill/verdict"
    && entry.status === "COMPLETED");
}

export function getGateCheckNames(project: AppConfig["projects"][number] | undefined): string[] {
  const configured = project?.gateChecks?.map((entry) => entry.trim()).filter(Boolean) ?? [];
  return configured.length > 0 ? configured : ["Tests", "verify"];
}

/**
 * A repair attempt is "duplicate" when we have already tried to repair the
 * exact same failure (same signature, same head SHA) AND no newer failure
 * has been observed since that attempt was recorded. For queue evictions
 * the PR head doesn't advance between attempts, so we additionally compare
 * the timestamps: a fresh incident after `main` advances looks identical
 * to a stale one without the timestamp check.
 */
export function isDuplicateRepairAttempt(
  issue: Pick<
    IssueRecord,
    "lastAttemptedFailureHeadSha" | "lastAttemptedFailureSignature" | "lastAttemptedFailureAt" | "lastGitHubFailureAt"
  >,
  context: RunContext | undefined,
): boolean {
  const signature = context?.failureSignature;
  const headSha = context?.failureHeadSha ?? context?.headSha;
  if (!signature) return false;
  if (issue.lastAttemptedFailureSignature !== signature) return false;
  if (headSha !== undefined && issue.lastAttemptedFailureHeadSha !== headSha) return false;
  if (issue.lastAttemptedFailureAt && issue.lastGitHubFailureAt
    && issue.lastGitHubFailureAt > issue.lastAttemptedFailureAt) {
    return false;
  }
  return true;
}

export type FailureContextIssue = Pick<
  IssueRecord,
  | "lastGitHubFailureSource"
  | "lastGitHubFailureHeadSha"
  | "lastGitHubFailureSignature"
  | "lastGitHubFailureCheckName"
  | "lastGitHubFailureCheckUrl"
  | "lastGitHubFailureContextJson"
  | "lastQueueIncidentJson"
>;

export function buildFailureContext(issue: FailureContextIssue): RunContext | undefined {
  const storedFailureContext = parseGitHubFailureContext(issue.lastGitHubFailureContextJson);
  const queueRepairContext = issue.lastQueueIncidentJson
    ? parseStoredQueueRepairContext(issue.lastQueueIncidentJson)
    : undefined;
  if (!queueRepairContext
    && !issue.lastGitHubFailureSource
    && !issue.lastGitHubFailureHeadSha
    && !issue.lastGitHubFailureSignature
    && !issue.lastGitHubFailureCheckName
    && !issue.lastGitHubFailureCheckUrl
    && !storedFailureContext) {
    return undefined;
  }
  return {
    ...(issue.lastGitHubFailureSource ? { failureReason: issue.lastGitHubFailureSource } : {}),
    ...(issue.lastGitHubFailureHeadSha ? { failureHeadSha: issue.lastGitHubFailureHeadSha } : {}),
    ...(issue.lastGitHubFailureSignature ? { failureSignature: issue.lastGitHubFailureSignature } : {}),
    ...(issue.lastGitHubFailureCheckName ? { checkName: issue.lastGitHubFailureCheckName } : {}),
    ...(issue.lastGitHubFailureCheckUrl ? { checkUrl: issue.lastGitHubFailureCheckUrl } : {}),
    ...(storedFailureContext ? storedFailureContext : {}),
    ...(queueRepairContext ? queueRepairContext : {}),
  };
}

export type FailureProvenanceIssue = Pick<
  IssueRecord,
  | "lastGitHubFailureSource"
  | "lastGitHubFailureHeadSha"
  | "lastGitHubFailureSignature"
  | "lastGitHubFailureCheckName"
  | "lastGitHubFailureCheckUrl"
  | "lastGitHubFailureContextJson"
  | "lastGitHubFailureAt"
  | "lastQueueIncidentJson"
  | "lastAttemptedFailureHeadSha"
  | "lastAttemptedFailureSignature"
>;

export function hasFailureProvenance(issue: FailureProvenanceIssue): boolean {
  return Boolean(
    issue.lastGitHubFailureSource
      || issue.lastGitHubFailureHeadSha
      || issue.lastGitHubFailureSignature
      || issue.lastGitHubFailureCheckName
      || issue.lastGitHubFailureCheckUrl
      || issue.lastGitHubFailureContextJson
      || issue.lastGitHubFailureAt
      || issue.lastQueueIncidentJson
      || issue.lastAttemptedFailureHeadSha
      || issue.lastAttemptedFailureSignature,
  );
}
