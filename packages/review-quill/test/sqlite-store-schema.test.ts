import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { SqliteStore } from "../src/db/sqlite-store.ts";

test("SqliteStore rejects a database that is not on the current schema", () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "review-quill-schema-"));
  const dbPath = path.join(baseDir, "review-quill.sqlite");
  try {
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
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        UNIQUE(repo_full_name, pr_number, head_sha)
      );
    `);
    seed.close();

    assert.throws(
      () => new SqliteStore(dbPath),
      /Review Quill database schema is incompatible.*missing:/,
    );
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("SqliteStore rejects obsolete columns instead of rewriting them", () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "review-quill-schema-"));
  const dbPath = path.join(baseDir, "review-quill.sqlite");
  try {
    const store = new SqliteStore(dbPath);
    store.close();
    const seed = new DatabaseSync(dbPath);
    seed.exec("ALTER TABLE review_attempts ADD COLUMN transcript_json TEXT");
    seed.close();

    assert.throws(
      () => new SqliteStore(dbPath),
      /Review Quill database schema is incompatible.*unexpected: transcript_json/,
    );
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("SqliteStore does not add objects to a partial database", () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "review-quill-partial-schema-"));
  const dbPath = path.join(baseDir, "review-quill.sqlite");
  try {
    const seed = new DatabaseSync(dbPath);
    seed.exec("CREATE TABLE webhook_events (delivery_id TEXT PRIMARY KEY)");
    seed.close();

    assert.throws(() => new SqliteStore(dbPath), /Review Quill database schema is incompatible/);

    const inspect = new DatabaseSync(dbPath);
    const objects = inspect.prepare(`
      SELECT name FROM sqlite_master
      WHERE name NOT LIKE 'sqlite_%'
      ORDER BY name
    `).all().map((row) => String(row.name));
    inspect.close();
    assert.deepEqual(objects, ["webhook_events"]);
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
