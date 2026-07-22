import type { IssueRecord, RunRecord } from "./db-types.ts";
import { isCanceledLinearState, isCompletedLinearState } from "./linear-state.ts";
import { hasOpenPr } from "./pr-lifecycle.ts";

/**
 * D3 (core simplification plan): the single derived answer to "why is this
 * issue not moving". Computed from issue-row facts (`delegatedToPatchRelay`,
 * outcomes, input requests, `activeRunId`, PR metadata) plus optional run facts —
 * never stored. `waitingReason` (see waiting-reason.ts) is a pure function
 * of this union.
 *
 * Illegal fact combinations that the row can still express — they are
 * invariant violations, e.g. a terminal outcome with an occupied run
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

/** Repair work PatchRelay still owes the issue (workflow task pending or imminent). */
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
  /** A durable input request with no run: waiting on a human reply. */
  | { kind: "waiting_input"; reason: AwaitingInputReason }
  /** A repair state without a run: PatchRelay owes follow-up work. */
  | { kind: "awaiting_followup"; followup: IssueFollowupRepair; checkName?: string | undefined }
  /** done / failed / escalated with a clear slot. */
  | { kind: "terminal"; outcome: "done" | "failed" | "escalated" }
  /** No run and nothing for PatchRelay to do: waiting on GitHub/downstream truth. */
  | { kind: "idle_awaiting_external"; waitingOn: IssueExternalWait; checkName?: string | undefined }
  /** A runnable workflow task exists; ready to launch. */
  | { kind: "ready"; runnableTaskRunType: string }
  /** Nothing pending, nothing blocking — no wait reason at all. */
  | { kind: "idle" }
  /**
   * The row expresses an invariant violation (e.g. terminal outcome with
   * an occupied run slot, or a slot pointing at a terminal run). Carries the
   * run facts so presentation can still describe what is observably happening
   * while reconciliation repairs the row.
   */
  | { kind: "inconsistent"; description: string; run: IssueExecutionRunFacts };

export type IssueTerminalOutcome = "done" | "failed" | "escalated";

export interface IssueExecutionStateInput {
  delegatedToPatchRelay?: boolean | undefined;
  workflowOutcome?: "completed" | "failed" | "escalated" | undefined;
  inputRequestKind?: AwaitingInputReason | undefined;
  currentLinearState?: string | undefined;
  currentLinearStateType?: string | undefined;
  activeRunId?: number | undefined;
  activeRunType?: string | undefined;
  /** Status of the run `activeRunId` points at, when the caller resolved the record. */
  activeRunStatus?: string | undefined;
  /** Completion-check outcome of the latest run (types the awaiting_input reason). */
  latestRunCompletionCheckOutcome?: string | undefined;
  /** Run type resolved from an open runnable workflow task. */
  runnableTaskRunType?: string | undefined;
  blockedByKeys?: string[] | undefined;
  orchestrationSettleUntil?: string | undefined;
  prNumber?: number | undefined;
  prState?: string | undefined;
  prHeadSha?: string | undefined;
  prReviewState?: string | undefined;
  prCheckStatus?: string | undefined;
  lastBlockingReviewHeadSha?: string | undefined;
  latestFailureCheckName?: string | undefined;
  lastGitHubFailureSource?: "branch_ci" | "queue_eviction" | undefined;
  deployStartedAt?: string | undefined;
  /** Clock override for the orchestration-settle comparison (tests). */
  now?: number | undefined;
}

/** Run statuses that may legally occupy an issue's active-run slot. */
const ACTIVE_RUN_STATUSES: ReadonlySet<string> = new Set(["queued", "running"]);

