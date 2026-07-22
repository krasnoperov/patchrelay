import type { RunType } from "./run-type.ts";

export interface ReactiveWorkflowIntentInput {
  delegatedToPatchRelay?: boolean | undefined;
  activeRunId?: number | undefined;
  prNumber?: number | undefined;
  prState?: string | undefined;
  prIsDraft?: boolean | undefined;
  prHeadSha?: string | undefined;
  prReviewState?: string | undefined;
  prCheckStatus?: string | undefined;
  lastBlockingReviewHeadSha?: string | undefined;
  latestFailureSource?: string | undefined;
  mergeConflictDetected?: boolean | undefined;
  downstreamOwned?: boolean | undefined;
}

export interface ReactiveWorkflowIntent {
  runType: Extract<RunType, "review_fix" | "branch_upkeep" | "ci_repair" | "queue_repair">;
  workflowReason: "review_changes_requested" | "branch_upkeep" | "settled_red_ci" | "merge_steward_incident";
}

export function deriveReactiveWorkflowIntent(
  params: ReactiveWorkflowIntentInput,
): ReactiveWorkflowIntent | undefined {
  if (params.delegatedToPatchRelay === false) return undefined;
  if (params.activeRunId !== undefined) return undefined;
  if (params.prNumber === undefined) return undefined;
  if (params.prState && params.prState !== "open") return undefined;
  if (params.prIsDraft) return undefined;

  if (params.latestFailureSource === "queue_eviction" || (params.mergeConflictDetected && params.downstreamOwned)) {
    return {
      runType: "queue_repair",
      workflowReason: "merge_steward_incident",
    };
  }

  if (params.prCheckStatus === "failed" || params.prCheckStatus === "failure" || params.latestFailureSource === "branch_ci") {
    return {
      runType: "ci_repair",
      workflowReason: "settled_red_ci",
    };
  }

  if (isCurrentHeadRequestedChanges({
    prReviewState: params.prReviewState,
    prHeadSha: params.prHeadSha,
    lastBlockingReviewHeadSha: params.lastBlockingReviewHeadSha,
  })) {
    if (params.mergeConflictDetected) {
      return {
        runType: "branch_upkeep",
        workflowReason: "branch_upkeep",
      };
    }
    return {
      runType: "review_fix",
      workflowReason: "review_changes_requested",
    };
  }

  return undefined;
}

export function isCurrentHeadRequestedChanges(params: {
  prReviewState?: string | undefined;
  prHeadSha?: string | undefined;
  lastBlockingReviewHeadSha?: string | undefined;
}): boolean {
  if (params.prReviewState !== "changes_requested") return false;
  if (!params.lastBlockingReviewHeadSha || !params.prHeadSha) return true;
  return params.lastBlockingReviewHeadSha === params.prHeadSha;
}
