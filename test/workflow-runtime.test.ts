import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import pino from "pino";
import { PatchRelayDatabase } from "../src/db.ts";
import { peekPendingWakeRunType } from "../src/pending-wake.ts";
import type { IssueRecord } from "../src/db-types.ts";
import {
  evaluateTaskCompletion,
  evaluateTaskStart,
  projectWorkflowSnapshot,
} from "../src/workflow-runtime.ts";
import { reconcileWorkflowTasksForIssue } from "../src/workflow-task-reconciler.ts";
import { RunWakePlanner } from "../src/run-wake-planner.ts";
import { WakeDispatcher } from "../src/wake-dispatcher.ts";
import { wakeOrchestrationParentsForChildEvent } from "../src/orchestration-parent-wake.ts";

function createDb(): { db: PatchRelayDatabase; cleanup: () => void } {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-v2-runtime-"));
  const db = new PatchRelayDatabase(path.join(baseDir, "patchrelay.sqlite"), true);
  db.runMigrations();
  return {
    db,
    cleanup: () => {
      db.close();
      rmSync(baseDir, { recursive: true, force: true });
    },
  };
}

function makeIssue(db: PatchRelayDatabase, patch: Partial<IssueRecord> = {}): IssueRecord {
  const projectId = patch.projectId ?? "usertold";
  const linearIssueId = patch.linearIssueId ?? "issue-1";
  return db.issueSessions.commitIssueState({
    writer: "workflow-runtime-test",
    update: {
      projectId,
      linearIssueId,
      issueKey: "USE-1",
      title: "Implement the thing",
      factoryState: "delegated",
      delegatedToPatchRelay: true,
      ...patch,
    },
  }).outcome === "applied"
    ? db.getIssue(projectId, linearIssueId)!
    : assert.fail("issue commit failed");
}

test("workflow observations are append-only and deduped by source subject key", () => {
  const { db, cleanup } = createDb();
  try {
    const first = db.workflowObservations.appendObservation({
      projectId: "usertold",
      subjectId: "issue-1",
      source: "linear",
      type: "linear.delegated",
      payloadJson: JSON.stringify({ delegated: true }),
      dedupeKey: "linear:issue-1:delegated:1",
      observedAt: "2026-06-14T10:00:00.000Z",
    });
    const duplicate = db.workflowObservations.appendObservation({
      projectId: "usertold",
      subjectId: "issue-1",
      source: "linear",
      type: "linear.delegated",
      payloadJson: JSON.stringify({ delegated: true }),
      dedupeKey: "linear:issue-1:delegated:1",
      observedAt: "2026-06-14T10:01:00.000Z",
    });

    assert.equal(duplicate.id, first.id);
    assert.equal(db.workflowObservations.listObservations("usertold", "issue-1").length, 1);
  } finally {
    cleanup();
  }
});

test("workflow projection derives authority epoch from delegation churn", () => {
  const { db, cleanup } = createDb();
  try {
    const issue = makeIssue(db);
    db.workflowObservations.appendObservation({
      projectId: issue.projectId,
      subjectId: issue.linearIssueId,
      source: "linear",
      type: "linear.delegated",
      payloadJson: JSON.stringify({ delegated: true }),
      observedAt: "2026-06-14T10:00:00.000Z",
    });
    db.workflowObservations.appendObservation({
      projectId: issue.projectId,
      subjectId: issue.linearIssueId,
      source: "linear",
      type: "linear.undelegated",
      payloadJson: JSON.stringify({ delegated: false }),
      observedAt: "2026-06-14T10:01:00.000Z",
    });

    const snapshot = projectWorkflowSnapshot({
      issue,
      observations: db.workflowObservations.listObservations(issue.projectId, issue.linearIssueId),
    });

    assert.equal(snapshot.authority.delegated, false);
    assert.equal(snapshot.authority.epoch, 2);
    assert.equal(snapshot.openTasks[0]?.id, "wait:authority");
  } finally {
    cleanup();
  }
});

test("implementation task waits when blockers are unresolved", () => {
  const { db, cleanup } = createDb();
  try {
    const issue = makeIssue(db);
    const snapshot = projectWorkflowSnapshot({ issue, blockerCount: 1 });

    assert.equal(snapshot.openTasks[0]?.id, "wait:blockers");
    assert.equal(evaluateTaskStart(snapshot, {
      id: "run:implementation",
      type: "run",
      runType: "implementation",
      reason: "test",
    }).action, "wait");
  } finally {
    cleanup();
  }
});

test("implementation task preserves Linear delegation prompt context", () => {
  const { db, cleanup } = createDb();
  try {
    const issue = makeIssue(db);
    db.workflowObservations.appendObservation({
      projectId: issue.projectId,
      subjectId: issue.linearIssueId,
      source: "linear",
      type: "linear.delegated",
      payloadJson: JSON.stringify({
        delegated: true,
        promptContext: "Use the customer report as the source of truth.",
        promptBody: "Please implement this carefully.",
      }),
    });

    const snapshot = projectWorkflowSnapshot({
      issue,
      observations: db.workflowObservations.listObservations(issue.projectId, issue.linearIssueId),
    });
    const task = snapshot.openTasks[0];

    assert.equal(task?.id, "run:implementation");
    assert.equal(task?.requirements?.promptContext, "Use the customer report as the source of truth.");
    assert.equal(task?.requirements?.promptBody, "Please implement this carefully.");
  } finally {
    cleanup();
  }
});

