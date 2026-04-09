import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { PatchRelayDatabase } from "../src/db.ts";

test("repairing_ci issues with an unseen failure signature become ready without a fresh webhook", () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-db-ready-wake-"));
  try {
    const db = new PatchRelayDatabase(path.join(baseDir, "patchrelay.sqlite"), true);
    db.runMigrations();

    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-1",
      issueKey: "USE-1",
      factoryState: "repairing_ci",
      prNumber: 1,
      prState: "open",
      prCheckStatus: "failure",
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

    const wake = db.peekIssueSessionWake("usertold", "issue-1");
    assert.equal(wake?.runType, "ci_repair");
    assert.equal(wake?.wakeReason, "settled_red_ci");
    assert.deepEqual(
      db.listIssuesReadyForExecution(),
      [{ projectId: "usertold", linearIssueId: "issue-1" }],
    );
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("repairing_ci issues can synthesize a one-time wake from the current PR head when old failure metadata is missing", () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-db-ready-wake-implicit-"));
  try {
    const db = new PatchRelayDatabase(path.join(baseDir, "patchrelay.sqlite"), true);
    db.runMigrations();

    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-2",
      issueKey: "USE-2",
      factoryState: "repairing_ci",
      prNumber: 2,
      prState: "open",
      prHeadSha: "sha-implicit",
      prCheckStatus: "failure",
    });

    const wake = db.peekIssueSessionWake("usertold", "issue-2");
    assert.equal(wake?.runType, "ci_repair");
    assert.equal(wake?.context.failureSignature, "implicit_branch_ci::sha-implicit");
    assert.equal(wake?.context.failureHeadSha, "sha-implicit");
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
    db.appendIssueSessionEvent({
      projectId: "usertold",
      linearIssueId: "issue-3",
      eventType: "review_changes_requested",
      eventJson: JSON.stringify({ reviewBody: "Please fix the failing review points." }),
    });

    const wake = db.peekIssueSessionWake("usertold", "issue-3");
    assert.equal(wake?.runType, "review_fix");
    assert.deepEqual(
      db.listIssuesReadyForExecution(),
      [{ projectId: "usertold", linearIssueId: "issue-3" }],
    );
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});
