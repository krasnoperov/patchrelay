import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import test from "node:test";
import { PatchRelayDatabase } from "../src/db.ts";
import { IdleIssueReconciler } from "../src/idle-reconciliation.ts";
import { WakeDispatcher } from "../src/wake-dispatcher.ts";
import { MemoryPatchRelayTelemetry } from "../src/telemetry.ts";
import type { AppConfig } from "../src/config-types.ts";

function createHarness() {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-reconcile-conflict-"));
  const telemetry = new MemoryPatchRelayTelemetry();
  const db = new PatchRelayDatabase(path.join(baseDir, "patchrelay.sqlite"), true, telemetry);
  db.runMigrations();
  const logger = pino({ enabled: false });
  const wake = new WakeDispatcher(db, () => undefined, () => undefined, logger);
  const config = {
    projects: [{
      id: "proj",
      repoPath: "/tmp/proj",
      reviewChecks: [],
      gateChecks: [],
      github: { repoFullName: "owner/repo", baseBranch: "main" },
    }],
  } as unknown as AppConfig;
  const reconciler = new IdleIssueReconciler(db, config, wake, logger);
  return { baseDir, db, telemetry, reconciler };
}

test("advanceIdleIssue skips when a concurrent writer landed after the tick's read", () => {
  const { baseDir, db, telemetry, reconciler } = createHarness();
  try {
    const staleRow = db.upsertIssue({
      projectId: "proj",
      linearIssueId: "issue-1",
      issueKey: "USE-1",
      delegatedToPatchRelay: true,
      factoryState: "pr_open",
      prNumber: 7,
    });

    // A webhook lands mid-tick and moves the issue forward.
    db.upsertIssue({ projectId: "proj", linearIssueId: "issue-1", factoryState: "repairing_ci" });

    const outcome = reconciler.advanceIdleIssue(staleRow, "awaiting_queue", { clearFailureProvenance: true });

    assert.equal(outcome, "skipped");
    // The webhook's state survives; the stale advance did not clobber it.
    assert.equal(db.getIssue("proj", "issue-1")?.factoryState, "repairing_ci");
    const conflicts = telemetry.list("state.write_conflict");
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0]?.writer, "idle-reconciliation");
    assert.equal(conflicts[0]?.resolution, "skipped");
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("advanceIdleIssue applies and records no conflict when the row is fresh", () => {
  const { baseDir, db, telemetry, reconciler } = createHarness();
  try {
    const fresh = db.upsertIssue({
      projectId: "proj",
      linearIssueId: "issue-1",
      issueKey: "USE-1",
      delegatedToPatchRelay: true,
      factoryState: "pr_open",
      prNumber: 7,
      prReviewState: "approved",
    });

    const outcome = reconciler.advanceIdleIssue(fresh, "awaiting_queue", { clearFailureProvenance: true });

    assert.equal(outcome, "applied");
    assert.equal(db.getIssue("proj", "issue-1")?.factoryState, "awaiting_queue");
    assert.equal(telemetry.list("state.write_conflict").length, 0);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});
