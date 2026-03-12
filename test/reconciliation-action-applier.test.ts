import assert from "node:assert/strict";
import test from "node:test";
import { ReconciliationActionApplier } from "../src/reconciliation-action-applier.ts";
import type { ReconciliationDecision } from "../src/reconciliation-types.ts";
import type { ReconciliationSnapshot } from "../src/reconciliation-snapshot-builder.ts";
import type { CodexThreadSummary } from "../src/types.ts";

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
    completeRun: (_projectId, _linearIssueId, _thread, params) => {
      calls.completed = params;
    },
    failRunDuringReconciliation: async () => assert.fail("should not fail"),
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

  await applier.apply({ snapshot: createSnapshot(), decision });

  assert.deepEqual(calls.completed, {
    threadId: "thread-live",
    turnId: "turn-live",
    nextLifecycleStatus: "paused",
  });
});

test("reconciliation action applier fails a released run when the decision still carries mark_run_failed", async () => {
  const calls: { failed?: { threadId: string; message: string; turnId?: string } } = {};
  const applier = new ReconciliationActionApplier({
    enqueueIssue: () => assert.fail("should not enqueue"),
    deliverPendingObligations: async () => assert.fail("should not deliver obligations"),
    completeRun: () => assert.fail("should not complete"),
    failRunDuringReconciliation: async (_projectId, _linearIssueId, threadId, message, options) => {
      calls.failed = { threadId, message, ...(options?.turnId ? { turnId: options.turnId } : {}) };
    },
  });

  const decision: ReconciliationDecision = {
    outcome: "release",
    reasons: ["thread was not found during reconciliation"],
    actions: [
      {
        type: "mark_run_failed",
        projectId: "proj",
        linearIssueId: "issue-1",
        runId: 90,
        threadId: "thread-live",
        turnId: "turn-live",
        reason: "thread was not found during reconciliation",
      },
      {
        type: "release_issue_ownership",
        projectId: "proj",
        linearIssueId: "issue-1",
        runId: 90,
        nextLifecycleStatus: "failed",
        reason: "moved on",
      },
    ],
  };

  await applier.apply({ snapshot: createSnapshot(), decision });

  assert.deepEqual(calls.failed, {
    threadId: "thread-live",
    turnId: "turn-live",
    message: "thread was not found during reconciliation",
  });
});

test("reconciliation action applier treats release as successful completion", async () => {
  const calls: { completed?: { threadId: string; turnId?: string; nextLifecycleStatus?: string } } = {};
  const applier = new ReconciliationActionApplier({
    enqueueIssue: () => assert.fail("should not enqueue"),
    deliverPendingObligations: async () => assert.fail("should not deliver obligations"),
    completeRun: (_projectId, _linearIssueId, _thread, params) => {
      calls.completed = params;
    },
    failRunDuringReconciliation: async () => assert.fail("should not fail"),
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

  await applier.apply({ snapshot: createSnapshot(), decision });

  assert.deepEqual(calls.completed, {
    threadId: "thread-live",
    turnId: "turn-live",
    nextLifecycleStatus: "completed",
  });
});