test("review fix completion blocks same-head handoff", () => {
  const { db, cleanup } = createDb();
  try {
    const issue = makeIssue(db, {
      prNumber: 42,
      prState: "open",
      prHeadSha: "abc123",
      prReviewState: "changes_requested",
      lastBlockingReviewHeadSha: "abc123",
    });
    const snapshot = projectWorkflowSnapshot({ issue });
    const task = snapshot.openTasks[0];

    assert.equal(task?.id, "run:review_fix");
    assert.equal(evaluateTaskStart(snapshot, task!).action, "start");
    assert.deepEqual(evaluateTaskCompletion(snapshot, task!), {
      action: "escalate",
      reason: "same_head_review_handoff_blocked",
    });
  } finally {
    cleanup();
  }
});

test("review fix task preserves requested-changes observation context", () => {
  const { db, cleanup } = createDb();
  try {
    const issue = makeIssue(db, {
      prNumber: 42,
      prState: "open",
      prHeadSha: "abc123",
      prReviewState: "changes_requested",
      lastBlockingReviewHeadSha: "abc123",
    });
    db.workflowObservations.appendObservation({
      projectId: issue.projectId,
      subjectId: issue.linearIssueId,
      source: "github",
      type: "github.review_changes_requested",
      payloadJson: JSON.stringify({
        requestedChangesContext: {
          requestedChangesHeadSha: "abc123",
          reviewId: 901,
          reviewCommitId: "abc123",
          reviewUrl: "https://github.com/owner/repo/pull/42#pullrequestreview-901",
          reviewerName: "reviewbot",
          reviewComments: [{
            id: 71,
            body: "Please keep the saved context.",
            path: "src/app.ts",
            line: 12,
          }],
        },
      }),
    });

    const snapshot = projectWorkflowSnapshot({
      issue,
      observations: db.workflowObservations.listObservations(issue.projectId, issue.linearIssueId),
    });
    const task = snapshot.openTasks[0];

    assert.equal(task?.id, "run:review_fix");
    assert.equal(task?.requirements?.reviewId, 901);
    assert.equal(task?.requirements?.reviewerName, "reviewbot");
    assert.deepEqual(task?.requirements?.reviewComments, [{
      id: 71,
      body: "Please keep the saved context.",
      path: "src/app.ts",
      line: 12,
    }]);
  } finally {
    cleanup();
  }
});

test("stale requested-changes aggregate waits after review fix pushed a new head", () => {
  const { db, cleanup } = createDb();
  try {
    const issue = makeIssue(db, {
      prNumber: 42,
      prState: "open",
      prHeadSha: "new-head",
      prReviewState: "changes_requested",
      lastBlockingReviewHeadSha: "old-reviewed-head",
    });
    db.workflowObservations.appendObservation({
      projectId: issue.projectId,
      subjectId: issue.linearIssueId,
      source: "github",
      type: "github.review_changes_requested",
      payloadJson: JSON.stringify({
        requestedChangesContext: {
          requestedChangesHeadSha: "old-reviewed-head",
          reviewId: 901,
          reviewCommitId: "old-reviewed-head",
        },
      }),
    });

    const snapshot = projectWorkflowSnapshot({
      issue,
      observations: db.workflowObservations.listObservations(issue.projectId, issue.linearIssueId),
    });

    assert.equal(snapshot.openTasks.some((task) => task.id === "run:review_fix"), false);
  } finally {
    cleanup();
  }
});

test("parent head moved derives a branch_upkeep task carrying upkeep context", () => {
  const { db, cleanup } = createDb();
  try {
    const issue = makeIssue(db, {
      factoryState: "pr_open",
      prNumber: 101,
      prState: "open",
      prHeadSha: "child-head-1",
    });
    db.workflowObservations.appendObservation({
      projectId: issue.projectId,
      subjectId: issue.linearIssueId,
      source: "github",
      type: "github.parent_head_moved",
      payloadJson: JSON.stringify({
        parentBranch: "feat/parent",
        parentHeadSha: "parent-head-2",
        childPrNumber: 101,
        childHeadSha: "child-head-1",
      }),
      dedupeKey: "branch_upkeep:issue-1:parent-head-2",
    });

    const snapshot = projectWorkflowSnapshot({
      issue,
      observations: db.workflowObservations.listObservations(issue.projectId, issue.linearIssueId),
    });
    const task = snapshot.openTasks[0];

    assert.equal(task?.id, "run:branch_upkeep");
    assert.equal(task?.runType, "branch_upkeep");
    assert.equal(task?.requirements?.branchUpkeepRequired, true);
    assert.equal(task?.requirements?.reviewFixMode, "branch_upkeep");
    assert.equal(task?.requirements?.baseBranch, "feat/parent");
    assert.equal(task?.requirements?.childPrNumber, 101);
    assert.equal(evaluateTaskStart(snapshot, task!).action, "start");
    assert.equal(evaluateTaskCompletion(snapshot, task!).action, "start");
  } finally {
    cleanup();
  }
});