export function deriveIssueTerminalOutcome(
  params: Pick<IssueExecutionStateInput, "workflowOutcome" | "currentLinearState" | "currentLinearStateType" | "prState">,
): IssueTerminalOutcome | undefined {
  if (
    params.workflowOutcome === "completed"
    || params.prState === "merged"
    || isCompletedLinearState(params.currentLinearStateType, params.currentLinearState)
  ) return "done";
  if (isCanceledLinearState(params.currentLinearStateType, params.currentLinearState)) return "failed";
  if (params.workflowOutcome === "failed") return "failed";
  if (params.workflowOutcome === "escalated") return "escalated";
  return undefined;
}

export function isIssueTerminalProjection(
  params: Pick<IssueExecutionStateInput, "workflowOutcome" | "currentLinearState" | "currentLinearStateType" | "prState">,
): boolean {
  return deriveIssueTerminalOutcome(params) !== undefined;
}

export function isIssueDoneProjection(
  params: Pick<IssueExecutionStateInput, "workflowOutcome" | "currentLinearState" | "currentLinearStateType" | "prState">,
): boolean {
  return deriveIssueTerminalOutcome(params) === "done";
}

export function isIssueTerminalFailureProjection(
  params: Pick<IssueExecutionStateInput, "workflowOutcome" | "currentLinearState" | "currentLinearStateType" | "prState">,
): boolean {
  const outcome = deriveIssueTerminalOutcome(params);
  return outcome === "failed" || outcome === "escalated";
}

export function isIssueAwaitingInputProjection(params: Pick<IssueExecutionStateInput, "inputRequestKind">): boolean {
  return params.inputRequestKind !== undefined;
}

export function isIssuePrePrOpenDisplayStateProjection(params: Pick<IssueExecutionStateInput, "inputRequestKind" | "prNumber">): boolean {
  return params.inputRequestKind !== undefined || params.prNumber === undefined;
}

export function isIssueDeployingProjection(params: Pick<IssueExecutionStateInput, "deployStartedAt" | "workflowOutcome">): boolean {
  return params.deployStartedAt !== undefined && params.workflowOutcome === undefined;
}

export function isIssueDownstreamOwnedProjection(params: Pick<IssueExecutionStateInput, "prReviewState">): boolean {
  return params.prReviewState === "approved";
}

export function isIssueAwaitingQueueProjection(params: Pick<IssueExecutionStateInput, "prReviewState" | "prState" | "workflowOutcome">): boolean {
  return params.workflowOutcome === undefined && params.prState === "open" && params.prReviewState === "approved";
}

export function isIssueTerminalDisplayStateProjection(params: Pick<IssueExecutionStateInput, "workflowOutcome">): boolean {
  return params.workflowOutcome !== undefined;
}

export function deriveClosedPrDispositionProjection(
  params: Pick<IssueExecutionStateInput, "workflowOutcome" | "inputRequestKind" | "currentLinearState" | "currentLinearStateType">,
): "done" | "terminal" | "redelegate" {
  const outcome = deriveIssueTerminalOutcome(params);
  if (outcome === "done") return "done";
  if (
    outcome === "failed"
    || outcome === "escalated"
    || params.inputRequestKind !== undefined
  ) return "terminal";
  return "redelegate";
}

export function isIssueDownstreamOrDoneProjection(
  params: Pick<IssueExecutionStateInput, "workflowOutcome" | "currentLinearState" | "currentLinearStateType" | "prState" | "prReviewState">,
): boolean {
  return params.prReviewState === "approved" || isIssueDoneProjection(params);
}

export function isIssueLocalWorkProjection(params: Pick<IssueExecutionStateInput, "prNumber" | "workflowOutcome">): boolean {
  return params.prNumber === undefined && params.workflowOutcome === undefined;
}

export function isIssuePublishedOrDownstreamOrDoneProjection(
  params: Pick<IssueExecutionStateInput, "workflowOutcome" | "currentLinearState" | "currentLinearStateType" | "prState" | "prNumber" | "prReviewState">,
): boolean {
  return hasOpenPr(params.prNumber, params.prState) || params.prReviewState === "approved" || isIssueDoneProjection(params);
}

