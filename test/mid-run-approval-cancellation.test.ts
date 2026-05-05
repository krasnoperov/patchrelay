import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { PatchRelayDatabase } from "../src/db.ts";

// Plan §4.4: end-to-end smoke test for the mid-run approval
// cancellation primitive. The transition rule is exercised in
// `factory-state.test.ts`; this test covers the run-store side
// (markSuperseded + shouldNotPublish flag) and verifies the round
// trip through the row mapper.

function withDb<T>(fn: (db: PatchRelayDatabase) => T): T {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-supersede-"));
  try {
    const db = new PatchRelayDatabase(path.join(baseDir, "patchrelay.sqlite"), true);
    db.runMigrations();
    return fn(db);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
}

function seedRun(db: PatchRelayDatabase) {
  db.issues.upsertIssue({
    projectId: "demo",
    linearIssueId: "ISSUE-1",
    issueKey: "DEMO-1",
    factoryState: "changes_requested",
    prNumber: 42,
    prHeadSha: "headsha",
  });
  const issue = db.issues.getIssue("demo", "ISSUE-1")!;
  return db.runs.createRun({
    issueId: issue.id,
    projectId: "demo",
    linearIssueId: "ISSUE-1",
    runType: "review_fix",
    sourceHeadSha: "headsha",
  });
}

test("markSuperseded transitions a running run to superseded with shouldNotPublish set", () => {
  withDb((db) => {
    const run = seedRun(db);
    db.runs.markSuperseded(run.id, {
      reason: "approved on the same head; further publication suppressed",
    });

    const updated = db.runs.getRunById(run.id);
    assert.ok(updated);
    assert.equal(updated!.status, "superseded");
    assert.equal(updated!.shouldNotPublish, true);
    assert.equal(
      updated!.failureReason,
      "approved on the same head; further publication suppressed",
    );
    assert.ok(updated!.endedAt, "endedAt should be stamped");
  });
});

test("markSuperseded is a no-op for already-completed runs", () => {
  withDb((db) => {
    const run = seedRun(db);
    db.runs.finishRun(run.id, { status: "completed" });

    db.runs.markSuperseded(run.id, { reason: "should be ignored" });

    const updated = db.runs.getRunById(run.id);
    assert.equal(updated!.status, "completed", "should not overwrite a completed run");
    assert.equal(updated!.shouldNotPublish, undefined, "publication suppression should not apply post-completion");
  });
});

test("markSuperseded preserves an existing failure_reason if already set", () => {
  withDb((db) => {
    const run = seedRun(db);
    db.runs.finishRun(run.id, { status: "failed", failureReason: "earlier failure" });
    // After finishRun, status is "failed" — markSuperseded should not change it.
    db.runs.markSuperseded(run.id, { reason: "newer reason" });
    assert.equal(db.runs.getRunById(run.id)!.status, "failed");
  });
});

test("RunStatus 'superseded' round-trips through the row mapper", () => {
  withDb((db) => {
    const run = seedRun(db);
    db.runs.markSuperseded(run.id, { reason: "approved" });
    const fresh = db.runs.getRunById(run.id);
    assert.equal(fresh!.status, "superseded");
    assert.equal(fresh!.shouldNotPublish, true);
  });
});
