import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { PatchRelayDatabase } from "../src/db.ts";
import { MemoryPatchRelayTelemetry } from "../src/telemetry.ts";

function makeDb(): { db: PatchRelayDatabase; telemetry: MemoryPatchRelayTelemetry; cleanup: () => void } {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-issue-state-commit-"));
  const telemetry = new MemoryPatchRelayTelemetry();
  const db = new PatchRelayDatabase(path.join(baseDir, "test.sqlite"), false, telemetry);
  db.runMigrations();
  return { db, telemetry, cleanup: () => rmSync(baseDir, { recursive: true, force: true }) };
}

const PROJECT = "proj";
const ISSUE = "issue-1";

function seedIssue(db: PatchRelayDatabase) {
  return db.upsertIssue({
    projectId: PROJECT,
    linearIssueId: ISSUE,
    issueKey: "USE-1",
    factoryState: "pr_open",
  });
}

test("upsertIssue bumps the version on every update", () => {
  const { db, cleanup } = makeDb();
  try {
    const created = seedIssue(db);
    const updated = db.upsertIssue({ projectId: PROJECT, linearIssueId: ISSUE, prNumber: 7 });
    assert.equal(updated.version, created.version + 1);
    const again = db.upsertIssue({ projectId: PROJECT, linearIssueId: ISSUE, prState: "open" });
    assert.equal(again.version, created.version + 2);
  } finally {
    cleanup();
  }
});

test("commitIssueState applies cleanly when the expected version matches", () => {
  const { db, telemetry, cleanup } = makeDb();
  try {
    const issue = seedIssue(db);
    const result = db.issueSessions.commitIssueState({
      writer: "test",
      expectedVersion: issue.version,
      update: { projectId: PROJECT, linearIssueId: ISSUE, factoryState: "awaiting_queue" },
    });
    assert.equal(result.outcome, "applied");
    assert.equal(result.outcome === "applied" && result.conflicted, false);
    assert.equal(db.getIssue(PROJECT, ISSUE)?.factoryState, "awaiting_queue");
    assert.equal(telemetry.list("state.write_conflict").length, 0);
  } finally {
    cleanup();
  }
});

test("interleaved writer triggers a conflict that is recomputed from the fresh row", () => {
  const { db, telemetry, cleanup } = makeDb();
  try {
    const issue = seedIssue(db);
    // Writer B lands between writer A's read and A's commit.
    db.upsertIssue({ projectId: PROJECT, linearIssueId: ISSUE, factoryState: "done" });

    const result = db.issueSessions.commitIssueState({
      writer: "writer-a",
      expectedVersion: issue.version,
      update: { projectId: PROJECT, linearIssueId: ISSUE, factoryState: "repairing_ci" },
      onConflict: (current) =>
        current.factoryState === "done"
          ? undefined
          : { projectId: PROJECT, linearIssueId: ISSUE, factoryState: "repairing_ci" },
    });

    assert.equal(result.outcome, "conflict_skipped");
    assert.equal(db.getIssue(PROJECT, ISSUE)?.factoryState, "done");
    const conflicts = telemetry.list("state.write_conflict");
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0]?.writer, "writer-a");
    assert.equal(conflicts[0]?.resolution, "skipped");
  } finally {
    cleanup();
  }
});

test("conflict with a recomputing onConflict applies the recomputed update", () => {
  const { db, telemetry, cleanup } = makeDb();
  try {
    const issue = seedIssue(db);
    db.upsertIssue({ projectId: PROJECT, linearIssueId: ISSUE, ciRepairAttempts: 3 });

    const result = db.issueSessions.commitIssueState({
      writer: "writer-a",
      expectedVersion: issue.version,
      update: { projectId: PROJECT, linearIssueId: ISSUE, ciRepairAttempts: issue.ciRepairAttempts - 1 },
      onConflict: (current) => ({
        projectId: PROJECT,
        linearIssueId: ISSUE,
        ciRepairAttempts: current.ciRepairAttempts - 1,
      }),
    });

    assert.equal(result.outcome, "applied");
    assert.equal(result.outcome === "applied" && result.conflicted, true);
    // Decrement applied against the fresh row (3 - 1), not the stale one.
    assert.equal(db.getIssue(PROJECT, ISSUE)?.ciRepairAttempts, 2);
    assert.equal(telemetry.list("state.write_conflict")[0]?.resolution, "recomputed");
  } finally {
    cleanup();
  }
});

test("conflict without onConflict is applied anyway but observable", () => {
  const { db, telemetry, cleanup } = makeDb();
  try {
    const issue = seedIssue(db);
    db.upsertIssue({ projectId: PROJECT, linearIssueId: ISSUE, prNumber: 9 });

    const result = db.issueSessions.commitIssueState({
      writer: "writer-a",
      expectedVersion: issue.version,
      update: { projectId: PROJECT, linearIssueId: ISSUE, prState: "open" },
    });

    assert.equal(result.outcome, "applied");
    assert.equal(db.getIssue(PROJECT, ISSUE)?.prState, "open");
    assert.equal(telemetry.list("state.write_conflict")[0]?.resolution, "applied_anyway");
  } finally {
    cleanup();
  }
});

test("unconditional commit never reports a conflict", () => {
  const { db, telemetry, cleanup } = makeDb();
  try {
    seedIssue(db);
    db.upsertIssue({ projectId: PROJECT, linearIssueId: ISSUE, prNumber: 9 });

    const result = db.issueSessions.commitIssueState({
      writer: "webhook",
      update: { projectId: PROJECT, linearIssueId: ISSUE, prState: "merged" },
    });

    assert.equal(result.outcome, "applied");
    assert.equal(telemetry.list("state.write_conflict").length, 0);
  } finally {
    cleanup();
  }
});

test("commit under a stale lease is denied without writing", () => {
  const { db, cleanup } = makeDb();
  try {
    const issue = seedIssue(db);
    const future = new Date(Date.now() + 60_000).toISOString();
    assert.equal(
      db.issueSessions.acquireIssueSessionLease({
        projectId: PROJECT,
        linearIssueId: ISSUE,
        leaseId: "holder",
        workerId: "w1",
        leasedUntil: future,
      }),
      true,
    );

    const denied = db.issueSessions.commitIssueState({
      writer: "stale-worker",
      lease: { projectId: PROJECT, linearIssueId: ISSUE, leaseId: "not-the-holder" },
      expectedVersion: issue.version,
      update: { projectId: PROJECT, linearIssueId: ISSUE, factoryState: "failed" },
    });
    assert.equal(denied.outcome, "lease_denied");
    assert.equal(db.getIssue(PROJECT, ISSUE)?.factoryState, "pr_open");

    const allowed = db.issueSessions.commitIssueState({
      writer: "holder-worker",
      lease: { projectId: PROJECT, linearIssueId: ISSUE, leaseId: "holder" },
      expectedVersion: issue.version,
      update: { projectId: PROJECT, linearIssueId: ISSUE, factoryState: "awaiting_queue" },
    });
    assert.equal(allowed.outcome, "applied");
  } finally {
    cleanup();
  }
});

test("commit against a missing issue with expectedVersion null inserts it", () => {
  const { db, telemetry, cleanup } = makeDb();
  try {
    const result = db.issueSessions.commitIssueState({
      writer: "test",
      expectedVersion: null,
      update: { projectId: PROJECT, linearIssueId: ISSUE, factoryState: "delegated" },
    });
    assert.equal(result.outcome, "applied");
    assert.equal(telemetry.list("state.write_conflict").length, 0);
  } finally {
    cleanup();
  }
});
