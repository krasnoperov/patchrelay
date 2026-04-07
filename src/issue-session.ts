import type { FactoryState, RunType } from "./factory-state.ts";
import { derivePatchRelayWaitingReason } from "./waiting-reason.ts";

export type IssueSessionState = "idle" | "running" | "waiting_input" | "done" | "failed";

export interface IssueSessionStateInput {
  activeRunId?: number | undefined;
  factoryState: FactoryState;
}

export interface IssueSessionWaitingReasonInput {
  activeRunId?: number | undefined;
  blockedByKeys: string[];
  factoryState: FactoryState;
  pendingRunType?: RunType | undefined;
  prNumber?: number | undefined;
  prReviewState?: string | undefined;
  prCheckStatus?: string | undefined;
  latestFailureCheckName?: string | undefined;
}

export interface IssueSessionWakeReasonInput {
  pendingRunType?: RunType | undefined;
  factoryState: FactoryState;
  prNumber?: number | undefined;
  prState?: string | undefined;
  prReviewState?: string | undefined;
  prCheckStatus?: string | undefined;
  latestFailureSource?: string | undefined;
}

export interface IssueSessionReactiveIntentInput {
  activeRunId?: number | undefined;
  prNumber?: number | undefined;
  prState?: string | undefined;
  prReviewState?: string | undefined;
  prCheckStatus?: string | undefined;
  latestFailureSource?: string | undefined;
  mergeConflictDetected?: boolean | undefined;
  downstreamOwned?: boolean | undefined;
}

export interface IssueSessionReactiveIntent {
  runType: Extract<RunType, "review_fix" | "ci_repair" | "queue_repair">;
  wakeReason: "review_changes_requested" | "settled_red_ci" | "merge_steward_incident";
  compatibilityFactoryState: Extract<FactoryState, "changes_requested" | "repairing_ci" | "repairing_queue">;
}

export interface IssueSessionReadyInput {
  sessionState?: IssueSessionState | undefined;
  factoryState: FactoryState;
  activeRunId?: number | undefined;
  blockedByCount: number;
  hasPendingWake: boolean;
  hasLegacyPendingRun: boolean;
  prNumber?: number | undefined;
  prState?: string | undefined;
  prReviewState?: string | undefined;
  prCheckStatus?: string | undefined;
  latestFailureSource?: string | undefined;
}

export function deriveIssueSessionState(params: IssueSessionStateInput): IssueSessionState {
  if (params.factoryState === "done") return "done";
  if (params.factoryState === "failed" || params.factoryState === "escalated") return "failed";
  if (params.factoryState === "awaiting_input") return "waiting_input";
  if (params.activeRunId !== undefined) return "running";
  return "idle";
}

export function deriveIssueSessionWaitingReason(params: IssueSessionWaitingReasonInput): string | undefined {
  return derivePatchRelayWaitingReason(params);
}

export function deriveIssueSessionWakeReason(params: IssueSessionWakeReasonInput): string | undefined {
  if (params.pendingRunType === "implementation") return "delegated";
  if (params.pendingRunType === "review_fix") return "review_changes_requested";
  if (params.pendingRunType === "ci_repair") return "settled_red_ci";
  if (params.pendingRunType === "queue_repair") return "merge_steward_incident";
  if (params.factoryState === "awaiting_input") return "waiting_for_human_reply";
  const reactiveIntent = deriveIssueSessionReactiveIntent({
    prNumber: params.prNumber,
    prState: params.prState,
    prReviewState: params.prReviewState,
    prCheckStatus: params.prCheckStatus,
    latestFailureSource: params.latestFailureSource,
  });
  if (reactiveIntent) return reactiveIntent.wakeReason;
  return undefined;
}

export function deriveIssueSessionReactiveIntent(
  params: IssueSessionReactiveIntentInput,
): IssueSessionReactiveIntent | undefined {
  if (params.activeRunId !== undefined) return undefined;
  if (params.prNumber === undefined) return undefined;
  if (params.prState && params.prState !== "open") return undefined;

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

  if (params.prReviewState === "changes_requested") {
    return {
      runType: "review_fix",
      wakeReason: "review_changes_requested",
      compatibilityFactoryState: "changes_requested",
    };
  }

  return undefined;
}

export function isIssueSessionReadyForExecution(params: IssueSessionReadyInput): boolean {
  if (params.activeRunId !== undefined) return false;
  if (params.blockedByCount > 0) return false;
  if (params.sessionState === "done" || params.sessionState === "failed" || params.sessionState === "waiting_input") {
    return false;
  }
  if (params.hasPendingWake) {
    return true;
  }
  if (!params.hasLegacyPendingRun) {
    return false;
  }
  if (
    deriveIssueSessionReactiveIntent({
      prNumber: params.prNumber,
      prState: params.prState,
      prReviewState: params.prReviewState,
      prCheckStatus: params.prCheckStatus,
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
