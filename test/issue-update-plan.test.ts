import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveIssueUpdatePlan,
  type IssueUpdatePlanInputs,
} from "../src/webhooks/issue-update-plan.ts";

const FIXED_SETTLE_UNTIL = "2026-05-15T11:00:00.000Z";

function baseInputs(overrides: Partial<IssueUpdatePlanInputs> = {}): IssueUpdatePlanInputs {
  return {
    existingIssue: true,
    existingInputRequestKind: undefined,
    delegated: true,
    incomingAgentSessionId: undefined,
    startupResume: { workflowIntent: undefined },
    desiredStage: undefined,
    blockerPausedImplementation: false,
    undelegation: { paused: false, clearPending: undefined },
    effectiveRunRelease: { release: false },
    shouldEnterOrchestrationSettle: false,
    agentSessionId: undefined,
    computeOrchestrationSettleUntil: () => FIXED_SETTLE_UNTIL,
    ...overrides,
  };
}

test("fresh runnable work clears terminal and input facts", () => {
  const plan = resolveIssueUpdatePlan(baseInputs({ desiredStage: "implementation" }));
  assert.deepEqual(plan, {
    workflowOutcome: null,
    workflowOutcomeReason: null,
    inputRequestKind: null,
  });
});

test("startup resume clears terminal and input facts", () => {
  const plan = resolveIssueUpdatePlan(baseInputs({
    startupResume: { workflowIntent: { kind: "run", runType: "review_fix" } },
  }));
  assert.deepEqual(plan, {
    workflowOutcome: null,
    workflowOutcomeReason: null,
    inputRequestKind: null,
  });
});

test("a new undelegated session records paused local work", () => {
  const plan = resolveIssueUpdatePlan(baseInputs({
    existingIssue: false,
    delegated: false,
    incomingAgentSessionId: "session-1",
  }));
  assert.deepEqual(plan, { inputRequestKind: "paused_local_work" });
});

test("delegation clears a paused-local-work request even while blockers prevent dispatch", () => {
  const plan = resolveIssueUpdatePlan(baseInputs({
    delegated: true,
    existingInputRequestKind: "paused_local_work",
  }));
  assert.deepEqual(plan, {
    workflowOutcome: null,
    workflowOutcomeReason: null,
    inputRequestKind: null,
  });
});

test("no durable fact changes produce an empty update", () => {
  assert.deepEqual(resolveIssueUpdatePlan(baseInputs()), {});
});

test("run release clears only the active run slot", () => {
  const plan = resolveIssueUpdatePlan(baseInputs({ effectiveRunRelease: { release: true } }));
  assert.deepEqual(plan, { activeRunId: null });
});

test("orchestration settle and session facts pass through", () => {
  const plan = resolveIssueUpdatePlan(baseInputs({
    shouldEnterOrchestrationSettle: true,
    agentSessionId: "session-7",
  }));
  assert.deepEqual(plan, {
    agentSessionId: "session-7",
    orchestrationSettleUntil: FIXED_SETTLE_UNTIL,
  });
});
