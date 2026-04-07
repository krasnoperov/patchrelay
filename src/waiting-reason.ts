export const PATCHRELAY_WAITING_REASONS = {
  activeWork: "PatchRelay is actively working",
  waitingForOperatorInput: "Waiting on operator input",
  waitingForReviewFeedback: "Waiting to address review feedback",
  waitingForRereview: "Waiting on re-review after requested changes",
  waitingForMergeStewardRepair: "Waiting to repair a merge-steward incident",
  waitingForDownstreamAutomation: "Waiting on downstream review/merge automation",
  workComplete: "PatchRelay work is complete",
  waitingForOperatorIntervention: "Waiting on operator intervention",
  waitingForExternalReview: "Waiting on external review",
} as const;

export type PatchRelayWaitingReason = (typeof PATCHRELAY_WAITING_REASONS)[keyof typeof PATCHRELAY_WAITING_REASONS] | string;

export function derivePatchRelayWaitingReason(params: {
  activeRunType?: string | undefined;
  activeRunId?: number | undefined;
  blockedByKeys?: string[] | undefined;
  factoryState?: string | undefined;
  pendingRunType?: string | undefined;
  prNumber?: number | undefined;
  prReviewState?: string | undefined;
  prCheckStatus?: string | undefined;
  latestFailureCheckName?: string | undefined;
}): PatchRelayWaitingReason | undefined {
  if (params.activeRunType) {
    return `PatchRelay is running ${humanize(params.activeRunType)}`;
  }
  if (params.activeRunId !== undefined) {
    return PATCHRELAY_WAITING_REASONS.activeWork;
  }

  const blockedByKeys = (params.blockedByKeys ?? []).filter((value) => value.trim().length > 0);
  if (blockedByKeys.length > 0) {
    return `Blocked by ${blockedByKeys.join(", ")}`;
  }

  const checkName = params.latestFailureCheckName ?? "CI";
  switch (params.factoryState) {
    case "awaiting_input":
      return PATCHRELAY_WAITING_REASONS.waitingForOperatorInput;
    case "changes_requested":
      return PATCHRELAY_WAITING_REASONS.waitingForReviewFeedback;
    case "repairing_ci":
      return `Waiting to repair ${checkName}`;
    case "repairing_queue":
      return PATCHRELAY_WAITING_REASONS.waitingForMergeStewardRepair;
    case "awaiting_queue":
      return PATCHRELAY_WAITING_REASONS.waitingForDownstreamAutomation;
    case "done":
      return PATCHRELAY_WAITING_REASONS.workComplete;
    case "failed":
    case "escalated":
      return PATCHRELAY_WAITING_REASONS.waitingForOperatorIntervention;
    default:
      break;
  }

  if (params.prCheckStatus === "failed" || params.prCheckStatus === "failure") {
    return `${checkName} failed`;
  }
  if (params.prReviewState === "changes_requested") {
    if (params.prCheckStatus === "passed" || params.prCheckStatus === "success") {
      return PATCHRELAY_WAITING_REASONS.waitingForRereview;
    }
    return PATCHRELAY_WAITING_REASONS.waitingForReviewFeedback;
  }
  if (params.prReviewState === "approved") {
    return PATCHRELAY_WAITING_REASONS.waitingForDownstreamAutomation;
  }
  if (params.prNumber !== undefined) {
    return PATCHRELAY_WAITING_REASONS.waitingForExternalReview;
  }
  if (params.pendingRunType) {
    return `Ready to run ${humanize(params.pendingRunType)}`;
  }
  return undefined;
}

function humanize(value: string): string {
  return value.replaceAll("_", " ");
}
