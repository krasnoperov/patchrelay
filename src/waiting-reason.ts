import { hasOpenPr } from "./pr-state.ts";

export const PATCHRELAY_WAITING_REASONS = {
  activeWork: "PatchRelay is actively working",
  automationPaused: "PatchRelay automation is paused because the issue is undelegated",
  automationPausedDownstream: "PatchRelay automation is paused; downstream merge may still continue until the PR is closed",
  finalizingPublishedPr: "PatchRelay is finalizing a published PR",
  finalizingMergedChange: "PatchRelay is finalizing a merged change",
  waitingForOperatorInput: "Waiting on operator input",
  waitingForReviewFeedback: "Waiting to address review feedback",
  waitingForReviewOnNewHead: "Waiting on review of a newer pushed head",
  sameHeadStillBlocked: "Requested changes still block the current head",
  waitingForMergeStewardRepair: "Waiting to repair a merge-steward incident",
  waitingForDownstreamAutomation: "PatchRelay work is done; waiting on downstream review/merge automation",
  waitingForChildSettle: "Waiting briefly for child issues to settle before orchestration starts",
  workComplete: "PatchRelay work is complete",
  waitingForOperatorIntervention: "Waiting on operator intervention",
  waitingForExternalReview: "Waiting on external review",
} as const;

export type PatchRelayWaitingReason = (typeof PATCHRELAY_WAITING_REASONS)[keyof typeof PATCHRELAY_WAITING_REASONS] | string;

export function derivePatchRelayWaitingReason(params: {
  delegatedToPatchRelay?: boolean | undefined;
  activeRunType?: string | undefined;
  activeRunId?: number | undefined;
  blockedByKeys?: string[] | undefined;
  factoryState?: string | undefined;
  pendingRunType?: string | undefined;
  orchestrationSettleUntil?: string | undefined;
  prNumber?: number | undefined;
  prState?: string | undefined;
  prHeadSha?: string | undefined;
  prReviewState?: string | undefined;
  prCheckStatus?: string | undefined;
  lastBlockingReviewHeadSha?: string | undefined;
  latestFailureCheckName?: string | undefined;
}): PatchRelayWaitingReason | undefined {
  if (params.delegatedToPatchRelay === false && params.factoryState !== "done" && params.factoryState !== "failed" && params.factoryState !== "escalated") {
    return params.factoryState === "awaiting_queue" || (hasLiveOpenPr(params.prNumber, params.prState) && params.prReviewState === "approved")
      ? PATCHRELAY_WAITING_REASONS.automationPausedDownstream
      : PATCHRELAY_WAITING_REASONS.automationPaused;
  }
  if (params.activeRunType) {
    if (hasOpenPr(params.prNumber, params.prState) && (params.factoryState === "pr_open" || params.factoryState === "awaiting_queue")) {
      return PATCHRELAY_WAITING_REASONS.finalizingPublishedPr;
    }
    if (params.factoryState === "done") {
      return PATCHRELAY_WAITING_REASONS.finalizingMergedChange;
    }
    return `PatchRelay is running ${humanize(params.activeRunType)}`;
  }
  if (params.activeRunId !== undefined) {
    return PATCHRELAY_WAITING_REASONS.activeWork;
  }
  if (params.orchestrationSettleUntil) {
    const settleAt = Date.parse(params.orchestrationSettleUntil);
    if (Number.isFinite(settleAt) && settleAt > Date.now()) {
      return PATCHRELAY_WAITING_REASONS.waitingForChildSettle;
    }
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
      if (
        params.prHeadSha
        && params.lastBlockingReviewHeadSha
        && params.prHeadSha !== params.lastBlockingReviewHeadSha
      ) {
        return PATCHRELAY_WAITING_REASONS.waitingForReviewOnNewHead;
      }
      return PATCHRELAY_WAITING_REASONS.sameHeadStillBlocked;
    }
    return PATCHRELAY_WAITING_REASONS.waitingForReviewFeedback;
  }
  if (params.prReviewState === "approved") {
    return PATCHRELAY_WAITING_REASONS.waitingForDownstreamAutomation;
  }
  if (hasOpenPr(params.prNumber, params.prState)) {
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

function hasLiveOpenPr(prNumber: number | undefined, prState: string | undefined): boolean {
  return prNumber !== undefined && (prState === undefined || prState === "open");
}
