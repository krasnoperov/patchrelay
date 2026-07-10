import assert from "node:assert/strict";
import test from "node:test";
import type { LinkedPrAdoptionOutcome } from "../src/delegation-linked-pr.ts";
import type { IssueRecord } from "../src/types.ts";
import { planIssueWebhookWorkflow, type IssueWebhookWorkflowPlannerInput } from "../src/webhooks/issue-webhook-workflow-planner.ts";

const UPDATED_AT = "2026-05-23T10:00:00.000Z";
const SETTLE_UNTIL = "2026-05-23T10:01:00.000Z";

function issue(overrides: Partial<IssueRecord> = {}): IssueRecord {
  return {
    id: 1,
    projectId: "project-1",
    linearIssueId: "issue-1",
    delegatedToPatchRelay: true,
    factoryState: "delegated",
    ciRepairAttempts: 0,
    queueRepairAttempts: 0,
    reviewFixAttempts: 0,
    zombieRecoveryAttempts: 0,
    updatedAt: UPDATED_AT,
    ...overrides,
  };
}

function baseInput(overrides: Partial<IssueWebhookWorkflowPlannerInput> = {}): IssueWebhookWorkflowPlannerInput {
  return {
    existingIssue: issue(),
    hydratedIssue: {
      id: "issue-1",
      identifier: "PR-1",
      title: "Implement thing",
      labelNames: [],
      blockedBy: [],
      blocks: [],
    },
    delegated: true,
    triggerAllowed: true,
    triggerEvent: "delegateChanged",
    unresolvedBlockers: 0,
    hasActiveRun: false,
    activeRunType: undefined,
    hasRunnableWorkflowTask: false,
    existingWorkflowTaskRunType: undefined,
    incomingAgentSessionId: undefined,
    childIssueCount: 0,
    computeOrchestrationSettleUntil: () => SETTLE_UNTIL,
    ...overrides,
  };
}

test("plans fresh delegated issue implementation without pending-column writes", () => {
  const plan = planIssueWebhookWorkflow(baseInput());

  assert.equal(plan.desiredStage, "implementation");
  assert.equal(plan.resolvedIssueUpdate.factoryState, "delegated");
  assert.equal(plan.startupResume.workflowIntent, undefined);
});

test("linked PR adoption suppresses fresh implementation startup", () => {
  const linkedPrAdoption: LinkedPrAdoptionOutcome = {
    factoryState: "pr_open",
    issueUpdates: { prNumber: 42, prState: "open" },
  };

  const plan = planIssueWebhookWorkflow(baseInput({ linkedPrAdoption }));

  assert.equal(plan.desiredStage, undefined);
  assert.equal(plan.startupResume.source, "linked_pr_adoption");
  assert.equal(plan.resolvedIssueUpdate.factoryState, "pr_open");
});

test("undelegation preserves current nonterminal state and clears pending", () => {
  const plan = planIssueWebhookWorkflow(baseInput({
    delegated: false,
    existingIssue: issue({ factoryState: "pr_open", delegatedToPatchRelay: true }),
    triggerEvent: "delegateChanged",
    triggerAllowed: true,
    existingWorkflowTaskRunType: "review_fix",
    hasRunnableWorkflowTask: true,
  }));

  assert.equal(plan.undelegation.factoryState, "pr_open");
  assert.equal(plan.clearPending, true);
  assert.equal(plan.resolvedIssueUpdate.factoryState, "pr_open");
});

test("undelegation stops active work even when discovered from a status webhook", () => {
  const plan = planIssueWebhookWorkflow(baseInput({
    delegated: false,
    existingIssue: issue({ factoryState: "implementing", delegatedToPatchRelay: true }),
    triggerEvent: "statusChanged",
    triggerAllowed: true,
    hasActiveRun: true,
    activeRunType: "implementation",
    hasRunnableWorkflowTask: true,
  }));

  assert.deepEqual(plan.effectiveRunRelease, {
    release: true,
    reason: "Un-delegated from PatchRelay",
  });
  assert.equal(plan.undelegation.factoryState, "implementing");
  assert.equal(plan.clearPending, true);
  assert.equal(plan.resolvedIssueUpdate.activeRunId, null);
});

test("blocked active implementation releases the run and returns to delegated", () => {
  const plan = planIssueWebhookWorkflow(baseInput({
    unresolvedBlockers: 1,
    hasActiveRun: true,
    activeRunType: "implementation",
  }));

  assert.equal(plan.blockerPausedImplementation, true);
  assert.deepEqual(plan.effectiveRunRelease, {
    release: true,
    reason: "Issue became blocked during implementation",
  });
  assert.equal(plan.resolvedIssueUpdate.factoryState, "delegated");
  assert.equal(plan.resolvedIssueUpdate.activeRunId, null);
});

test("orchestration classification enters settle only for empty orchestrations ready to start", () => {
  const plan = planIssueWebhookWorkflow(baseInput({
    hydratedIssue: {
      id: "issue-1",
      identifier: "PR-1",
      title: "Plan only, no code: create child issues",
      description: "No code needed here; break this down into child issues.",
      labelNames: [],
      blockedBy: [],
      blocks: [],
    },
  }));

  assert.equal(plan.classification.issueClass, "orchestration");
  assert.equal(plan.desiredStage, "implementation");
  assert.equal(plan.shouldEnterOrchestrationSettle, true);
  assert.equal(plan.resolvedIssueUpdate.orchestrationSettleUntil, SETTLE_UNTIL);

  const withChildren = planIssueWebhookWorkflow(baseInput({
    childIssueCount: 1,
    hydratedIssue: {
      id: "issue-1",
      identifier: "PR-1",
      title: "Parent issue",
      labelNames: [],
      blockedBy: [],
      blocks: [],
    },
  }));
  assert.equal(withChildren.classification.issueClass, "orchestration");
  assert.equal(withChildren.shouldEnterOrchestrationSettle, false);
});
