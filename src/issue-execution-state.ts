import type { IssueRecord, RunRecord } from "./db-types.ts";
import { hasOpenPr, isCanceledLinearState, isCompletedLinearState } from "./pr-state.ts";

/**
 * D3 (core simplification plan): the single derived answer to "why is this
 * issue not moving". Computed from issue-row facts (`delegatedToPatchRelay`,
 * `factoryState`, `activeRunId`, PR metadata) plus optional run facts —
 * never stored. `waitingReason` (see waiting-reason.ts) is a pure function
 * of this union.
 *
 * Illegal fact combinations that the row can still express — they are
 * invariant violations, e.g. a terminal factoryState with an occupied run
 * slot — are classified as `inconsistent` instead of throwing, so
 * reconcilers can observe and repair them.
 */

/** Why an issue sits in `awaiting_input`. */
export type AwaitingInputReason = "paused_local_work" | "completion_check_question";

/** What phase an active run is in, derived from run + PR facts. */
export type IssueExecutionRunPhase = "working" | "finalizing_published_pr" | "finalizing_merged_change";

export interface IssueExecutionRunFacts {
  activeRunId?: number | undefined;
  runType?: string | undefined;
  phase: IssueExecutionRunPhase;
}

/** What external (GitHub/downstream) truth an idle issue is waiting on. */
export type IssueExternalWait =
  | "merge_queue"
  | "ci_failure"
  | "review_of_new_head"
  | "blocking_review_same_head"
  | "review_feedback"
  | "downstream_automation"
  | "external_review";

/** Repair work PatchRelay still owes the issue (wake pending or imminent). */
export type IssueFollowupRepair = "review_fix" | "ci_repair" | "queue_repair";

export type IssueExecutionState =
  /** Operator pulled the delegation; automation is paused. */
  | { kind: "undelegated"; downstreamMayContinue: boolean }
  /** A Codex run occupies the slot (or run facts indicate one is in flight). */
  | { kind: "running"; run: IssueExecutionRunFacts }
  /** Orchestration settle window: waiting briefly for child issues to settle. */
  | { kind: "settling"; settleUntil: string }
  /** Unresolved dependency blockers. */
  | { kind: "blocked"; blockedByKeys: string[] }
  /** factoryState awaiting_input with no run: waiting on a human reply. */
  | { kind: "waiting_input"; reason: AwaitingInputReason }
  /** A repair state without a run: PatchRelay owes follow-up work. */
  | { kind: "awaiting_followup"; followup: IssueFollowupRepair; checkName?: string | undefined }
  /** done / failed / escalated with a clear slot. */
  | { kind: "terminal"; outcome: "done" | "failed" | "escalated" }
  /** No run and nothing for PatchRelay to do: waiting on GitHub/downstream truth. */
  | { kind: "idle_awaiting_external"; waitingOn: IssueExternalWait; checkName?: string | undefined }
  /** Legacy pending-run slot is populated; ready to launch. */
  | { kind: "ready"; pendingRunType: string }
  /** Nothing pending, nothing blocking — no wait reason at all. */
  | { kind: "idle" }
  /**
   * The row expresses an invariant violation (e.g. terminal factoryState with
   * an occupied run slot, or a slot pointing at a terminal run). Carries the
   * run facts so presentation can still describe what is observably happening
   * while reconciliation repairs the row.
   */
  | { kind: "inconsistent"; description: string; run: IssueExecutionRunFacts };

export interface IssueExecutionStateInput {
  delegatedToPatchRelay?: boolean | undefined;
  factoryState?: string | undefined;
  currentLinearState?: string | undefined;
  currentLinearStateType?: string | undefined;
  activeRunId?: number | undefined;
  activeRunType?: string | undefined;
  /** Status of the run `activeRunId` points at, when the caller resolved the record. */
  activeRunStatus?: string | undefined;
  /** Completion-check outcome of the latest run (types the awaiting_input reason). */
  latestRunCompletionCheckOutcome?: string | undefined;
  pendingRunType?: string | undefined;
  blockedByKeys?: string[] | undefined;
  orchestrationSettleUntil?: string | undefined;
  prNumber?: number | undefined;
  prState?: string | undefined;
  prHeadSha?: string | undefined;
  prReviewState?: string | undefined;
  prCheckStatus?: string | undefined;
  lastBlockingReviewHeadSha?: string | undefined;
  latestFailureCheckName?: string | undefined;
  /** Clock override for the orchestration-settle comparison (tests). */
  now?: number | undefined;
}

