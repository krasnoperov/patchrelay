import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { PatchRelayDatabase } from "../src/db.ts";
import { settleRun } from "../src/run-settlement.ts";

function createDb() {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-run-settlement-"));
  const db = new PatchRelayDatabase(path.join(baseDir, "patchrelay.sqlite"), true);
  db.runMigrations();
  return { baseDir, db };
}

function createIssueWithRun(db: PatchRelayDatabase) {
  const issue = db.upsertIssue({
    projectId: "usertold",
    linearIssueId: "issue-1",
    issueKey: "USE-1",
    branchName: "feat-settle",
    prNumber: 7,
    prState: "open",
    factoryState: "pr_open",
    delegatedToPatchRelay: true,
  });
  const run = db.runs.createRun({
    issueId: issue.id,
    projectId: issue.projectId,
    linearIssueId: issue.linearIssueId,
    runType: "implementation",
  });
  db.upsertIssue({
    projectId: issue.projectId,
    linearIssueId: issue.linearIssueId,
    activeRunId: run.id,
  });
  return { issue, run };
}

test("settleRun clears a slot stranded on a terminal run and re-settling is a no-op", () => {
  // The pre-#566 restart freeze: the run row reached a terminal status but
  // the crash landed before the issue write cleared activeRunId.
  const { baseDir, db } = createDb();
  try {
    const { issue, run } = createIssueWithRun(db);
    db.runs.finishRun(run.id, { status: "completed" });
    assert.equal(db.getIssue(issue.projectId, issue.linearIssueId)?.activeRunId, run.id);

    const first = settleRun({ db, run });
    assert.equal(first.slotCleared, true);
    assert.equal(first.runFinished, false, "the run was already terminal");
    assert.equal(db.getIssue(issue.projectId, issue.linearIssueId)?.activeRunId, undefined);

    const versionAfterFirst = db.getIssue(issue.projectId, issue.linearIssueId)?.version;
    const second = settleRun({ db, run });
    assert.equal(second.slotCleared, false);
    assert.equal(second.runFinished, false);
    assert.equal(
      db.getIssue(issue.projectId, issue.linearIssueId)?.version,
      versionAfterFirst,
      "re-settling an already-settled run must not write the issue row",
    );
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("settleRun records the terminal outcome and clears the slot in one call", () => {
  // The finalizer-shaped call: a running run is finished and the slot is
  // cleared in one transaction, with extra issue fields riding along.
  const { baseDir, db } = createDb();
  try {
    const { issue, run } = createIssueWithRun(db);
    db.runs.updateRunThread(run.id, { threadId: "thread-1", turnId: "turn-1" });

    const result = settleRun({
      db,
      run,
      finish: { status: "completed", threadId: "thread-1" },
      buildIssueUpdate: () => ({ factoryState: "pr_open" }),
    });
    assert.equal(result.runFinished, true);
    assert.equal(result.slotCleared, true);
    assert.equal(db.runs.getRunById(run.id)?.status, "completed");
    const settled = db.getIssue(issue.projectId, issue.linearIssueId);
    assert.equal(settled?.activeRunId, undefined);
    assert.equal(settled?.factoryState, "pr_open");

    // Crash replay: the same finalize call after a restart changes nothing.
    const versionAfterFirst = settled?.version;
    const replay = settleRun({
      db,
      run,
      finish: { status: "completed", threadId: "thread-1" },
      buildIssueUpdate: () => ({ factoryState: "pr_open" }),
    });
    assert.equal(replay.runFinished, false);
    assert.equal(replay.slotCleared, false);
    assert.equal(db.getIssue(issue.projectId, issue.linearIssueId)?.version, versionAfterFirst);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("settleRun for a stale run leaves a slot held by a fresh live run alone", () => {
  const { baseDir, db } = createDb();
  try {
    const { issue, run: staleRun } = createIssueWithRun(db);
    db.runs.finishRun(staleRun.id, { status: "completed" });
    const freshRun = db.runs.createRun({
      issueId: issue.id,
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      runType: "review_fix",
    });
    db.upsertIssue({
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      activeRunId: freshRun.id,
    });
    const versionBefore = db.getIssue(issue.projectId, issue.linearIssueId)?.version;

    const result = settleRun({ db, run: staleRun });
    assert.equal(result.slotCleared, false);
    const current = db.getIssue(issue.projectId, issue.linearIssueId);
    assert.equal(current?.activeRunId, freshRun.id, "the fresh run's slot must not be touched");
    assert.equal(current?.version, versionBefore);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("settleRun without a terminal outcome leaves a live run's slot alone", () => {
  // Recovery callers never pass `finish`; a run that is still running
  // legitimately holds the slot and must not be finished or cleared.
  const { baseDir, db } = createDb();
  try {
    const { issue, run } = createIssueWithRun(db);
    db.runs.updateRunThread(run.id, { threadId: "thread-1", turnId: "turn-1" });
    const versionBefore = db.getIssue(issue.projectId, issue.linearIssueId)?.version;

    const result = settleRun({ db, run });
    assert.equal(result.runFinished, false);
    assert.equal(result.slotCleared, false);
    assert.equal(db.runs.getRunById(run.id)?.status, "running");
    const current = db.getIssue(issue.projectId, issue.linearIssueId);
    assert.equal(current?.activeRunId, run.id);
    assert.equal(current?.version, versionBefore);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});