test("branch_upkeep task closes once the child head advances past the moved parent", () => {
  const { db, cleanup } = createDb();
  try {
    const issue = makeIssue(db, {
      factoryState: "pr_open",
      prNumber: 101,
      prState: "open",
      prHeadSha: "child-head-1",
    });
    db.workflowObservations.appendObservation({
      projectId: issue.projectId,
      subjectId: issue.linearIssueId,
      source: "github",
      type: "github.parent_head_moved",
      payloadJson: JSON.stringify({
        parentBranch: "feat/parent",
        parentHeadSha: "parent-head-2",
        childPrNumber: 101,
        childHeadSha: "child-head-1",
      }),
      dedupeKey: "branch_upkeep:issue-1:parent-head-2",
    });

    const first = reconcileWorkflowTasksForIssue(db, issue);
    assert.equal(first.result.open.some((task) => task.taskId === "run:branch_upkeep"), true);
    assert.equal(
      db.workflowTasks.listOpenRunnableTasks(issue.projectId)
        .some((task) => task.subjectId === issue.linearIssueId && task.taskId === "run:branch_upkeep"),
      true,
    );

    // The child rebases: its own head advances past the head that was current
    // when the parent moved, so the branch_upkeep fact no longer holds and the
    // task self-closes on the next reconcile.
    db.issueSessions.commitIssueState({
      writer: "workflow-runtime-test",
      update: { projectId: issue.projectId, linearIssueId: issue.linearIssueId, prHeadSha: "child-head-2" },
    });
    const advanced = db.getIssue(issue.projectId, issue.linearIssueId)!;
    const second = reconcileWorkflowTasksForIssue(db, advanced);

    assert.equal(second.result.open.some((task) => task.taskId === "run:branch_upkeep"), false);
    assert.equal(
      db.workflowTasks.listOpenRunnableTasks(issue.projectId)
        .some((task) => task.subjectId === issue.linearIssueId && task.taskId === "run:branch_upkeep"),
      false,
    );
  } finally {
    cleanup();
  }
});

test("queue eviction outranks a pending branch_upkeep signal", () => {
  const { db, cleanup } = createDb();
  try {
    const issue = makeIssue(db, {
      factoryState: "pr_open",
      prNumber: 101,
      prState: "open",
      prHeadSha: "child-head-1",
      lastGitHubFailureSource: "queue_eviction",
      lastGitHubFailureHeadSha: "child-head-1",
      lastGitHubFailureSignature: "queue:evicted",
    });
    db.workflowObservations.appendObservation({
      projectId: issue.projectId,
      subjectId: issue.linearIssueId,
      source: "github",
      type: "github.parent_head_moved",
      payloadJson: JSON.stringify({
        parentBranch: "feat/parent",
        parentHeadSha: "parent-head-2",
        childPrNumber: 101,
        childHeadSha: "child-head-1",
      }),
      dedupeKey: "branch_upkeep:issue-1:parent-head-2",
    });

    const snapshot = projectWorkflowSnapshot({
      issue,
      observations: db.workflowObservations.listObservations(issue.projectId, issue.linearIssueId),
    });

    assert.equal(snapshot.openTasks[0]?.id, "run:queue_repair");
    assert.equal(snapshot.openTasks.some((task) => task.id === "run:branch_upkeep"), false);
  } finally {
    cleanup();
  }
});

test("settled red CI outranks a pending branch_upkeep signal", () => {
  const { db, cleanup } = createDb();
  try {
    const issue = makeIssue(db, {
      factoryState: "pr_open",
      prNumber: 101,
      prState: "open",
      prHeadSha: "child-head-1",
      prCheckStatus: "failed",
      lastGitHubFailureSource: "branch_ci",
      lastGitHubFailureHeadSha: "child-head-1",
      lastGitHubFailureSignature: "ci:unit-tests",
    });
    db.workflowObservations.appendObservation({
      projectId: issue.projectId,
      subjectId: issue.linearIssueId,
      source: "github",
      type: "github.parent_head_moved",
      payloadJson: JSON.stringify({
        parentBranch: "feat/parent",
        parentHeadSha: "parent-head-2",
        childPrNumber: 101,
        childHeadSha: "child-head-1",
      }),
      dedupeKey: "branch_upkeep:issue-1:parent-head-2",
    });

    const snapshot = projectWorkflowSnapshot({
      issue,
      observations: db.workflowObservations.listObservations(issue.projectId, issue.linearIssueId),
    });

    assert.equal(snapshot.openTasks[0]?.id, "run:ci_repair");
    assert.equal(snapshot.openTasks.some((task) => task.id === "run:branch_upkeep"), false);
  } finally {
    cleanup();
  }
});

test("branch_upkeep outranks review_fix when both signals are present", () => {
  const { db, cleanup } = createDb();
  try {
    const issue = makeIssue(db, {
      factoryState: "pr_open",
      prNumber: 101,
      prState: "open",
      prHeadSha: "child-head-1",
      prReviewState: "changes_requested",
      lastBlockingReviewHeadSha: "child-head-1",
    });
    db.workflowObservations.appendObservation({
      projectId: issue.projectId,
      subjectId: issue.linearIssueId,
      source: "github",
      type: "github.parent_head_moved",
      payloadJson: JSON.stringify({
        parentBranch: "feat/parent",
        parentHeadSha: "parent-head-2",
        childPrNumber: 101,
        childHeadSha: "child-head-1",
      }),
      dedupeKey: "branch_upkeep:issue-1:parent-head-2",
    });

    const snapshot = projectWorkflowSnapshot({
      issue,
      observations: db.workflowObservations.listObservations(issue.projectId, issue.linearIssueId),
    });

    assert.equal(snapshot.openTasks[0]?.id, "run:branch_upkeep");
    assert.equal(snapshot.openTasks.some((task) => task.id === "run:review_fix"), false);
  } finally {
    cleanup();
  }
});

