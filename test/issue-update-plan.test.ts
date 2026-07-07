import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveFactoryState,
  resolveIssueUpdatePlan,
  type IssueUpdatePlanInputs,
} from "../src/webhooks/issue-update-plan.ts";

const FIXED_SETTLE_UNTIL = "2026-05-15T11:00:00.000Z";

function baseInputs(overrides: Partial<IssueUpdatePlanInputs> = {}): IssueUpdatePlanInputs {
  return {
    existingIssue: true,
    delegated: true,
    incomingAgentSessionId: undefined,
    startupResume: { factoryState: undefined, workflowIntent: undefined },
    desiredStage: undefined,
    terminalRunRelease: false,
    blockerPausedImplementation: false,
    undelegation: { factoryState: undefined, clearPending: undefined },
    clearPending: false,
    effectiveRunRelease: { release: false },
    shouldEnterOrchestrationSettle: false,
    agentSessionId: undefined,
    computeOrchestrationSettleUntil: () => FIXED_SETTLE_UNTIL,
    ...overrides,
  };
}

test("resolveFactoryState: undelegation wins over everything", () => {
  const state = resolveFactoryState(baseInputs({
    undelegation: { factoryState: "awaiting_input" },
    blockerPausedImplementation: true,
    terminalRunRelease: true,
    desiredStage: "implementation",
    startupResume: { factoryState: "pr_open" },
  }));
  assert.equal(state, "awaiting_input");
});

test("resolveFactoryState: blockerPausedImplementation wins over terminal + desiredStage", () => {
  const state = resolveFactoryState(baseInputs({
    blockerPausedImplementation: true,
    terminalRunRelease: true,
    desiredStage: "implementation",
  }));
  assert.equal(state, "delegated");
});

test("resolveFactoryState: terminalRunRelease does not mark the issue done", () => {
  const state = resolveFactoryState(baseInputs({
    terminalRunRelease: true,
    desiredStage: "implementation",
    startupResume: { factoryState: "pr_open" },
  }));
  assert.equal(state, "pr_open");
});

test("resolveFactoryState: fresh desiredStage maps to delegated when startupResume is empty", () => {
  const state = resolveFactoryState(baseInputs({ desiredStage: "implementation" }));
  assert.equal(state, "delegated");
});

test("resolveFactoryState: startupResume wins over desiredStage when both present", () => {
  const state = resolveFactoryState(baseInputs({
    desiredStage: "implementation",
    startupResume: { factoryState: "pr_open" },
  }));
  assert.equal(state, "pr_open");
});

test("resolveFactoryState: new undelegated issue with agent session lands in awaiting_input", () => {
  const state = resolveFactoryState(baseInputs({
    existingIssue: false,
    delegated: false,
    incomingAgentSessionId: "session-1",
  }));
  assert.equal(state, "awaiting_input");
});

test("resolveFactoryState: no signals → no state change", () => {
  assert.equal(resolveFactoryState(baseInputs()), undefined);
});

test("resolveIssueUpdatePlan: desiredStage advances a fresh delegation without pending-column writes", () => {
  const plan = resolveIssueUpdatePlan(baseInputs({ desiredStage: "implementation" }));
  assert.equal(plan.factoryState, "delegated");
});

test("resolveIssueUpdatePlan: startup resume carries workflow intent without pending-column writes", () => {
  const plan = resolveIssueUpdatePlan(baseInputs({
    startupResume: {
      factoryState: "pr_open",
      workflowIntent: { kind: "run", runType: "review_fix", context: { reason: "operator_retry" } },
    },
  }));
  assert.equal(plan.factoryState, "pr_open");
});

test("resolveIssueUpdatePlan: startup resume without context does not write contextJson", () => {
  const plan = resolveIssueUpdatePlan(baseInputs({
    startupResume: { factoryState: "pr_open", workflowIntent: { kind: "run", runType: "review_fix" } },
  }));
});

test("resolveIssueUpdatePlan: clearPending alone is a no-op after pending-column removal", () => {
  const plan = resolveIssueUpdatePlan(baseInputs({ clearPending: true }));
  assert.equal(plan.factoryState, undefined);
});

test("resolveIssueUpdatePlan: terminal run release clears active run without pending-column writes", () => {
  const plan = resolveIssueUpdatePlan(baseInputs({
    terminalRunRelease: true,
    effectiveRunRelease: { release: true },
  }));
  assert.equal(plan.factoryState, undefined);
  assert.equal(plan.activeRunId, null);
});

test("resolveIssueUpdatePlan: effectiveRunRelease alone clears activeRunId without touching factoryState", () => {
  const plan = resolveIssueUpdatePlan(baseInputs({ effectiveRunRelease: { release: true } }));
  assert.equal(plan.activeRunId, null);
  assert.equal(plan.factoryState, undefined);
});

test("resolveIssueUpdatePlan: orchestration-settle window only set when shouldEnterOrchestrationSettle", () => {
  const without = resolveIssueUpdatePlan(baseInputs());
  assert.equal(without.orchestrationSettleUntil, undefined);

  const withSettle = resolveIssueUpdatePlan(baseInputs({ shouldEnterOrchestrationSettle: true }));
  assert.equal(withSettle.orchestrationSettleUntil, FIXED_SETTLE_UNTIL);
});

test("resolveIssueUpdatePlan: passes through agentSessionId including null for clearing", () => {
  const setOne = resolveIssueUpdatePlan(baseInputs({ agentSessionId: "session-7" }));
  assert.equal(setOne.agentSessionId, "session-7");

  const cleared = resolveIssueUpdatePlan(baseInputs({ agentSessionId: null }));
  assert.equal(cleared.agentSessionId, null);

  const noop = resolveIssueUpdatePlan(baseInputs({ agentSessionId: undefined }));
  assert.equal("agentSessionId" in noop, false);
});
