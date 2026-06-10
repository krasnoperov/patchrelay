import {
  deriveIssueExecutionState,
  type IssueExecutionRunFacts,
  type IssueExecutionState,
  type IssueExecutionStateInput,
} from "./issue-execution-state.ts";

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

/**
 * `waitingReason` is a pure function of {@link IssueExecutionState} — the
 * union (issue-execution-state.ts) is the single derivation of "why is this
 * issue not moving"; this module only renders it for operators.
 */
export function derivePatchRelayWaitingReason(params: IssueExecutionStateInput): PatchRelayWaitingReason | undefined {
  return waitingReasonForExecutionState(deriveIssueExecutionState(params));
}

export function waitingReasonForExecutionState(state: IssueExecutionState): PatchRelayWaitingReason | undefined {
  switch (state.kind) {
    case "undelegated":
      return state.downstreamMayContinue
        ? PATCHRELAY_WAITING_REASONS.automationPausedDownstream
        : PATCHRELAY_WAITING_REASONS.automationPaused;
    case "running":
    // An inconsistent row still describes what is observably happening (a run
    // occupies the slot); reconcilers act on the union kind, not this string.
    case "inconsistent":
      return describeRun(state.run);
    case "settling":
      return PATCHRELAY_WAITING_REASONS.waitingForChildSettle;
    case "blocked":
      return `Blocked by ${state.blockedByKeys.join(", ")}`;
    case "waiting_input":
      return PATCHRELAY_WAITING_REASONS.waitingForOperatorInput;
    case "awaiting_followup":
      switch (state.followup) {
        case "review_fix":
          return PATCHRELAY_WAITING_REASONS.waitingForReviewFeedback;
        case "ci_repair":
          return `Waiting to repair ${state.checkName ?? "CI"}`;
        case "queue_repair":
          return PATCHRELAY_WAITING_REASONS.waitingForMergeStewardRepair;
      }
      break;
    case "terminal":
      return state.outcome === "done"
        ? PATCHRELAY_WAITING_REASONS.workComplete
        : PATCHRELAY_WAITING_REASONS.waitingForOperatorIntervention;
    case "idle_awaiting_external":
      switch (state.waitingOn) {
        case "merge_queue":
        case "downstream_automation":
          return PATCHRELAY_WAITING_REASONS.waitingForDownstreamAutomation;
        case "ci_failure":
          return `${state.checkName ?? "CI"} failed`;
        case "review_of_new_head":
          return PATCHRELAY_WAITING_REASONS.waitingForReviewOnNewHead;
        case "blocking_review_same_head":
          return PATCHRELAY_WAITING_REASONS.sameHeadStillBlocked;
        case "review_feedback":
          return PATCHRELAY_WAITING_REASONS.waitingForReviewFeedback;
        case "external_review":
          return PATCHRELAY_WAITING_REASONS.waitingForExternalReview;
      }
      break;
    case "ready":
      return `Ready to run ${humanize(state.pendingRunType)}`;
    case "idle":
      return undefined;
  }
  return undefined;
}

function describeRun(run: IssueExecutionRunFacts): PatchRelayWaitingReason {
  if (!run.runType) {
    return PATCHRELAY_WAITING_REASONS.activeWork;
  }
  switch (run.phase) {
    case "finalizing_published_pr":
      return PATCHRELAY_WAITING_REASONS.finalizingPublishedPr;
    case "finalizing_merged_change":
      return PATCHRELAY_WAITING_REASONS.finalizingMergedChange;
    case "working":
      return `PatchRelay is running ${humanize(run.runType)}`;
  }
}

function humanize(value: string): string {
  return value.replaceAll("_", " ");
}
