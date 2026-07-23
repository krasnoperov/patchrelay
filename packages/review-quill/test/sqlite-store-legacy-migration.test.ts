import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { SqliteStore } from "../src/db/sqlite-store.ts";

// Regression for the "no such column: patch_id" startup crash hit
// in production after upgrading to v0.17.x. The carry-forward PR
// added CREATE INDEX statements referencing patch_id / integration_tree_id
// to SCHEMA_SQL, but for legacy databases the CREATE TABLE IF NOT EXISTS
// is a no-op (the table already exists without those columns) so the
// index DDL ran before addColumnIfMissing and crashed.
test("SqliteStore opens a legacy database that pre-dates the carry-forward columns", () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "review-quill-legacy-"));
  const dbPath = path.join(baseDir, "review-quill.sqlite");
  try {
    // Seed the file with the pre-carry-forward schema. This is the
    // shape of any DB created by review-quill < 0.13.
    const seed = new DatabaseSync(dbPath);
    seed.exec(`
      CREATE TABLE webhook_events (
        delivery_id TEXT PRIMARY KEY,
        event_type TEXT NOT NULL,
        repo_full_name TEXT,
        received_at TEXT NOT NULL,
        processed_at TEXT,
        ignored_reason TEXT
      );
      CREATE TABLE review_attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        repo_full_name TEXT NOT NULL,
        pr_number INTEGER NOT NULL,
        head_sha TEXT NOT NULL,
        status TEXT NOT NULL,
        conclusion TEXT,
        summary TEXT,
        thread_id TEXT,
        turn_id TEXT,
        transcript_json TEXT,
        external_check_run_id INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        UNIQUE(repo_full_name, pr_number, head_sha)
      );
      INSERT INTO review_attempts (
        repo_full_name, pr_number, head_sha, status, conclusion, summary,
        thread_id, turn_id, transcript_json, created_at, updated_at, completed_at
      ) VALUES (
        'krasnoperov/patchrelay', 626, 'abc123', 'completed', 'approved', 'Looks good.',
        'thread-626', 'turn-626', '{"id":"thread-626","turns":[{"id":"turn-626","status":"completed","items":[]}]}',
        '2026-07-22T00:00:00.000Z', '2026-07-22T00:01:00.000Z', '2026-07-22T00:01:00.000Z'
      );
    `);
    seed.close();

    // Should not throw — addColumnIfMissing must add patch_id /
    // integration_tree_id before the CREATE INDEX statements run.
    const store = new SqliteStore(dbPath);
    store.close();

    // Verify the columns landed.
    const verify = new DatabaseSync(dbPath);
    const cols = verify.prepare("PRAGMA table_info(review_attempts)").all() as Array<{ name: string }>;
    const names = new Set(cols.map((c) => c.name));
    assert.ok(names.has("patch_id"), "patch_id column should be added on open");
    assert.ok(names.has("integration_tree_id"), "integration_tree_id column should be added on open");
    assert.ok(names.has("review_surface_mode"), "review_surface_mode column should be added on open");
    assert.ok(names.has("prompt_fingerprint"), "prompt_fingerprint column should be added on open");
    assert.ok(!names.has("transcript_json"), "transcript_json column should be removed on open");
    const attempt = verify.prepare(`
      SELECT repo_full_name, pr_number, head_sha, status, conclusion, summary, thread_id, turn_id
      FROM review_attempts
      WHERE pr_number = 626
    `).get();
    assert.deepEqual({ ...attempt }, {
      repo_full_name: "krasnoperov/patchrelay",
      pr_number: 626,
      head_sha: "abc123",
      status: "completed",
      conclusion: "approved",
      summary: "Looks good.",
      thread_id: "thread-626",
      turn_id: "turn-626",
    });
    verify.close();
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("SqliteStore abandons interrupted webhook receipts before bounded retention", () => {
  const store = new SqliteStore(":memory:");
  const connection = (store as unknown as { db: DatabaseSync }).db;
  connection.prepare(`
    INSERT INTO webhook_events (
      delivery_id, event_type, received_at, processed_at
    ) VALUES (?, 'pull_request', ?, ?)
  `).run("old-processed", "2026-07-01T00:00:00.000Z", "2026-07-01T00:00:01.000Z");
  connection.prepare(`
    INSERT INTO webhook_events (
      delivery_id, event_type, received_at, processed_at
    ) VALUES (?, 'pull_request', ?, ?)
  `).run("recent-processed", "2026-07-22T00:00:00.000Z", "2026-07-22T00:00:01.000Z");
  connection.prepare(`
    INSERT INTO webhook_events (
      delivery_id, event_type, received_at, processed_at
    ) VALUES (?, 'pull_request', ?, NULL)
  `).run("old-pending", "2026-07-01T00:00:00.000Z");
  connection.prepare(`
    INSERT INTO webhook_events (
      delivery_id, event_type, received_at, processed_at
    ) VALUES (?, 'pull_request', ?, NULL)
  `).run("recent-pending", "2026-07-22T23:50:00.000Z");

  const now = new Date("2026-07-23T00:00:00.000Z");
  assert.equal(store.abandonStaleUnprocessedWebhooks(15, now), 1);
  assert.equal(store.pruneProcessedWebhooks(7, now), 2);
  assert.deepEqual(
    store.listWebhooks(10).map((event) => event.deliveryId).sort(),
    ["recent-pending", "recent-processed"],
  );
  store.close();
});
