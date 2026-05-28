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
        external_check_run_id INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        UNIQUE(repo_full_name, pr_number, head_sha)
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
    verify.close();
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});
