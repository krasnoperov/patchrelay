import type { DatabaseConnection } from "./shared.ts";

/**
 * Create the steward's SQLite schema. Idempotent — safe to call on every startup.
 * No migration path: this is the final shape. There are no legacy installations.
 */
export function ensureSchema(connection: DatabaseConnection): void {
  connection.exec(`
    CREATE TABLE IF NOT EXISTS queue_entries (
      id TEXT PRIMARY KEY,
      repo_id TEXT NOT NULL,
      pr_number INTEGER NOT NULL,
      branch TEXT NOT NULL,
      head_sha TEXT NOT NULL,
      base_sha TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      position INTEGER NOT NULL,
      priority INTEGER NOT NULL DEFAULT 0,
      generation INTEGER NOT NULL DEFAULT 0,
      ci_run_id TEXT,
      ci_retries INTEGER NOT NULL DEFAULT 0,
      retry_attempts INTEGER NOT NULL DEFAULT 0,
      max_retries INTEGER NOT NULL DEFAULT 3,
      last_failed_base_sha TEXT,
      issue_key TEXT,
      spec_branch TEXT,
      spec_sha TEXT,
      spec_based_on TEXT,
      post_merge_status TEXT,
      post_merge_sha TEXT,
      post_merge_summary TEXT,
      post_merge_checked_at TEXT,
      enqueued_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  connection.exec(`
    CREATE TABLE IF NOT EXISTS queue_incidents (
      id TEXT PRIMARY KEY,
      entry_id TEXT NOT NULL REFERENCES queue_entries(id),
      at TEXT NOT NULL,
      failure_class TEXT NOT NULL,
      context_json TEXT NOT NULL,
      outcome TEXT NOT NULL DEFAULT 'open'
    )
  `);

  connection.exec(`
    CREATE TABLE IF NOT EXISTS queue_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entry_id TEXT NOT NULL,
      at TEXT NOT NULL,
      from_status TEXT,
      to_status TEXT NOT NULL,
      detail TEXT,
      base_sha TEXT
    )
  `);

  connection.exec(`
    CREATE INDEX IF NOT EXISTS idx_queue_entries_repo_status
      ON queue_entries(repo_id, status)
  `);
  connection.exec(`
    CREATE INDEX IF NOT EXISTS idx_queue_entries_repo_position
      ON queue_entries(repo_id, position)
  `);
  connection.exec(`
    CREATE INDEX IF NOT EXISTS idx_queue_incidents_entry
      ON queue_incidents(entry_id)
  `);
  connection.exec(`
    CREATE INDEX IF NOT EXISTS idx_queue_events_entry
      ON queue_events(entry_id, id)
  `);
  ensureColumn(connection, "queue_entries", "post_merge_status", "TEXT");
  ensureColumn(connection, "queue_entries", "post_merge_sha", "TEXT");
  ensureColumn(connection, "queue_entries", "post_merge_summary", "TEXT");
  ensureColumn(connection, "queue_entries", "post_merge_checked_at", "TEXT");
  connection.exec(`
    UPDATE queue_entries
       SET post_merge_status = 'pending'
     WHERE status = 'merged'
       AND post_merge_status IS NULL
  `);

  // Must match TERMINAL_STATUSES in types.ts: merged, evicted, dequeued
  connection.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_one_active_per_pr
      ON queue_entries(repo_id, pr_number)
      WHERE status NOT IN ('merged', 'evicted', 'dequeued')
  `);
}

function hasColumn(connection: DatabaseConnection, table: string, column: string): boolean {
  const rows = connection.prepare(`PRAGMA table_info(${table})`).all();
  for (const row of rows) {
    if (String((row as Record<string, unknown>).name) === column) {
      return true;
    }
  }
  return false;
}

function ensureColumn(
  connection: DatabaseConnection,
  table: string,
  column: string,
  type: string,
): void {
  if (hasColumn(connection, table, column)) {
    return;
  }
  connection.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}