test("settled PR check failure derives a CI repair task", () => {
  const { db, cleanup } = createDb();
  try {
    const issue = makeIssue(db, {
      prNumber: 42,
      prState: "open",
      prHeadSha: "abc123",
      prCheckStatus: "failed",
      lastGitHubFailureSource: "branch_ci",
      lastGitHubFailureHeadSha: "abc123",
      lastGitHubFailureSignature: "ci:unit-tests",
      lastGitHubFailureCheckName: "verify",
      lastGitHubFailureContextJson: JSON.stringify({
        checkName: "verify",
        jobName: "unit",
        stepName: "pnpm test",
        summary: "Unit tests failed",
      }),
      lastGitHubCiSnapshotJson: JSON.stringify({
        headSha: "abc123",
        gateCheckName: "verify",
        gateCheckStatus: "failure",
        failedChecks: [{ name: "verify", status: "failure", conclusion: "failure" }],
        checks: [{ name: "verify", status: "failure", conclusion: "failure" }],
        capturedAt: "2026-06-14T10:00:00.000Z",
      }),
    });
    const snapshot = projectWorkflowSnapshot({ issue });
    const task = snapshot.openTasks[0];

    assert.equal(task?.id, "run:ci_repair");
    assert.equal(task?.runType, "ci_repair");
    assert.deepEqual(task?.requirements, {
      failureReason: "branch_ci",
      failureSignature: "ci:unit-tests",
      failureHeadSha: "abc123",
      checkName: "verify",
      jobName: "unit",
      stepName: "pnpm test",
      summary: "Unit tests failed",
      ciSnapshot: {
        headSha: "abc123",
        gateCheckName: "verify",
        gateCheckStatus: "failure",
        failedChecks: [{ name: "verify", status: "failure", conclusion: "failure" }],
        checks: [{ name: "verify", status: "failure", conclusion: "failure" }],
        capturedAt: "2026-06-14T10:00:00.000Z",
      },
    });
    assert.equal(evaluateTaskStart(snapshot, task!).action, "start");
  } finally {
    cleanup();
  }
});

test("settled red CI already attempted at the current head derives no CI repair task", () => {
  // Folds the deleted implicit-resolver dedupe: once the same failure
  // signature has been attempted against the same head, re-derivation must
  // not re-route another ci_repair run until the head or signature moves.
  const { db, cleanup } = createDb();
  try {
    const issue = makeIssue(db, {
      prNumber: 42,
      prState: "open",
      prHeadSha: "abc123",
      prCheckStatus: "failed",
      lastGitHubFailureSource: "branch_ci",
      lastGitHubFailureHeadSha: "abc123",
      lastGitHubFailureSignature: "ci:unit-tests",
      lastAttemptedFailureHeadSha: "abc123",
      lastAttemptedFailureSignature: "ci:unit-tests",
    });
    const snapshot = projectWorkflowSnapshot({ issue });

    assert.equal(
      snapshot.openTasks.some((task) => task.id === "run:ci_repair"),
      false,
    );
  } finally {
    cleanup();
  }
});

test("CI repair completion defers same-head judgment to remote verification", () => {
  const { db, cleanup } = createDb();
  try {
    const issue = makeIssue(db, {
      prNumber: 42,
      prState: "open",
      prHeadSha: "abc123",
      lastGitHubFailureSource: "branch_ci",
      lastGitHubFailureHeadSha: "abc123",
      lastGitHubFailureSignature: "ci:unit-tests",
    });
    const snapshot = projectWorkflowSnapshot({ issue });
    const task = snapshot.openTasks[0];

    assert.equal(task?.id, "run:ci_repair");
    assert.deepEqual(evaluateTaskCompletion(snapshot, task!), { action: "start" });
  } finally {
    cleanup();
  }
});

test("CI repair completion accepts a head advanced beyond the failing head", () => {
  const { db, cleanup } = createDb();
  try {
    const issue = makeIssue(db, {
      prNumber: 42,
      prState: "open",
      prHeadSha: "abc123",
      lastGitHubFailureSource: "branch_ci",
      lastGitHubFailureHeadSha: "abc123",
      lastGitHubFailureSignature: "ci:unit-tests",
    });
    const task = projectWorkflowSnapshot({ issue }).openTasks[0]!;
    const advanced = makeIssue(db, {
      prNumber: 42,
      prState: "open",
      prHeadSha: "def456",
      lastGitHubFailureSource: "branch_ci",
      lastGitHubFailureHeadSha: "abc123",
      lastGitHubFailureSignature: "ci:unit-tests",
    });
    const advancedSnapshot = projectWorkflowSnapshot({ issue: advanced });

    assert.deepEqual(evaluateTaskCompletion(advancedSnapshot, task), { action: "start" });
  } finally {
    cleanup();
  }
});

test("merge queue eviction derives a queue repair task", () => {
  const { db, cleanup } = createDb();
  try {
    const issue = makeIssue(db, {
      prNumber: 42,
      prState: "open",
      prHeadSha: "abc123",
      prCheckStatus: "success",
      lastGitHubFailureSource: "queue_eviction",
      lastGitHubFailureHeadSha: "abc123",
      lastGitHubFailureSignature: "merge-queue:evicted",
      lastGitHubFailureContextJson: JSON.stringify({
        checkName: "merge-steward",
        summary: "Evicted from queue",
      }),
      lastQueueIncidentJson: JSON.stringify({
        failureReason: "queue_eviction",
        incidentSummary: "Base branch moved",
        incidentContext: {
          baseSha: "base-1",
          prHeadSha: "abc123",
          queuePosition: 3,
        },
      }),
    });
    const snapshot = projectWorkflowSnapshot({ issue });
    const task = snapshot.openTasks[0];

    assert.equal(task?.id, "run:queue_repair");
    assert.equal(task?.runType, "queue_repair");
    assert.deepEqual(task?.requirements, {
      failureReason: "queue_eviction",
      failureSignature: "merge-queue:evicted",
      failureHeadSha: "abc123",
      checkName: "merge-steward",
      summary: "Evicted from queue",
      incidentSummary: "Base branch moved",
      incidentContext: {
        baseSha: "base-1",
        prHeadSha: "abc123",
        queuePosition: 3,
      },
    });
    assert.equal(evaluateTaskStart(snapshot, task!).action, "start");
  } finally {
    cleanup();
  }
});

