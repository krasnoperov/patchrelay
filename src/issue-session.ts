import type { FactoryState } from "./factory-state.ts";
import { isTerminalLinearState } from "./pr-state.ts";
import type { RunType } from "./run-type.ts";

export type IssueSessionState = "idle" | "running" | "waiting_input" | "done" | "failed";

export interface IssueSessionStateInput {
  activeRunId?: number | undefined;
  /** Durable PR fact: a merged PR is the fact-based signal for `done`. */
  prState?: string | undefined;
  /**
   * TODO(S8): terminal outcomes reached without a merged PR (no-PR completion,
   * closed-resolved-done, `failed`, `escalated`) and `awaiting_input` have no
   * dedicated fact column yet, so those narrow cases still read factory_state.
   * Once S8 lands dedicated markers this parameter is removed.
   */
  compatibilityFactoryState: FactoryState;
}

export interface IssueSessionStateLegacyInput {
  activeRunId?: number | undefined;
  factoryState: FactoryState;
}

export interface IssueSessionWakeReasonInput {
  delegatedToPatchRelay?: boolean | undefined;
  /**
   * Run type of the pending wake, resolved from PR-fact-derived workflow tasks
   * / actionable session wakes (see `peekPendingWakeRunType`) — replaces the
   * legacy `pending_run_type` column read.
   */
  pendingWakeRunType?: RunType | undefined;
  /** TODO(S8): `awaiting_input` has no fact column yet; still reads factory_state. */
  compatibilityFactoryState: FactoryState;
  orchestrationSettleUntil?: string | undefined;
  prNumber?: number | undefined;
  prState?: string | undefined;
  prHeadSha?: string | undefined;
  prReviewState?: string | undefined;
  prCheckStatus?: string | undefined;
  lastBlockingReviewHeadSha?: string | undefined;
  latestFailureSource?: string | undefined;
}

export interface IssueSessionWakeReasonLegacyInput {
  delegatedToPatchRelay?: boolean | undefined;
  pendingRunType?: RunType | undefined;
  factoryState: FactoryState;
  orchestrationSettleUntil?: string | undefined;
  prNumber?: number | undefined;
  prState?: string | undefined;
  prHeadSha?: string | undefined;
  prReviewState?: string | undefined;
  prCheckStatus?: string | undefined;
  lastBlockingReviewHeadSha?: string | undefined;
  latestFailureSource?: string | undefined;
}

