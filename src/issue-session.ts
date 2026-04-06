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
  queueLabelApplied?: boolean | undefined;
  latestFailureCheckName?: string | undefined;
}

export interface IssueSessionWakeReasonInput {
  pendingRunType?: RunType | undefined;
  factoryState: FactoryState;
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
  if (params.prReviewState === "changes_requested") return "review_changes_requested";
  if (params.latestFailureSource === "queue_eviction") return "merge_steward_incident";
  if (params.prCheckStatus === "failed" || params.prCheckStatus === "failure") return "settled_red_ci";
  return undefined;
}
