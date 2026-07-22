import type { RunType } from "../run-type.ts";
import type { WorkflowRunIntent } from "../workflow-intent.ts";
import type { InputRequestKind } from "../issue-phase.ts";

export interface IssueUpdatePlanInputs {
  existingIssue: boolean;
  existingInputRequestKind?: InputRequestKind | undefined;
  delegated: boolean;
  incomingAgentSessionId?: string | undefined;
  startupResume: { workflowIntent?: WorkflowRunIntent | undefined };
  desiredStage?: RunType | undefined;
  blockerPausedImplementation: boolean;
  undelegation: { paused: boolean; clearPending?: boolean | undefined };
  effectiveRunRelease: { release: boolean };
  shouldEnterOrchestrationSettle: boolean;
  agentSessionId?: string | null | undefined;
  computeOrchestrationSettleUntil: () => string;
}

export interface ResolvedIssueUpdate {
  workflowOutcome?: null;
  workflowOutcomeReason?: null;
  inputRequestKind?: "paused_local_work" | null;
  activeRunId?: null;
  agentSessionId?: string | null;
  orchestrationSettleUntil?: string;
}

/**
 * Resolve only durable facts. Runnable work is represented by observations
 * and workflow tasks; presentation phase is derived elsewhere.
 */
export function resolveIssueUpdatePlan(input: IssueUpdatePlanInputs): ResolvedIssueUpdate {
  const resolved: ResolvedIssueUpdate = {};

  if (
    input.desiredStage
    || input.startupResume.workflowIntent
    || (input.delegated && input.existingInputRequestKind === "paused_local_work")
  ) {
    resolved.workflowOutcome = null;
    resolved.workflowOutcomeReason = null;
    resolved.inputRequestKind = null;
  } else if (!input.existingIssue && !input.delegated && input.incomingAgentSessionId) {
    resolved.inputRequestKind = "paused_local_work";
  }

  if (input.effectiveRunRelease.release) resolved.activeRunId = null;
  if (input.agentSessionId !== undefined) resolved.agentSessionId = input.agentSessionId;
  if (input.shouldEnterOrchestrationSettle) {
    resolved.orchestrationSettleUntil = input.computeOrchestrationSettleUntil();
  }
  return resolved;
}
