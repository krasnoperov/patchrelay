import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { PatchRelayDatabase } from "../src/db.ts";
import { peekPendingWakeRunType } from "../src/pending-wake.ts";
import { reconcileWorkflowTasksForIssue } from "../src/workflow-task-reconciler.ts";

test("repairing_ci issues with an unseen failure signature become ready without a fresh webhook", () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-db-ready-wake-"));
  try {
    const db = new PatchRelayDatabase(path.join(baseDir, "patchrelay.sqlite"), true);
    db.runMigrations();

    const issue = db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-1",
      issueKey: "USE-1",
      factoryState: "repairing_ci",
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
    // wake, reconciling the issue columns must synthesize a runnable
    // run:ci_repair workflow task from the settled red-CI facts alone.
    assert.equal(db.issueSessions.peekIssueSessionWake("usertold", "issue-1"), undefined);
    reconcileWorkflowTasksForIssue(db, issue);
    assert.equal(peekPendingWakeRunType(db, "usertold", "issue-1"), "ci_repair");
    assert.deepEqual(
      db.listIssuesReadyForExecution(),
      [{ projectId: "usertold", linearIssueId: "issue-1" }],
    );
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("terminal issues with a fresh GitHub wake become ready for execution again", () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-db-ready-wake-terminal-"));
  try {
    const db = new PatchRelayDatabase(path.join(baseDir, "patchrelay.sqlite"), true);
    db.runMigrations();

    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-3",
      issueKey: "USE-3",
      factoryState: "escalated",
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

    assert.equal(peekPendingWakeRunType(db, "usertold", "issue-3"), "review_fix");
    assert.deepEqual(
      db.listIssuesReadyForExecution(),
      [{ projectId: "usertold", linearIssueId: "issue-3" }],
    );
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});