test("merged PR is terminal and does not derive follow-up work", () => {
  const { db, cleanup } = createDb();
  try {
    const issue = makeIssue(db, {
      prNumber: 42,
      prState: "merged",
      prHeadSha: "abc123",
      prCheckStatus: "failed",
      lastGitHubFailureSource: "branch_ci",
    });
    const snapshot = projectWorkflowSnapshot({ issue });

    assert.equal(snapshot.status, "done");
    assert.deepEqual(snapshot.openTasks, []);
  } finally {
    cleanup();
  }
});

test("active run keeps workflow running even when external state is terminal", () => {
  const { db, cleanup } = createDb();
  try {
    const issue = makeIssue(db, {
      factoryState: "done",
      prNumber: 42,
      prState: "merged",
      activeRunId: 77,
      currentLinearState: "Done",
      currentLinearStateType: "completed",
    });
    const snapshot = projectWorkflowSnapshot({ issue });

    assert.equal(snapshot.status, "running");
    assert.equal(snapshot.openTasks[0]?.id, "wait:active-run:77");
  } finally {
    cleanup();
  }
});

test("awaiting-input workflows do not derive implementation work", () => {
  const { db, cleanup } = createDb();
  try {
    const issue = makeIssue(db, {
      factoryState: "awaiting_input",
    });
    const reconciled = reconcileWorkflowTasksForIssue(db, issue);

    assert.deepEqual(
      reconciled.result.open.map((task) => [task.taskId, task.gateAction]),
      [["wait:input", "wait"]],
    );
    assert.equal(db.workflowTasks.listOpenRunnableTasks(issue.projectId).length, 0);
  } finally {
    cleanup();
  }
});

test("workflow task reconciliation materializes runnable tasks idempotently", () => {
  const { db, cleanup } = createDb();
  try {
    const issue = makeIssue(db);

    const first = reconcileWorkflowTasksForIssue(db, issue);
    const second = reconcileWorkflowTasksForIssue(db, issue);

    assert.equal(first.result.opened.length, 1);
    assert.equal(second.result.opened.length, 0);
    assert.equal(second.result.updated.length, 1);
    const open = db.workflowTasks.listOpenTasks(issue.projectId, issue.linearIssueId);
    assert.equal(open.length, 1);
    assert.equal(open[0]?.taskId, "run:implementation");
    assert.equal(open[0]?.gateAction, "start");
    assert.equal(open[0]?.authorityEpoch, 0);
    assert.equal(db.workflowTasks.listOpenRunnableTasks(issue.projectId).length, 1);
  } finally {
    cleanup();
  }
});

test("workflow task reconciliation closes stale runnable tasks when blockers appear", () => {
  const { db, cleanup } = createDb();
  try {
    const issue = makeIssue(db);
    reconcileWorkflowTasksForIssue(db, issue);
    db.replaceIssueDependencies({
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      blockers: [{
        blockerLinearIssueId: "blocker-1",
        blockerIssueKey: "USE-2",
        blockerTitle: "Finish dependency",
        blockerCurrentLinearState: "In Progress",
        blockerCurrentLinearStateType: "started",
      }],
    });

    const reconciled = reconcileWorkflowTasksForIssue(db, db.getIssue(issue.projectId, issue.linearIssueId)!);
    const allTasks = db.workflowTasks.listTasks(issue.projectId, issue.linearIssueId);

    assert.equal(reconciled.result.closed.map((task) => task.taskId).includes("run:implementation"), true);
    assert.equal(db.workflowTasks.getTask(issue.projectId, issue.linearIssueId, "run:implementation")?.status, "closed");
    assert.deepEqual(
      db.workflowTasks.listOpenTasks(issue.projectId, issue.linearIssueId).map((task) => [task.taskId, task.gateAction]),
      [["wait:blockers", "wait"]],
    );
    assert.equal(db.workflowTasks.listOpenRunnableTasks(issue.projectId).length, 0);
    assert.equal(allTasks.length, 2);
  } finally {
    cleanup();
  }
});

test("workflow task reconciliation closes runnable work when authority is revoked", () => {
  const { db, cleanup } = createDb();
  try {
    const issue = makeIssue(db);
    reconcileWorkflowTasksForIssue(db, issue);
    db.workflowObservations.appendObservation({
      projectId: issue.projectId,
      subjectId: issue.linearIssueId,
      source: "linear",
      type: "linear.undelegated",
      payloadJson: JSON.stringify({ delegated: false }),
      observedAt: "2026-06-14T10:00:00.000Z",
    });

    const reconciled = reconcileWorkflowTasksForIssue(db, issue);

    assert.equal(reconciled.snapshot.authority.delegated, false);
    assert.equal(reconciled.snapshot.authority.epoch, 1);
    assert.equal(db.workflowTasks.getTask(issue.projectId, issue.linearIssueId, "run:implementation")?.status, "closed");
    assert.deepEqual(
      db.workflowTasks.listOpenTasks(issue.projectId, issue.linearIssueId).map((task) => [task.taskId, task.gateAction, task.authorityEpoch]),
      [["wait:authority", "wait", 1]],
    );
  } finally {
    cleanup();
  }
});

