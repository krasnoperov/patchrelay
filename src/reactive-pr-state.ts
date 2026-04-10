import { readRemotePrState, type RemotePrState } from "./remote-pr-state.ts";
import type { RunType } from "./factory-state.ts";
import type { AppConfig } from "./types.ts";

export function isRequestedChangesRunType(runType: RunType): boolean {
  return runType === "review_fix" || runType === "branch_upkeep";
}

export function normalizeRemotePrState(value: string | undefined): "open" | "closed" | "merged" | undefined {
  const normalized = value?.trim().toUpperCase();
  if (normalized === "OPEN") return "open";
  if (normalized === "CLOSED") return "closed";
  if (normalized === "MERGED") return "merged";
  return undefined;
}

export function normalizeRemoteReviewDecision(value: string | undefined): "approved" | "changes_requested" | "commented" | undefined {
  const normalized = value?.trim().toUpperCase();
  if (normalized === "APPROVED") return "approved";
  if (normalized === "CHANGES_REQUESTED") return "changes_requested";
  if (normalized === "REVIEW_REQUIRED") return "commented";
  return undefined;
}

export function isDirtyMergeStateStatus(value: string | undefined): boolean {
  return value?.trim().toUpperCase() === "DIRTY";
}

export function buildReviewFixBranchUpkeepContext(
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

export interface ReactivePrSnapshot {
  projectId: string;
  repoFullName: string;
  baseBranch: string;
  pr: RemotePrState;
  prState: "open" | "closed" | "merged" | undefined;
  reviewState: "approved" | "changes_requested" | "commented" | undefined;
  headSha: string | undefined;
  gateCheckName: string;
}

export async function readReactivePrSnapshot(
  config: AppConfig,
  projectId: string,
  prNumber: number,
): Promise<ReactivePrSnapshot | undefined> {
  const project = config.projects.find((entry) => entry.id === projectId);
  const repoFullName = project?.github?.repoFullName;
  if (!repoFullName) {
    return undefined;
  }

  const pr = await readRemotePrState(repoFullName, prNumber);
  if (!pr) {
    return undefined;
  }

  return {
    projectId,
    repoFullName,
    baseBranch: project?.github?.baseBranch ?? "main",
    pr,
    prState: normalizeRemotePrState(pr.state),
    reviewState: normalizeRemoteReviewDecision(pr.reviewDecision),
    headSha: pr.headRefOid,
    gateCheckName: project?.gateChecks?.find((entry) => entry.trim())?.trim() ?? "verify",
  };
}