/** Run statuses that may legally occupy an issue's active-run slot. */
const ACTIVE_RUN_STATUSES: ReadonlySet<string> = new Set(["queued", "running"]);

export function deriveIssueExecutionState(params: IssueExecutionStateInput): IssueExecutionState {
  const factoryState = params.factoryState;

  if (isCompletedLinearState(params.currentLinearStateType, params.currentLinearState)) {
    return { kind: "terminal", outcome: "done" };
  }
  if (isCanceledLinearState(params.currentLinearStateType, params.currentLinearState)) {
    return { kind: "terminal", outcome: "failed" };
  }

  // Undelegation pauses automation for any non-finished issue and outranks
  // every other answer (including an active run, which keeps executing but
  // is reported as paused-with-downstream-continuation where relevant).
  if (
    params.delegatedToPatchRelay === false
    && factoryState !== "done"
    && factoryState !== "failed"
    && factoryState !== "escalated"
  ) {
    const downstreamMayContinue = factoryState === "awaiting_queue"
      || (hasOpenPr(params.prNumber, params.prState) && params.prReviewState === "approved");
    return { kind: "undelegated", downstreamMayContinue };
  }

  // Active run facts win next — the issue is moving (or claims to be).
  if (params.activeRunType || params.activeRunId !== undefined) {
    const run: IssueExecutionRunFacts = {
      ...(params.activeRunId !== undefined ? { activeRunId: params.activeRunId } : {}),
      ...(params.activeRunType ? { runType: params.activeRunType } : {}),
      phase: resolveRunPhase(params),
    };
    // `done` + active run is a legitimate finalizing window (the post-run
    // finalizer advances factoryState before clearing the slot), and
    // `awaiting_input` + active run is a resumed reply turn. `failed` /
    // `escalated` should never hold a slot: settleRun clears it before the
    // terminal transition lands.
    if (factoryState === "failed" || factoryState === "escalated") {
      return {
        kind: "inconsistent",
        description: `terminal factoryState "${factoryState}" still holds an active run slot`,
        run,
      };
    }
    if (params.activeRunStatus !== undefined && !ACTIVE_RUN_STATUSES.has(params.activeRunStatus)) {
      return {
        kind: "inconsistent",
        description: `active run slot points at a ${params.activeRunStatus} run`,
        run,
      };
    }
    return { kind: "running", run };
  }

  if (params.orchestrationSettleUntil) {
    const settleAt = Date.parse(params.orchestrationSettleUntil);
    if (Number.isFinite(settleAt) && settleAt > (params.now ?? Date.now())) {
      return { kind: "settling", settleUntil: params.orchestrationSettleUntil };
    }
  }

  const blockedByKeys = (params.blockedByKeys ?? []).filter((value) => value.trim().length > 0);
  if (blockedByKeys.length > 0) {
    return { kind: "blocked", blockedByKeys };
  }

  switch (factoryState) {
    case "awaiting_input":
      return {
        kind: "waiting_input",
        reason: params.latestRunCompletionCheckOutcome === "needs_input"
          ? "completion_check_question"
          : "paused_local_work",
      };
    case "changes_requested":
      return { kind: "awaiting_followup", followup: "review_fix" };
    case "repairing_ci":
      return { kind: "awaiting_followup", followup: "ci_repair", checkName: params.latestFailureCheckName };
    case "repairing_queue":
      return { kind: "awaiting_followup", followup: "queue_repair" };
    case "awaiting_queue":
      return { kind: "idle_awaiting_external", waitingOn: "merge_queue" };
    case "done":
      return { kind: "terminal", outcome: "done" };
    case "failed":
      return { kind: "terminal", outcome: "failed" };
    case "escalated":
      return { kind: "terminal", outcome: "escalated" };
    default:
      break;
  }

  // delegated / implementing / pr_open / deploying: the wait, if any, is
  // derived from live PR truth.
  if (params.prCheckStatus === "failed" || params.prCheckStatus === "failure") {
    return { kind: "idle_awaiting_external", waitingOn: "ci_failure", checkName: params.latestFailureCheckName };
  }
  if (params.prReviewState === "changes_requested") {
    if (params.prCheckStatus === "passed" || params.prCheckStatus === "success") {
      if (
        params.prHeadSha
        && params.lastBlockingReviewHeadSha
        && params.prHeadSha !== params.lastBlockingReviewHeadSha
      ) {
        return { kind: "idle_awaiting_external", waitingOn: "review_of_new_head" };
      }
      return { kind: "idle_awaiting_external", waitingOn: "blocking_review_same_head" };
    }
    return { kind: "idle_awaiting_external", waitingOn: "review_feedback" };
  }
  if (params.prReviewState === "approved") {
    return { kind: "idle_awaiting_external", waitingOn: "downstream_automation" };
  }
  if (hasOpenPr(params.prNumber, params.prState)) {
    return { kind: "idle_awaiting_external", waitingOn: "external_review" };
  }
  if (params.pendingRunType) {
    return { kind: "ready", pendingRunType: params.pendingRunType };
  }
  return { kind: "idle" };
}