test("ready issue discovery includes runnable workflow tasks after restart-style reconciliation", () => {
  const { db, cleanup } = createDb();
  try {
    const issue = makeIssue(db);

    const ready = db.listIssuesReadyForExecution();

    assert.deepEqual(ready, [{ projectId: issue.projectId, linearIssueId: issue.linearIssueId }]);
    assert.equal(db.workflowTasks.listOpenRunnableTasks(issue.projectId)[0]?.taskId, "run:implementation");
  } finally {
    cleanup();
  }
});

test("run wake planner can synthesize a wake from a runnable workflow task", () => {
  const { db, cleanup } = createDb();
  try {
    const issue = makeIssue(db);
    db.listIssuesReadyForExecution();

    const wake = new RunWakePlanner(db).resolveRunWake(issue);

    assert.equal(wake?.runType, "implementation");
    assert.equal(wake?.wakeReason, "run:implementation");
    assert.equal(wake?.resumeThread, false);
    assert.equal(wake?.eventIds.length, 0);
    assert.equal(wake?.context?.source, "workflow_task");
  } finally {
    cleanup();
  }
});

test("run wake planner preserves workflow task repair context", () => {
  const { db, cleanup } = createDb();
  try {
    const issue = makeIssue(db);
    db.workflowTasks.reconcileTasks({
      projectId: issue.projectId,
      subjectId: issue.linearIssueId,
      tasks: [{
        authorityEpoch: 1,
        gateAction: "start",
        task: {
          id: "run:ci_repair",
          type: "run",
          runType: "ci_repair",
          reason: "Settled branch CI failure requires repair",
          requirements: {
            failureSignature: "ci:unit-tests",
            failureHeadSha: "abc123",
            checkName: "verify",
            jobName: "unit",
            stepName: "pnpm test",
            summary: "Unit tests failed",
            ciSnapshot: {
              headSha: "abc123",
              gateCheckName: "verify",
              gateCheckStatus: "failure",
              failedChecks: [{ name: "verify", status: "failure", conclusion: "failure" }],
              checks: [{ name: "verify", status: "failure", conclusion: "failure" }],
              capturedAt: "2026-06-14T10:00:00.000Z",
            },
          },
        },
      }],
    });

    const wake = new RunWakePlanner(db).resolveRunWake(issue);

    assert.equal(wake?.runType, "ci_repair");
    assert.equal(wake?.wakeReason, "run:ci_repair");
    assert.equal(wake?.context?.source, "workflow_task");
    assert.equal(wake?.context?.failureSignature, "ci:unit-tests");
    assert.equal(wake?.context?.failureHeadSha, "abc123");
    assert.equal(wake?.context?.checkName, "verify");
    assert.equal(wake?.context?.summary, "Unit tests failed");
    assert.equal(wake?.context?.ciSnapshot?.gateCheckStatus, "failure");
  } finally {
    cleanup();
  }
});

test("active run reconciliation closes runnable workflow tasks", () => {
  const { db, cleanup } = createDb();
  try {
    const issue = makeIssue(db);
    reconcileWorkflowTasksForIssue(db, issue);
    const run = db.runs.createRun({
      issueId: issue.id,
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      runType: "implementation",
      promptText: "do work",
    });
    const committed = db.issueSessions.commitIssueState({
      writer: "workflow-runtime-test",
      update: {
        projectId: issue.projectId,
        linearIssueId: issue.linearIssueId,
        activeRunId: run.id,
      },
    });
    assert.equal(committed.outcome, "applied");

    reconcileWorkflowTasksForIssue(db, committed.issue);

    assert.equal(db.workflowTasks.getTask(issue.projectId, issue.linearIssueId, "run:implementation")?.status, "closed");
    assert.deepEqual(
      db.workflowTasks.listOpenTasks(issue.projectId, issue.linearIssueId).map((task) => [task.taskId, task.gateAction]),
      [[`wait:active-run:${run.id}`, "wait"]],
    );
    assert.equal(db.workflowTasks.listOpenRunnableTasks(issue.projectId).length, 0);
  } finally {
    cleanup();
  }
});

test("runner lifecycle writes durable workflow observations", () => {
  const { db, cleanup } = createDb();
  try {
    const issue = makeIssue(db);
    const run = db.runs.createRun({
      issueId: issue.id,
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      runType: "implementation",
      promptText: "do work",
      authorityEpoch: 4,
    });

    db.runs.updateRunThread(run.id, { threadId: "thread-1", turnId: "turn-1" });
    db.runs.finishRun(run.id, { status: "completed", threadId: "thread-1", turnId: "turn-1" });
    db.runs.finishRun(run.id, { status: "completed", threadId: "thread-1", turnId: "turn-1" });

    const observations = db.workflowObservations.listObservations(issue.projectId, issue.linearIssueId);

    assert.deepEqual(
      observations.map((observation) => observation.type),
      ["runner.run_claimed", "runner.run_started", "runner.run_finished"],
    );
    assert.equal(observations.every((observation) => observation.source === "runner"), true);
    assert.equal(JSON.parse(observations[0]!.payloadJson!).authorityEpoch, 4);
    assert.equal(JSON.parse(observations[1]!.payloadJson!).threadId, "thread-1");
    assert.equal(JSON.parse(observations[2]!.payloadJson!).status, "completed");
  } finally {
    cleanup();
  }
});

