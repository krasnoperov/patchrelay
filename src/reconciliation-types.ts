import type { CodexThreadSummary } from "./codex-types.ts";
import type { LinearIssueSnapshot } from "./linear-types.ts";
import type { ReconciliationAction, ReconciliationEntityId } from "./reconciliation-actions.ts";
import type { IssueLifecycleStatus, WorkflowStage } from "./workflow-types.ts";

export type ReconciliationRunStatus = "queued" | "running" | "paused" | "completed" | "failed" | "released";
export type ReconciliationObligationStatus = "pending" | "in_progress" | "completed" | "failed" | "cancelled";
export type LiveLinearStateStatus = "known" | "unknown";
export type LiveCodexStateStatus = "unknown" | "found" | "missing" | "error";
export type ReconciliationOutcome = "noop" | "hydrate_live_state" | "launch" | "continue" | "complete" | "fail" | "release";

export interface ReconciliationIssueControl {
  projectId: string;
  linearIssueId: string;
  desiredStage?: WorkflowStage;
  lifecycleStatus: IssueLifecycleStatus;
  statusCommentId?: string;
  activeRun?: ReconciliationRun;
}

export interface ReconciliationRun {
  id: ReconciliationEntityId;
  stage: WorkflowStage;
  status: ReconciliationRunStatus;
  threadId?: string;
  turnId?: string;
  parentThreadId?: string;
}

export interface ReconciliationObligation {
  id: ReconciliationEntityId;
  kind: string;
  status: ReconciliationObligationStatus;
  runId?: ReconciliationEntityId;
  threadId?: string;
  turnId?: string;
  payload?: unknown;
}

export interface ReconciliationPolicy {
  activeLinearStateName?: string;
  fallbackLinearStateName?: string;
}

export interface ReconciliationLiveLinearState {
  status: LiveLinearStateStatus;
  issue?: Pick<LinearIssueSnapshot, "id" | "stateName">;
}

export interface ReconciliationLiveCodexState {
  status: LiveCodexStateStatus;
  thread?: CodexThreadSummary;
  errorMessage?: string;
}

export interface ReconciliationInput {
  issue: ReconciliationIssueControl;
  obligations?: ReconciliationObligation[];
  policy?: ReconciliationPolicy;
  live?: {
    linear?: ReconciliationLiveLinearState;
    codex?: ReconciliationLiveCodexState;
  };
}

export interface ReconciliationDecision {
  outcome: ReconciliationOutcome;
  reasons: string[];
  actions: ReconciliationAction[];
}