function resolveRunPhase(
  params: Pick<IssueExecutionStateInput, "factoryState" | "prNumber" | "prState">,
): IssueExecutionRunPhase {
  if (hasOpenPr(params.prNumber, params.prState) && (params.factoryState === "pr_open" || params.factoryState === "awaiting_queue")) {
    return "finalizing_published_pr";
  }
  if (params.factoryState === "done") {
    return "finalizing_merged_change";
  }
  return "working";
}

/** Build the deriver input from full records (issue row + resolved runs). */
export function issueExecutionStateInputFromRecords(
  issue: Pick<
    IssueRecord,
    | "delegatedToPatchRelay"
    | "factoryState"
    | "currentLinearState"
    | "currentLinearStateType"
    | "activeRunId"
    | "pendingRunType"
    | "orchestrationSettleUntil"
    | "prNumber"
    | "prState"
    | "prHeadSha"
    | "prReviewState"
    | "prCheckStatus"
    | "lastBlockingReviewHeadSha"
    | "lastGitHubFailureCheckName"
  >,
  extras?: {
    activeRun?: Pick<RunRecord, "id" | "runType" | "status"> | undefined;
    latestRun?: Pick<RunRecord, "completionCheckOutcome"> | undefined;
    blockedByKeys?: string[] | undefined;
  },
): IssueExecutionStateInput {
  return {
    delegatedToPatchRelay: issue.delegatedToPatchRelay,
    factoryState: issue.factoryState,
    currentLinearState: issue.currentLinearState,
    currentLinearStateType: issue.currentLinearStateType,
    activeRunId: issue.activeRunId,
    activeRunType: extras?.activeRun?.runType,
    activeRunStatus: extras?.activeRun?.status,
    latestRunCompletionCheckOutcome: extras?.latestRun?.completionCheckOutcome,
    pendingRunType: issue.pendingRunType,
    blockedByKeys: extras?.blockedByKeys,
    orchestrationSettleUntil: issue.orchestrationSettleUntil,
    prNumber: issue.prNumber,
    prState: issue.prState,
    prHeadSha: issue.prHeadSha,
    prReviewState: issue.prReviewState,
    prCheckStatus: issue.prCheckStatus,
    lastBlockingReviewHeadSha: issue.lastBlockingReviewHeadSha,
    latestFailureCheckName: issue.lastGitHubFailureCheckName,
  };
}

export function deriveIssueExecutionStateFromRecords(
  issue: Parameters<typeof issueExecutionStateInputFromRecords>[0],
  extras?: Parameters<typeof issueExecutionStateInputFromRecords>[1],
): IssueExecutionState {
  return deriveIssueExecutionState(issueExecutionStateInputFromRecords(issue, extras));
}