export interface IssueSessionReactiveIntentInput {
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

export interface IssueSessionReactiveIntent {
  runType: Extract<RunType, "review_fix" | "branch_upkeep" | "ci_repair" | "queue_repair">;
  wakeReason: "review_changes_requested" | "branch_upkeep" | "settled_red_ci" | "merge_steward_incident";
  compatibilityFactoryState: Extract<FactoryState, "changes_requested" | "repairing_ci" | "repairing_queue">;
}

export interface IssueSessionReadyInput {
  sessionState?: IssueSessionState | undefined;
  factoryState: FactoryState;
  currentLinearState?: string | undefined;
  currentLinearStateType?: string | undefined;
  delegatedToPatchRelay?: boolean | undefined;
  activeRunId?: number | undefined;
  blockedByCount: number;
  hasPendingWake: boolean;
  hasLegacyPendingRun: boolean;
  orchestrationSettleUntil?: string | undefined;
  prNumber?: number | undefined;
  prState?: string | undefined;
  prHeadSha?: string | undefined;
  prReviewState?: string | undefined;
  prCheckStatus?: string | undefined;
  lastBlockingReviewHeadSha?: string | undefined;
  latestFailureSource?: string | undefined;
}

/**
 * S4 (Track-2 pivot): derive `session_state` from PR facts + `activeRunId`
 * instead of `factory_state`. A merged PR is the durable fact for `done`;
 * `running` follows the active-run slot. Terminal-without-merge and
 * `awaiting_input` cases have no dedicated fact column yet and fall back to
 * `compatibilityFactoryState` (TODO(S8)).
 */
export function deriveIssueSessionState(params: IssueSessionStateInput): IssueSessionState {
  if (params.prState === "merged") return "done";
  // TODO(S8): no fact column yet for no-PR / closed-resolved `done`.
  if (params.compatibilityFactoryState === "done") return "done";
  // TODO(S8): no fact column yet for `failed` / `escalated`.
  if (params.compatibilityFactoryState === "failed" || params.compatibilityFactoryState === "escalated") return "failed";
  // TODO(S8): no fact column yet for outstanding human input.
  if (params.compatibilityFactoryState === "awaiting_input") return "waiting_input";
  if (params.activeRunId !== undefined) return "running";
  return "idle";
}

/**
 * Legacy factory-state-keyed derivation, retained only so the projector can
 * shadow-compute it and emit `state.projection_divergence` telemetry against
 * the new fact-based derivation. Delete with S8/S9.
 */
export function deriveIssueSessionStateLegacy(params: IssueSessionStateLegacyInput): IssueSessionState {
  if (params.factoryState === "done") return "done";
  if (params.factoryState === "failed" || params.factoryState === "escalated") return "failed";
  if (params.factoryState === "awaiting_input") return "waiting_input";
  if (params.activeRunId !== undefined) return "running";
  return "idle";
}

/**
 * S4: derive the session wake reason from the PR-fact-based pending-wake run
 * type (`peekPendingWakeRunType`) + reactive intent, instead of the legacy
 * `pending_run_type` column. `awaiting_input` still consults
 * `compatibilityFactoryState` (TODO(S8)).
 */
export function deriveIssueSessionWakeReason(params: IssueSessionWakeReasonInput): string | undefined {
  if (params.delegatedToPatchRelay === false) return undefined;
  if (params.pendingWakeRunType === "implementation") return "delegated";
  if (params.pendingWakeRunType === "review_fix") return "review_changes_requested";
  if (params.pendingWakeRunType === "branch_upkeep") return "branch_upkeep";
  if (params.pendingWakeRunType === "ci_repair") return "settled_red_ci";
  if (params.pendingWakeRunType === "queue_repair") return "merge_steward_incident";
  // TODO(S8): outstanding-input has no fact column yet.
  if (params.compatibilityFactoryState === "awaiting_input") return "waiting_for_human_reply";
  const reactiveIntent = deriveIssueSessionReactiveIntent({
    delegatedToPatchRelay: params.delegatedToPatchRelay,
    prNumber: params.prNumber,
    prState: params.prState,
    prHeadSha: params.prHeadSha,
    prReviewState: params.prReviewState,
    prCheckStatus: params.prCheckStatus,
    lastBlockingReviewHeadSha: params.lastBlockingReviewHeadSha,
    latestFailureSource: params.latestFailureSource,
  });
  if (reactiveIntent) return reactiveIntent.wakeReason;
  return undefined;
}

/**
 * Legacy `pending_run_type` + factory-state-keyed wake-reason derivation, kept
 * only for shadow-parity telemetry against {@link deriveIssueSessionWakeReason}.
 * Delete with S6/S7.
 */
export function deriveIssueSessionWakeReasonLegacy(params: IssueSessionWakeReasonLegacyInput): string | undefined {
  if (params.delegatedToPatchRelay === false) return undefined;
  if (params.pendingRunType === "implementation") return "delegated";
  if (params.pendingRunType === "review_fix") return "review_changes_requested";
  if (params.pendingRunType === "branch_upkeep") return "branch_upkeep";
  if (params.pendingRunType === "ci_repair") return "settled_red_ci";
  if (params.pendingRunType === "queue_repair") return "merge_steward_incident";
  if (params.factoryState === "awaiting_input") return "waiting_for_human_reply";
  const reactiveIntent = deriveIssueSessionReactiveIntent({
    delegatedToPatchRelay: params.delegatedToPatchRelay,
    prNumber: params.prNumber,
    prState: params.prState,
    prHeadSha: params.prHeadSha,
    prReviewState: params.prReviewState,
    prCheckStatus: params.prCheckStatus,
    lastBlockingReviewHeadSha: params.lastBlockingReviewHeadSha,
    latestFailureSource: params.latestFailureSource,
  });
  if (reactiveIntent) return reactiveIntent.wakeReason;
  return undefined;
}

export function deriveIssueSessionReactiveIntent(
  params: IssueSessionReactiveIntentInput,
): IssueSessionReactiveIntent | undefined {
  if (params.delegatedToPatchRelay === false) return undefined;
  if (params.activeRunId !== undefined) return undefined;
  if (params.prNumber === undefined) return undefined;
  if (params.prState && params.prState !== "open") return undefined;
  if (params.prIsDraft) return undefined;

  if (params.latestFailureSource === "queue_eviction" || (params.mergeConflictDetected && params.downstreamOwned)) {
    return {
      runType: "queue_repair",
      wakeReason: "merge_steward_incident",
      compatibilityFactoryState: "repairing_queue",
    };
  }

  if (params.prCheckStatus === "failed" || params.prCheckStatus === "failure" || params.latestFailureSource === "branch_ci") {
    return {
      runType: "ci_repair",
      wakeReason: "settled_red_ci",
      compatibilityFactoryState: "repairing_ci",
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
        wakeReason: "branch_upkeep",
        compatibilityFactoryState: "changes_requested",
      };
    }
    return {
      runType: "review_fix",
      wakeReason: "review_changes_requested",
      compatibilityFactoryState: "changes_requested",
    };
  }

  return undefined;
}

export function isIssueSessionReadyForExecution(params: IssueSessionReadyInput): boolean {
  if (params.delegatedToPatchRelay === false) return false;
  if (isTerminalLinearState(params.currentLinearStateType, params.currentLinearState)) return false;
  if (params.activeRunId !== undefined) return false;
  if (params.blockedByCount > 0) return false;
  if (params.orchestrationSettleUntil) {
    const settleAt = Date.parse(params.orchestrationSettleUntil);
    if (Number.isFinite(settleAt) && settleAt > Date.now()) {
      return false;
    }
  }
  if (params.sessionState === "done" || params.sessionState === "waiting_input") {
    return false;
  }
  if (params.hasPendingWake) {
    return true;
  }
  if (params.sessionState === "failed") {
    return false;
  }
  if (!params.hasLegacyPendingRun) {
    return false;
  }
  if (
    deriveIssueSessionReactiveIntent({
      delegatedToPatchRelay: params.delegatedToPatchRelay,
      prNumber: params.prNumber,
      prState: params.prState,
      prHeadSha: params.prHeadSha,
      prReviewState: params.prReviewState,
      prCheckStatus: params.prCheckStatus,
      lastBlockingReviewHeadSha: params.lastBlockingReviewHeadSha,
      latestFailureSource: params.latestFailureSource,
    }) === undefined
  ) {
    return false;
  }
  if (
    params.factoryState === "awaiting_queue"
    || params.factoryState === "awaiting_input"
    || params.factoryState === "done"
    || params.factoryState === "failed"
    || params.factoryState === "escalated"
  ) {
    return false;
  }
  return true;
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