test("restart reconciliation treats detached queued runs as active executor truth", () => {
  const { db, cleanup } = createDb();
  try {
    const issue = makeIssue(db);
    reconcileWorkflowTasksForIssue(db, issue);
    const run = db.runs.createRun({
      issueId: issue.id,
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      runType: "implementation",
      promptText: "do work",
      authorityEpoch: 2,
    });

    const reconciled = reconcileWorkflowTasksForIssue(db, db.getIssue(issue.projectId, issue.linearIssueId)!);

    assert.equal(reconciled.snapshot.status, "running");
    assert.deepEqual(reconciled.snapshot.activeRun, {
      id: run.id,
      runType: "implementation",
      authorityEpoch: 2,
      status: "queued",
    });
    assert.equal(db.workflowTasks.getTask(issue.projectId, issue.linearIssueId, "run:implementation")?.status, "closed");
    assert.deepEqual(
      db.workflowTasks.listOpenTasks(issue.projectId, issue.linearIssueId).map((task) => [task.taskId, task.gateAction]),
      [[`wait:active-run:${run.id}`, "wait"]],
    );
    assert.equal(db.listIssuesReadyForExecution().some((entry) => entry.linearIssueId === issue.linearIssueId), false);
  } finally {
    cleanup();
  }
});

test("umbrella workflows with open children wait instead of starting implementation", () => {
  const { db, cleanup } = createDb();
  try {
    const parent = makeIssue(db, {
      linearIssueId: "parent-1",
      issueKey: "USE-100",
      title: "Coordinate child work",
    });
    makeIssue(db, {
      linearIssueId: "child-1",
      issueKey: "USE-101",
      title: "Child task",
      factoryState: "delegated",
    });
    db.replaceIssueParentLink({
      projectId: parent.projectId,
      parentLinearIssueId: parent.linearIssueId,
      childLinearIssueId: "child-1",
    });

    const snapshot = projectWorkflowSnapshot({
      issue: parent,
      childCount: 1,
      openChildCount: 1,
    });
    const reconciled = reconcileWorkflowTasksForIssue(db, db.getIssue(parent.projectId, parent.linearIssueId)!);

    assert.equal(snapshot.openTasks[0]?.id, "wait:children");
    assert.deepEqual(
      reconciled.result.open.map((task) => [task.taskId, task.gateAction]),
      [["wait:children", "wait"]],
    );
    assert.equal(db.listIssuesReadyForExecution().some((entry) => entry.linearIssueId === parent.linearIssueId), false);
  } finally {
    cleanup();
  }
});

test("umbrella workflows with completed children derive verification, not implementation", () => {
  const { db, cleanup } = createDb();
  try {
    const parent = makeIssue(db, {
      linearIssueId: "parent-1",
      issueKey: "USE-100",
      title: "Coordinate child work",
    });
    makeIssue(db, {
      linearIssueId: "child-1",
      issueKey: "USE-101",
      title: "Child task",
      factoryState: "done",
      currentLinearStateType: "completed",
    });
    db.replaceIssueParentLink({
      projectId: parent.projectId,
      parentLinearIssueId: parent.linearIssueId,
      childLinearIssueId: "child-1",
    });

    const reconciled = reconcileWorkflowTasksForIssue(db, db.getIssue(parent.projectId, parent.linearIssueId)!);

    assert.deepEqual(
      reconciled.result.open.map((task) => [task.taskId, task.taskType, task.gateAction]),
      [["verify:children_complete", "verify", "start"]],
    );
    assert.equal(db.workflowTasks.listOpenRunnableTasks(parent.projectId).some((task) => task.subjectId === parent.linearIssueId), false);
  } finally {
    cleanup();
  }
});

test("terminal Linear parent state closes umbrella verification tasks", () => {
  const { db, cleanup } = createDb();
  try {
    const parent = makeIssue(db, {
      linearIssueId: "parent-1",
      issueKey: "USE-100",
      title: "Coordinate child work",
    });
    makeIssue(db, {
      linearIssueId: "child-1",
      issueKey: "USE-101",
      title: "Child task",
      factoryState: "done",
      currentLinearStateType: "completed",
    });
    db.replaceIssueParentLink({
      projectId: parent.projectId,
      parentLinearIssueId: parent.linearIssueId,
      childLinearIssueId: "child-1",
    });

    const initial = reconcileWorkflowTasksForIssue(db, db.getIssue(parent.projectId, parent.linearIssueId)!);
    assert.deepEqual(
      initial.result.open.map((task) => [task.taskId, task.taskType, task.gateAction]),
      [["verify:children_complete", "verify", "start"]],
    );

    db.upsertIssue({
      projectId: parent.projectId,
      linearIssueId: parent.linearIssueId,
      currentLinearState: "Done",
      currentLinearStateType: "completed",
    });
    const reconciled = reconcileWorkflowTasksForIssue(db, db.getIssue(parent.projectId, parent.linearIssueId)!);

    assert.equal(reconciled.snapshot.status, "done");
    assert.deepEqual(reconciled.snapshot.openTasks, []);
    assert.deepEqual(
      db.workflowTasks.listOpenTasks(parent.projectId, parent.linearIssueId),
      [],
    );
    assert.equal(db.listIssuesReadyForExecution().some((entry) => entry.linearIssueId === parent.linearIssueId), false);
  } finally {
    cleanup();
  }
});

