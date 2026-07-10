import type { FactoryState, RunType } from "../factory-state.ts";
import type { WorkflowRunIntent } from "../workflow-intent.ts";

/**
 * The 14-conditional-spread cascade inside DesiredStageRecorder.record was
 * structurally fragile: multiple branches all wrote to `factoryState`,
 * workflow intent, and old compatibility columns, relying on JavaScript spread
 * order to encode priority. The architecture review (architecture_assessment
 * _apr2026) flagged this as a top-of-list cleanup.
 *
 * This module replaces that cascade with an explicit priority resolver. The
 * caller hands in every decision input it has already computed; the resolver
 * returns a single ResolvedIssueUpdate with each field decided exactly once.
 */

export interface IssueUpdatePlanInputs {
  /** Has this issue been seen before? Drives the awaiting-input fallback. */
  existingIssue: boolean;
  delegated: boolean;
  /** A Linear agent session was attached to this webhook. */
  incomingAgentSessionId?: string | undefined;
  /** Resume-after-restart resolution, if any. `factoryState` here wins over `desiredStage`. */
  startupResume: {
    factoryState?: FactoryState | undefined;
    workflowIntent?: WorkflowRunIntent | undefined;
  };
  /** Fresh run intent computed for a delegated issue. */
  desiredStage?: RunType | undefined;
  /** Active run is being released AND we just hit a terminal Linear state. */
  terminalRunRelease: boolean;
  /** Implementation run paused because the issue became blocked mid-flight. */
  blockerPausedImplementation: boolean;
  /** Issue was just un-delegated. `factoryState` here wins over everything else. */
  undelegation: {
    factoryState?: FactoryState | undefined;
    clearPending?: boolean | undefined;
  };
  /** Compatibility input retained while callers converge; no DB column is written. */
  clearPending: boolean;
  effectiveRunRelease: { release: boolean };
  shouldEnterOrchestrationSettle: boolean;
  agentSessionId?: string | null | undefined;
  /** Time provider for the orchestration-settle window — testable. */
  computeOrchestrationSettleUntil: () => string;
}

export interface ResolvedIssueUpdate {
  factoryState?: FactoryState;
  activeRunId?: null;
  agentSessionId?: string | null;
  orchestrationSettleUntil?: string;
}

/**
 * Picks the single factoryState the caller should write. Priority is the
 * inverse of the previous spread order — the LAST spread wins in JS, so we
 * reverse that into a TOP-DOWN check:
 *
 *   1. explicit undelegation
 *   2. blocker-paused implementation (force back to `delegated`)
 *   3. fresh `desiredStage` decision (mark `delegated`)
 *      — but only if startupResume didn't already pick a state
 *   4. startup resume override
 *   5. new undelegated + agent-session fallback → `awaiting_input`
 *   6. no change
 */
export function resolveFactoryState(input: IssueUpdatePlanInputs): FactoryState | undefined {
  if (input.undelegation.factoryState) return input.undelegation.factoryState;
  if (input.blockerPausedImplementation) return "delegated";
  if (input.desiredStage && !input.startupResume.factoryState) return "delegated";
  if (input.startupResume.factoryState) return input.startupResume.factoryState;
  if (!input.existingIssue && !input.delegated && input.incomingAgentSessionId) {
    return "awaiting_input";
  }
  return undefined;
}

export function resolveIssueUpdatePlan(input: IssueUpdatePlanInputs): ResolvedIssueUpdate {
  const resolved: ResolvedIssueUpdate = {};

  const factoryState = resolveFactoryState(input);
  if (factoryState) {
    resolved.factoryState = factoryState;
  }

  if (input.effectiveRunRelease.release) {
    resolved.activeRunId = null;
  }

  if (input.agentSessionId !== undefined) {
    resolved.agentSessionId = input.agentSessionId;
  }

  if (input.shouldEnterOrchestrationSettle) {
    resolved.orchestrationSettleUntil = input.computeOrchestrationSettleUntil();
  }

  return resolved;
}
