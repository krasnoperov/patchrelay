import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { PatchRelayDatabase } from "../src/db.ts";
import { peekRunnableWorkflowTaskRunType } from "../src/pending-workflow-task.ts";
import { reconcileWorkflowTasksForIssue } from "../src/workflow-task-reconciler.ts";

test("repairing_ci issues with an unseen failure signature become ready without a fresh webhook", () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-db-ready-workflowTask-"));
  try {
    const db = new PatchRelayDatabase(path.join(baseDir, "patchrelay.sqlite"), true);
    db.runMigrations();

    const issue = db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-1",
      issueKey: "USE-1",
      workflowOutcome: undefined,
      prNumber: 1,
      prState: "open",
      prHeadSha: "sha-1",
      prCheckStatus: "failure",
      lastGitHubFailureSource: "branch_ci",
      lastGitHubFailureSignature: "branch_ci::sha-1::verify",
      lastGitHubFailureHeadSha: "sha-1",
      lastGitHubFailureContextJson: JSON.stringify({
        failureSignature: "branch_ci::sha-1::verify",
        failureHeadSha: "sha-1",
        checkName: "verify",
        summary: "verify failed",
      }),
      lastGitHubCiSnapshotJson: JSON.stringify({
        headSha: "sha-1",
        gateCheckName: "verify",
        gateCheckStatus: "failure",
        settledAt: "2026-04-06T00:17:44.000Z",
        checks: [{ name: "verify", status: "failure", conclusion: "failure" }],
        failedChecks: [{ name: "verify", status: "failure", conclusion: "failure" }],
      }),
    });

    // The re-derivation safety net: with no fresh webhook and no session-event
    // workflowTask, reconciling the issue columns must synthesize a runnable
    // run:ci_repair workflow task from the settled red-CI facts alone.
    assert.equal(db.issueSessions.peekPendingSessionInputPlanForDiagnostics("usertold", "issue-1"), undefined);
    reconcileWorkflowTasksForIssue(db, issue);
    assert.equal(peekRunnableWorkflowTaskRunType(db, "usertold", "issue-1"), "ci_repair");
    assert.deepEqual(
      db.listIssuesReadyForExecution(),
      [{ projectId: "usertold", linearIssueId: "issue-1" }],
    );
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("idle sweep re-enqueues issues whose workflowTask exists only as a runnable workflow task (S6)", () => {
  // Regression for USE-478: a review webhook's direct dispatch lost the
  // issue-session lease at run-failure time, so the issue was left with an open
  // runnable run:review_fix task but NO unprocessed session event. The idle
  // reconciler safety-net sweep must still find it — otherwise the issue stalls
  // until a manual retry.
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-db-ready-workflowTask-task-only-"));
  try {
    const db = new PatchRelayDatabase(path.join(baseDir, "patchrelay.sqlite"), true);
    db.runMigrations();

    const issue = db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-task-only",
      issueKey: "USE-478",
      delegatedToPatchRelay: true,
      workflowOutcome: undefined,
      prNumber: 478,
      prState: "open",
      prHeadSha: "sha-478",
      prReviewState: "changes_requested",
      lastBlockingReviewHeadSha: "sha-478",
    });

    // Materialize the runnable task from the PR facts, with no session event.
    reconcileWorkflowTasksForIssue(db, issue);
    assert.equal(db.issueSessions.peekPendingSessionInputPlanForDiagnostics("usertold", "issue-task-only"), undefined);
    assert.equal(db.issueSessions.hasPendingIssueSessionEvents("usertold", "issue-task-only"), false);
    const runnable = db.workflowTasks.listOpenRunnableTasks("usertold")
      .filter((task) => task.subjectId === "issue-task-only" && task.taskId === "run:review_fix");
    assert.equal(runnable.length, 1);

    // The task-only workflowTask must appear in the safety-net sweep set.
    assert.deepEqual(
      db.issues.listIdleIssuesWithRunnableWorkflowTask().map((entry) => entry.linearIssueId),
      ["issue-task-only"],
    );
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("terminal issues with only a session-event workflowTask are not ready for execution", () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-db-ready-workflowTask-terminal-"));
  try {
    const db = new PatchRelayDatabase(path.join(baseDir, "patchrelay.sqlite"), true);
    db.runMigrations();

    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-3",
      issueKey: "USE-3",
      workflowOutcome: "escalated",
      prNumber: 3,
      prState: "open",
      prReviewState: "changes_requested",
      prCheckStatus: "success",
    });
    db.issueSessions.appendIssueSessionEvent({
      projectId: "usertold",
      linearIssueId: "issue-3",
      eventType: "review_changes_requested",
      eventJson: JSON.stringify({ reviewBody: "Please fix the failing review points." }),
    });

    assert.equal(peekRunnableWorkflowTaskRunType(db, "usertold", "issue-3"), undefined);
    assert.deepEqual(db.listIssuesReadyForExecution(), []);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});