test("orchestration child changes cannot bypass a wait-children workflow task", () => {
  const { db, cleanup } = createDb();
  try {
    const parent = makeIssue(db, {
      linearIssueId: "parent-1",
      issueKey: "USE-100",
      title: "Coordinate child work",
      issueClass: "orchestration",
    });
    const child = makeIssue(db, {
      linearIssueId: "child-1",
      issueKey: "USE-101",
      title: "Child task",
      factoryState: "delegated",
      currentLinearState: "Start",
      currentLinearStateType: "unstarted",
      parentLinearIssueId: parent.linearIssueId,
      parentIssueKey: parent.issueKey,
    });
    db.replaceIssueParentLink({
      projectId: parent.projectId,
      parentLinearIssueId: parent.linearIssueId,
      childLinearIssueId: child.linearIssueId,
    });

    const enqueueCalls: Array<[string, string]> = [];
    const dispatcher = new WakeDispatcher(
      db,
      (projectId, issueId) => enqueueCalls.push([projectId, issueId]),
      () => undefined,
      pino({ enabled: false }),
    );

    const parentIds = wakeOrchestrationParentsForChildEvent({
      db,
      child,
      eventType: "child_changed",
      changeKind: "attached",
      wakeDispatcher: dispatcher,
    });

    assert.deepEqual(parentIds, [parent.linearIssueId]);
    assert.deepEqual(enqueueCalls, []);
    assert.equal(db.issueSessions.peekIssueSessionWake(parent.projectId, parent.linearIssueId), undefined);
    assert.deepEqual(
      db.workflowTasks.listOpenTasks(parent.projectId, parent.linearIssueId).map((task) => [task.taskId, task.taskType, task.gateAction]),
      [["wait:children", "wait", "wait"]],
    );
  } finally {
    cleanup();
  }
});

test("workflow wait tasks suppress legacy delegated session wakes", () => {
  const { db, cleanup } = createDb();
  try {
    const parent = makeIssue(db, {
      linearIssueId: "parent-1",
      issueKey: "USE-100",
      title: "Coordinate child work",
      issueClass: "orchestration",
    });
    makeIssue(db, {
      linearIssueId: "child-1",
      issueKey: "USE-101",
      title: "Child task",
      factoryState: "delegated",
      currentLinearState: "Start",
      currentLinearStateType: "unstarted",
    });
    db.replaceIssueParentLink({
      projectId: parent.projectId,
      parentLinearIssueId: parent.linearIssueId,
      childLinearIssueId: "child-1",
    });
    reconcileWorkflowTasksForIssue(db, db.getIssue(parent.projectId, parent.linearIssueId)!);
    db.issueSessions.appendIssueSessionEvent({
      projectId: parent.projectId,
      linearIssueId: parent.linearIssueId,
      eventType: "delegated",
      dedupeKey: "delegated:parent-1",
    });

    const enqueueCalls: Array<[string, string]> = [];
    const dispatcher = new WakeDispatcher(
      db,
      (projectId, issueId) => enqueueCalls.push([projectId, issueId]),
      () => undefined,
      pino({ enabled: false }),
    );

    assert.equal(dispatcher.dispatchIfWakePending(parent.projectId, parent.linearIssueId), undefined);
    assert.deepEqual(enqueueCalls, []);
    assert.equal(new RunWakePlanner(db).resolveRunWake(db.getIssue(parent.projectId, parent.linearIssueId)!), undefined);
    assert.deepEqual(
      db.workflowTasks.listOpenTasks(parent.projectId, parent.linearIssueId).map((task) => [task.taskId, task.taskType, task.gateAction]),
      [["wait:children", "wait", "wait"]],
    );
  } finally {
    cleanup();
  }
});

test("terminal Linear truth suppresses stale delegated session wakes", () => {
  const { db, cleanup } = createDb();
  try {
    const issue = makeIssue(db, {
      linearIssueId: "issue-linear-done",
      issueKey: "USE-DONE",
      currentLinearState: "Done",
      currentLinearStateType: "completed",
      factoryState: "delegated",
      pendingRunType: "implementation",
    });
    db.issueSessions.appendIssueSessionEvent({
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      eventType: "delegated",
      dedupeKey: "delegated:issue-linear-done",
    });

    assert.equal(peekPendingWakeRunType(db, issue.projectId, issue.linearIssueId), "implementation");
    assert.equal(new RunWakePlanner(db).resolveRunWake(issue), undefined);
  } finally {
    cleanup();
  }
});

test("runs persist the authority epoch they were claimed under", () => {
  const { db, cleanup } = createDb();
  try {
    const issue = makeIssue(db);
    const run = db.runs.createRun({
      issueId: issue.id,
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      runType: "implementation",
      promptText: "do work",
      authorityEpoch: 3,
    });

    assert.equal(run.authorityEpoch, 3);
    assert.equal(db.runs.getRunById(run.id)?.authorityEpoch, 3);
  } finally {
    cleanup();
  }
});

test("run lease revocation suppresses publication and records the reason", () => {
  const { db, cleanup } = createDb();
  try {
    const issue = makeIssue(db);
    const run = db.runs.createRun({
      issueId: issue.id,
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      runType: "implementation",
      promptText: "do work",
      authorityEpoch: 1,
    });

    db.runs.revokeRunLease(run.id, {
      reason: "Un-delegated from PatchRelay",
      revokedAt: "2026-06-14T10:05:00.000Z",
    });

    const revoked = db.runs.getRunById(run.id);
    assert.equal(revoked?.shouldNotPublish, true);
    assert.equal(revoked?.leaseRevokedAt, "2026-06-14T10:05:00.000Z");
    assert.equal(revoked?.leaseRevokeReason, "Un-delegated from PatchRelay");
  } finally {
    cleanup();
  }
});