export function isIssuePublishedOrDownstreamProjection(params: Pick<IssueExecutionStateInput, "prNumber" | "prState">): boolean {
  return hasOpenPr(params.prNumber, params.prState);
}

export function isIssuePrOpenProjection(params: Pick<IssueExecutionStateInput, "prNumber" | "prState" | "prReviewState">): boolean {
  return hasOpenPr(params.prNumber, params.prState) && params.prReviewState !== "approved";
}

export function isIssueDelegatedProjection(params: Pick<IssueExecutionStateInput, "prNumber" | "activeRunId">): boolean {
  return params.prNumber === undefined && params.activeRunId === undefined;
}

export function isIssueImplementingProjection(params: Pick<IssueExecutionStateInput, "activeRunType">): boolean {
  return params.activeRunType === "implementation";
}

export function isIssueRequestedChangesProjection(params: Pick<IssueExecutionStateInput, "prReviewState">): boolean {
  return params.prReviewState === "changes_requested";
}

export function isIssueCiRepairProjection(params: Pick<IssueExecutionStateInput, "prCheckStatus" | "lastGitHubFailureSource">): boolean {
  return params.lastGitHubFailureSource === "branch_ci" || params.prCheckStatus === "failed" || params.prCheckStatus === "failure";
}

export function isIssueQueueRepairProjection(params: Pick<IssueExecutionStateInput, "lastGitHubFailureSource">): boolean {
  return params.lastGitHubFailureSource === "queue_eviction";
}

