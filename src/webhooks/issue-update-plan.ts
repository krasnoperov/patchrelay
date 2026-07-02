import type { FactoryState, RunType } from "../factory-state.ts";
import { type RunContext } from "../run-context.ts";

/**
 * The 14-conditional-spread cascade inside DesiredStageRecorder.record was
 * structurally fragile: multiple branches all wrote to `factoryState`,
 * `pendingRunType`, and `pendingRunContextJson`, relying on JavaScript spread
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
    pendingRunType?: RunType | null | undefined;
    pendingRunContext?: RunContext | undefined;
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
  /** Any other condition that should clear the pending run (e.g. unresolved blockers). */
  clearPending: boolean;
  effectiveRunRelease: { release: boolean };
  shouldEnterOrchestrationSettle: boolean;
  agentSessionId?: string | null | undefined;
  /** Time provider for the orchestration-settle window — testable. */
  computeOrchestrationSettleUntil: () => string;
}

export interface ResolvedIssueUpdate {
  factoryState?: FactoryState;
  pendingRunType?: null;
  pendingRunContextJson?: string | null;
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

/**
 * Should we clear `pendingRunType` + `pendingRunContextJson`? Several upstream
 * conditions can independently request this; the resolver folds them into one
 * predicate.
 */
function shouldClearPending(input: IssueUpdatePlanInputs): boolean {
  if (input.terminalRunRelease) return true;
  if (input.clearPending) return true;
  if (input.desiredStage && !input.startupResume.factoryState) return true;
  if (input.startupResume.pendingRunType !== undefined) return true;
  return false;
}

export function resolveIssueUpdatePlan(input: IssueUpdatePlanInputs): ResolvedIssueUpdate {
  const resolved: ResolvedIssueUpdate = {};

  const factoryState = resolveFactoryState(input);
  if (factoryState) {
    resolved.factoryState = factoryState;
  }

  if (shouldClearPending(input)) {
    // S6: both legacy pending columns are always nulled now. The startup-resume
    // run context is no longer persisted here — the caller
    // (`DesiredStageRecorder.record`) folds a branch_upkeep resume into a
    // durable `github.parent_head_moved` observation and reconciles the run task.
    resolved.pendingRunType = null;
    resolved.pendingRunContextJson = null;
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
