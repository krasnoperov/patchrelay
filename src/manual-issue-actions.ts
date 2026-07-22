import type { UpsertIssueParams } from "./db/issue-store.ts";
import type { RunType } from "./run-type.ts";
import { hasOpenPr } from "./pr-state.ts";

export interface ResolvedManualAction {
  runType: RunType | "none";
}

export function resolveRetryTarget(params: {
  prNumber: number | undefined;
  prState: string | undefined;
  prReviewState: string | undefined;
  prCheckStatus: string | undefined;
  runnableTaskRunType: RunType | undefined;
  lastRunType: RunType | undefined;
  lastGitHubFailureSource: string | undefined;
}): ResolvedManualAction {
  if (params.prState === "merged") {
    return { runType: "none" };
  }

  if (hasOpenPr(params.prNumber, params.prState) && params.lastGitHubFailureSource === "queue_eviction") {
    return { runType: "queue_repair" };
  }
  if (
    hasOpenPr(params.prNumber, params.prState)
    && params.prReviewState === "approved"
    && params.lastRunType === "queue_repair"
  ) {
    return { runType: "queue_repair" };
  }
  if (
    hasOpenPr(params.prNumber, params.prState)
    && (params.prCheckStatus === "failed" || params.prCheckStatus === "failure" || params.lastGitHubFailureSource === "branch_ci")
  ) {
    return { runType: "ci_repair" };
  }
  if (hasOpenPr(params.prNumber, params.prState) && params.prReviewState === "changes_requested") {
    return {
      runType: params.runnableTaskRunType === "branch_upkeep" || params.lastRunType === "branch_upkeep"
        ? "branch_upkeep"
        : "review_fix",
    };
  }
  if (hasOpenPr(params.prNumber, params.prState)) {
    return { runType: "implementation" };
  }
  return { runType: "implementation" };
}

export function buildManualRetryAttemptReset(runType: RunType): Partial<Pick<UpsertIssueParams, "ciRepairAttempts" | "queueRepairAttempts" | "reviewFixAttempts">> {
  if (runType === "ci_repair") {
    return { ciRepairAttempts: 0 };
  }
  if (runType === "queue_repair") {
    return { queueRepairAttempts: 0 };
  }
  if (runType === "review_fix" || runType === "branch_upkeep") {
    return { reviewFixAttempts: 0 };
  }
  return {};
}