export function deriveIssueExecutionState(params: IssueExecutionStateInput): IssueExecutionState {
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
    && params.workflowOutcome === undefined
  ) {
    const downstreamMayContinue = hasOpenPr(params.prNumber, params.prState) && params.prReviewState === "approved";
    return { kind: "undelegated", downstreamMayContinue };
  }

  // Active run facts win next — the issue is moving (or claims to be).
  if (params.activeRunType || params.activeRunId !== undefined) {
    const run: IssueExecutionRunFacts = {
      ...(params.activeRunId !== undefined ? { activeRunId: params.activeRunId } : {}),
      ...(params.activeRunType ? { runType: params.activeRunType } : {}),
      phase: resolveRunPhase(params),
    };
    if (params.workflowOutcome === "failed" || params.workflowOutcome === "escalated") {
      return {
        kind: "inconsistent",
        description: `terminal outcome "${params.workflowOutcome}" still holds an active run slot`,
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

  if (params.runnableTaskRunType) {
    return { kind: "ready", runnableTaskRunType: params.runnableTaskRunType };
  }

  if (params.inputRequestKind) {
    return { kind: "waiting_input", reason: params.inputRequestKind };
  }
  if (params.workflowOutcome === "completed") return { kind: "terminal", outcome: "done" };
  if (params.workflowOutcome === "failed") return { kind: "terminal", outcome: "failed" };
  if (params.workflowOutcome === "escalated") return { kind: "terminal", outcome: "escalated" };
  if (params.lastGitHubFailureSource === "queue_eviction") {
    return { kind: "awaiting_followup", followup: "queue_repair" };
  }
  if (params.lastGitHubFailureSource === "branch_ci") {
    return { kind: "awaiting_followup", followup: "ci_repair", checkName: params.latestFailureCheckName };
  }
  if (params.prReviewState === "changes_requested") {
    if (params.prHeadSha && params.lastBlockingReviewHeadSha && params.prHeadSha !== params.lastBlockingReviewHeadSha) {
      return { kind: "idle_awaiting_external", waitingOn: "review_of_new_head" };
    }
    if (
      params.prHeadSha
      && params.lastBlockingReviewHeadSha
      && params.prHeadSha === params.lastBlockingReviewHeadSha
      && (params.prCheckStatus === "passed" || params.prCheckStatus === "success")
    ) {
      return { kind: "idle_awaiting_external", waitingOn: "blocking_review_same_head" };
    }
    return { kind: "awaiting_followup", followup: "review_fix" };
  }
  if (params.prReviewState === "approved") {
    return { kind: "idle_awaiting_external", waitingOn: "merge_queue" };
  }

  // delegated / implementing / pr_open / deploying: the wait, if any, is
  // derived from live PR truth.
  if (params.prCheckStatus === "failed" || params.prCheckStatus === "failure") {
    return { kind: "idle_awaiting_external", waitingOn: "ci_failure", checkName: params.latestFailureCheckName };
  }
  if (params.prReviewState === "approved") {
    return { kind: "idle_awaiting_external", waitingOn: "downstream_automation" };
  }
  if (hasOpenPr(params.prNumber, params.prState)) {
    return { kind: "idle_awaiting_external", waitingOn: "external_review" };
  }
  return { kind: "idle" };
}

export function isIssueExecutionReadyForExecution(state: IssueExecutionState): boolean {
  return state.kind === "ready";
}

function resolveRunPhase(
  params: Pick<IssueExecutionStateInput, "workflowOutcome" | "prNumber" | "prState">,
): IssueExecutionRunPhase {
  if (hasOpenPr(params.prNumber, params.prState)) {
    return "finalizing_published_pr";
  }
  if (params.workflowOutcome === "completed" || params.prState === "merged") {
    return "finalizing_merged_change";
  }
  return "working";
}

/** Build the deriver input from full records (issue row + resolved runs). */
export function issueExecutionStateInputFromRecords(
  issue: Pick<
    IssueRecord,
    | "delegatedToPatchRelay"
    | "workflowOutcome"
    | "inputRequestKind"
    | "currentLinearState"
    | "currentLinearStateType"
    | "activeRunId"
    | "orchestrationSettleUntil"
    | "prNumber"
    | "prState"
    | "prHeadSha"
    | "prReviewState"
    | "prCheckStatus"
    | "lastBlockingReviewHeadSha"
    | "lastGitHubFailureCheckName"
    | "lastGitHubFailureSource"
    | "deployStartedAt"
  >,
  extras?: {
    activeRun?: Pick<RunRecord, "id" | "runType" | "status"> | undefined;
    latestRun?: Pick<RunRecord, "completionCheckOutcome"> | undefined;
    blockedByKeys?: string[] | undefined;
    runnableTaskRunType?: string | undefined;
  },
): IssueExecutionStateInput {
  return {
    delegatedToPatchRelay: issue.delegatedToPatchRelay,
    workflowOutcome: issue.workflowOutcome,
    inputRequestKind: issue.inputRequestKind,
    currentLinearState: issue.currentLinearState,
    currentLinearStateType: issue.currentLinearStateType,
    activeRunId: issue.activeRunId,
    activeRunType: extras?.activeRun?.runType,
    activeRunStatus: extras?.activeRun?.status,
    latestRunCompletionCheckOutcome: extras?.latestRun?.completionCheckOutcome,
    runnableTaskRunType: extras?.runnableTaskRunType,
    blockedByKeys: extras?.blockedByKeys,
    orchestrationSettleUntil: issue.orchestrationSettleUntil,
    prNumber: issue.prNumber,
    prState: issue.prState,
    prHeadSha: issue.prHeadSha,
    prReviewState: issue.prReviewState,
    prCheckStatus: issue.prCheckStatus,
    lastBlockingReviewHeadSha: issue.lastBlockingReviewHeadSha,
    latestFailureCheckName: issue.lastGitHubFailureCheckName,
    lastGitHubFailureSource: issue.lastGitHubFailureSource,
    deployStartedAt: issue.deployStartedAt,
  };
}

export function deriveIssueExecutionStateFromRecords(
  issue: Parameters<typeof issueExecutionStateInputFromRecords>[0],
  extras?: Parameters<typeof issueExecutionStateInputFromRecords>[1],
): IssueExecutionState {
  return deriveIssueExecutionState(issueExecutionStateInputFromRecords(issue, extras));
}
