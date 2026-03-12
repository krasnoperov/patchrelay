import assert from "node:assert/strict";
import test from "node:test";
import { ReconciliationActionApplier } from "../src/reconciliation-action-applier.ts";
import type { ReconciliationDecision } from "../src/reconciliation-types.ts";
import type { ReconciliationSnapshot } from "../src/reconciliation-snapshot-builder.ts";
import type { CodexThreadSummary, StageRunRecord, TrackedIssueRecord } from "../src/types.ts";

function createStageRun(overrides?: Partial<StageRunRecord>): StageRunRecord {
  return {
    id: 11,
    pipelineRunId: 7,
    projectId: "proj",
    linearIssueId: "issue-1",
    workspaceId: 4,
    stage: "development",
    status: "running",
    triggerWebhookId: "delivery-1",
    workflowFile: "workflows/development.md",
    promptText: "Implement carefully.",
    threadId: "thread-legacy",
    turnId: "turn-legacy",
    startedAt: "2026-03-12T00:00:00.000Z",
    ...overrides,
  };
}

function createIssue(overrides?: Partial<TrackedIssueRecord>): TrackedIssueRecord {
  return {
    projectId: "proj",
    linearIssueId: "issue-1",
    issueKey: "APP-1",
    lifecycleStatus: "running",
    ...overrides,
  };
}

function createThread(status: "inProgress" | "completed" | "failed"): CodexThreadSummary {
  return {
    id: "thread-live",
    turns: [
      {
        id: "turn-live",
        status,
        cwd: "/tmp/worktree",
        approvalPolicy: "on-failure",
        sandboxPolicy: { mode: "workspace-write" },
      },
    ],
  };
}

function createSnapshot(): ReconciliationSnapshot {
  return {
    issueControl: {
      id: 1,
      projectId: "proj",
      linearIssueId: "issue-1",
      lifecycleStatus: "running",
      updatedAt: "2026-03-12T00:00:00.000Z",
    },
    runLease: {
      id: 90,
      issueControlId: 1,
      projectId: "proj",
      linearIssueId: "issue-1",
      workspaceOwnershipId: 40,
      stage: "development",
      status: "running",
      threadId: "thread-live",
      turnId: "turn-live",
      startedAt: "2026-03-12T00:00:00.000Z",
    },
    input: {
      issue: {
        projectId: "proj",
        linearIssueId: "issue-1",
        lifecycleStatus: "running",
        activeRun: {
          id: 90,
          stage: "development",
          status: "running",
          threadId: "thread-live",
          turnId: "turn-live",
        },
      },
      live: {
        codex: {
          status: "found",
          thread: createThread("completed"),
        },
      },
    },
  };
}

test("reconciliation action applier completes a stage using the live codex thread", async () => {
  const calls: { completed?: { threadId: string; turnId?: string; nextLifecycleStatus?: string } } = {};
  const applier = new ReconciliationActionApplier({
    enqueueIssue: () => assert.fail("should not enqueue"),
    deliverPendingObligations: async () => assert.fail("should not deliver obligations"),
    completeStageRun: (_stageRun, _issue, _thread, _status, params) => {
      calls.completed = params;
    },
    failStageRunDuringReconciliation: async () => assert.fail("should not fail"),
  });

  const decision: ReconciliationDecision = {
    outcome: "complete",
    reasons: ["completed"],
    actions: [
      {
        type: "mark_run_completed",
        projectId: "proj",
        linearIssueId: "issue-1",
        runId: 90,
        threadId: "thread-live",
        turnId: "turn-live",
        reason: "completed",
      },
      {
        type: "clear_active_run",
        projectId: "proj",
        linearIssueId: "issue-1",
        runId: 90,
        nextLifecycleStatus: "paused",
        reason: "handoff",
      },
    ],
  };

  await applier.apply({
    snapshot: createSnapshot(),
    decision,
    stageRun: createStageRun(),
    issue: createIssue(),
  });

  assert.deepEqual(calls.completed, {
    threadId: "thread-live",
    turnId: "turn-live",
    nextLifecycleStatus: "paused",
  });
});

test("reconciliation action applier treats release as successful completion", async () => {
  const calls: { completed?: { threadId: string; turnId?: string; nextLifecycleStatus?: string } } = {};
  const applier = new ReconciliationActionApplier({
    enqueueIssue: () => assert.fail("should not enqueue"),
    deliverPendingObligations: async () => assert.fail("should not deliver obligations"),
    completeStageRun: (_stageRun, _issue, _thread, _status, params) => {
      calls.completed = params;
    },
    failStageRunDuringReconciliation: async () => assert.fail("should not fail"),
  });

  const decision: ReconciliationDecision = {
    outcome: "release",
    reasons: ["completed after Linear moved on"],
    actions: [
      {
        type: "mark_run_completed",
        projectId: "proj",
        linearIssueId: "issue-1",
        runId: 90,
        threadId: "thread-live",
        turnId: "turn-live",
        reason: "completed",
      },
      {
        type: "release_issue_ownership",
        projectId: "proj",
        linearIssueId: "issue-1",
        runId: 90,
        nextLifecycleStatus: "completed",
        reason: "release",
      },
    ],
  };

  await applier.apply({
    snapshot: createSnapshot(),
    decision,
    stageRun: createStageRun(),
    issue: createIssue(),
  });

  assert.deepEqual(calls.completed, {
    threadId: "thread-live",
    turnId: "turn-live",
    nextLifecycleStatus: "completed",
  });
});
