import assert from "node:assert/strict";
import test from "node:test";
import { reconcileIssue, ReconciliationEngine } from "../src/reconciliation-engine.ts";
import type { CodexThreadSummary } from "../src/codex-types.ts";

test("reconciliation requests a launch when a desired stage exists without an active run", () => {
  const decision = reconcileIssue({
    issue: {
      projectId: "proj",
      linearIssueId: "issue-1",
      desiredStage: "development",
      lifecycleStatus: "queued",
    },
  });

  assert.equal(decision.outcome, "launch");
  assert.deepEqual(decision.actions, [
    {
      type: "launch_desired_stage",
      projectId: "proj",
      linearIssueId: "issue-1",
      stage: "development",
      reason: "desired stage exists without an active run",
    },
  ]);
});

test("reconciliation asks for live Linear and Codex state before evaluating an active run", () => {
  const decision = new ReconciliationEngine().reconcile({
    issue: {
      projectId: "proj",
      linearIssueId: "issue-1",
      lifecycleStatus: "running",
      activeRun: {
        id: 41,
        stage: "development",
        status: "running",
        threadId: "thread-1",
      },
    },
    policy: {
      activeLinearStateName: "Implementing",
      fallbackLinearStateName: "Human Needed",
    },
  });

  assert.equal(decision.outcome, "hydrate_live_state");
  assert.deepEqual(decision.actions, [
    {
      type: "read_linear_issue",
      projectId: "proj",
      linearIssueId: "issue-1",
      reason: "active reconciliation needs the live Linear state",
    },
    {
      type: "read_codex_thread",
      projectId: "proj",
      linearIssueId: "issue-1",
      runId: 41,
      threadId: "thread-1",
      reason: "active reconciliation needs the live Codex thread",
    },
  ]);
});

test("reconciliation fails back when the thread is missing and Linear still matches the active state", () => {
  const decision = reconcileIssue({
    issue: {
      projectId: "proj",
      linearIssueId: "issue-1",
      lifecycleStatus: "running",
      statusCommentId: "comment-7",
      activeRun: {
        id: 9,
        stage: "development",
        status: "running",
        threadId: "thread-1",
      },
    },
    policy: {
      activeLinearStateName: "Implementing",
      fallbackLinearStateName: "Human Needed",
    },
    live: {
      linear: {
        status: "known",
        issue: {
          id: "issue-1",
          stateName: "Implementing",
        },
      },
      codex: {
        status: "missing",
      },
    },
  });

  assert.equal(decision.outcome, "fail");
  assert.deepEqual(decision.actions, [
    {
      type: "mark_run_failed",
      projectId: "proj",
      linearIssueId: "issue-1",
      runId: 9,
      threadId: "thread-1",
      reason: "thread was not found during reconciliation",
    },
    {
      type: "sync_linear_failure",
      projectId: "proj",
      linearIssueId: "issue-1",
      runId: 9,
      expectedStateName: "Implementing",
      fallbackStateName: "Human Needed",
      message: "thread was not found during reconciliation",
    },
    {
      type: "clear_active_run",
      projectId: "proj",
      linearIssueId: "issue-1",
      runId: 9,
      nextLifecycleStatus: "failed",
      reason: "run failed while PatchRelay still owned the expected active Linear state",
    },
    {
      type: "refresh_status_comment",
      projectId: "proj",
      linearIssueId: "issue-1",
      runId: 9,
      commentId: "comment-7",
      mode: "failed",
      reason: "run failed and should refresh the service-owned status comment",
    },
  ]);
});

