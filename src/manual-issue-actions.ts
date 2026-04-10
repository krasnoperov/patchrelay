import type { UpsertIssueParams } from "./db/issue-store.ts";
import type { FactoryState, RunType } from "./factory-state.ts";
import { hasOpenPr } from "./pr-state.ts";

export interface ResolvedManualAction {
  runType: RunType | "none";
  factoryState: FactoryState | "done";
}

export function resolveRetryTarget(params: {
  prNumber: number | undefined;
  prState: string | undefined;
  prReviewState: string | undefined;
  prCheckStatus: string | undefined;
  pendingRunType: RunType | undefined;
  lastRunType: RunType | undefined;
  lastGitHubFailureSource: string | undefined;
}): ResolvedManualAction {
  if (params.prState === "merged") {
    return { runType: "none", factoryState: "done" };
  }

  if (hasOpenPr(params.prNumber, params.prState) && params.lastGitHubFailureSource === "queue_eviction") {
    return { runType: "queue_repair", factoryState: "repairing_queue" };
  }
  if (
    hasOpenPr(params.prNumber, params.prState)
    && (params.prCheckStatus === "failed" || params.prCheckStatus === "failure" || params.lastGitHubFailureSource === "branch_ci")
  ) {
    return { runType: "ci_repair", factoryState: "repairing_ci" };
  }
  if (hasOpenPr(params.prNumber, params.prState) && params.prReviewState === "changes_requested") {
    return {
      runType: params.pendingRunType === "branch_upkeep" || params.lastRunType === "branch_upkeep"
        ? "branch_upkeep"
        : "review_fix",
      factoryState: "changes_requested",
    };
  }
  if (hasOpenPr(params.prNumber, params.prState)) {
    return { runType: "implementation", factoryState: "implementing" };
  }
  return { runType: "implementation", factoryState: "delegated" };
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