test("reconciliation releases ownership instead of failing back when Linear already moved on", () => {
  const decision = reconcileIssue({
    issue: {
      projectId: "proj",
      linearIssueId: "issue-1",
      lifecycleStatus: "running",
      activeRun: {
        id: 9,
        stage: "development",
        status: "running",
        threadId: "thread-1",
      },
    },
    policy: {
      activeLinearStateName: "Implementing",
      fallbackLinearStateName: "Human Needed",
    },
    live: {
      linear: {
        status: "known",
        issue: {
          id: "issue-1",
          stateName: "Review",
        },
      },
      codex: {
        status: "missing",
      },
    },
  });

  assert.equal(decision.outcome, "release");
  assert.deepEqual(decision.actions, [
    {
      type: "mark_run_failed",
      projectId: "proj",
      linearIssueId: "issue-1",
      runId: 9,
      threadId: "thread-1",
      reason: "thread was not found during reconciliation",
    },
    {
      type: "release_issue_ownership",
      projectId: "proj",
      linearIssueId: "issue-1",
      runId: 9,
      nextLifecycleStatus: "failed",
      reason: "run failed after the live Linear state moved on",
    },
  ]);
});

test("reconciliation routes and delivers pending obligations while the latest turn is in progress", () => {
  const decision = reconcileIssue({
    issue: {
      projectId: "proj",
      linearIssueId: "issue-1",
      lifecycleStatus: "running",
      activeRun: {
        id: 9,
        stage: "development",
        status: "running",
        threadId: "thread-1",
      },
    },
    obligations: [
      {
        id: 100,
        kind: "comment_input",
        status: "pending",
      },
    ],
    live: {
      codex: {
        status: "found",
        thread: createThread({ id: "turn-2", status: "inProgress" }),
      },
    },
  });

  assert.equal(decision.outcome, "continue");
  assert.deepEqual(decision.actions, [
    {
      type: "route_obligation",
      projectId: "proj",
      linearIssueId: "issue-1",
      obligationId: 100,
      runId: 9,
      threadId: "thread-1",
      turnId: "turn-2",
      reason: "pending obligation should target the latest live turn",
    },
    {
      type: "deliver_obligation",
      projectId: "proj",
      linearIssueId: "issue-1",
      obligationId: 100,
      runId: 9,
      threadId: "thread-1",
      turnId: "turn-2",
      reason: "pending obligation can be delivered to the active turn",
    },
    {
      type: "keep_run_active",
      projectId: "proj",
      linearIssueId: "issue-1",
      runId: 9,
      reason: "latest turn is still in progress",
    },
  ]);
});

test("reconciliation marks a completed run and pauses for handoff when Linear still matches the active state", () => {
  const decision = reconcileIssue({
    issue: {
      projectId: "proj",
      linearIssueId: "issue-1",
      lifecycleStatus: "running",
      statusCommentId: "comment-7",
      activeRun: {
        id: 9,
        stage: "development",
        status: "running",
        threadId: "thread-1",
      },
    },
    policy: {
      activeLinearStateName: "Implementing",
    },
    live: {
      linear: {
        status: "known",
        issue: {
          id: "issue-1",
          stateName: "Implementing",
        },
      },
      codex: {
        status: "found",
        thread: createThread({ id: "turn-2", status: "completed" }),
      },
    },
  });

  assert.equal(decision.outcome, "complete");
  assert.deepEqual(decision.actions, [
    {
      type: "mark_run_completed",
      projectId: "proj",
      linearIssueId: "issue-1",
      runId: 9,
      threadId: "thread-1",
      turnId: "turn-2",
      reason: "latest turn completed successfully during reconciliation",
    },
    {
      type: "clear_active_run",
      projectId: "proj",
      linearIssueId: "issue-1",
      runId: 9,
      nextLifecycleStatus: "paused",
      reason: "stage completed while the issue still matches the service-owned active Linear state",
    },
    {
      type: "refresh_status_comment",
      projectId: "proj",
      linearIssueId: "issue-1",
      runId: 9,
      commentId: "comment-7",
      mode: "awaiting_handoff",
      reason: "stage completed and should publish an awaiting handoff status",
    },
  ]);
});

function createThread(turn: { id: string; status: string }): CodexThreadSummary {
  return {
    id: "thread-1",
    preview: "preview",
    cwd: "/tmp/worktree",
    status: "ready",
    turns: [
      {
        id: turn.id,
        status: turn.status,
        items: [],
      },
    ],
  };
}
