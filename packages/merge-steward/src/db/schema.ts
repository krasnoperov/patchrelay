import type { DatabaseConnection } from "./shared.ts";

/** Create the current steward schema and reject any other schema version. */
export function ensureSchema(connection: DatabaseConnection): void {
  const existingTables = connection.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
  `).all();
  if (existingTables.length > 0) {
    assertCurrentSchema(connection);
    return;
  }
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
      pr_title TEXT,
      candidate_kind TEXT,
      candidate_policy_fingerprint TEXT,
      candidate_ref TEXT,
      candidate_sha TEXT,
      candidate_based_on TEXT,
      base_ref_name TEXT,
      wait_detail TEXT,
      post_merge_status TEXT,
      post_merge_sha TEXT,
      post_merge_summary TEXT,
      post_merge_checked_at TEXT,
      decided_at TEXT,
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
  // Must match TERMINAL_STATUSES in types.ts: merged, evicted, dequeued
  connection.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_one_active_per_pr
      ON queue_entries(repo_id, pr_number)
      WHERE status NOT IN ('merged', 'evicted', 'dequeued')
  `);
  assertCurrentSchema(connection);
}

const QUEUE_ENTRY_COLUMNS = [
  "id", "repo_id", "pr_number", "branch", "head_sha", "base_sha", "status",
  "position", "priority", "generation", "ci_run_id", "ci_retries",
  "retry_attempts", "max_retries", "last_failed_base_sha", "issue_key",
  "pr_title", "candidate_kind", "candidate_policy_fingerprint", "candidate_ref",
  "candidate_sha", "candidate_based_on", "base_ref_name", "wait_detail",
  "post_merge_status", "post_merge_sha", "post_merge_summary",
  "post_merge_checked_at", "decided_at", "enqueued_at", "updated_at",
] as const;

const QUEUE_INCIDENT_COLUMNS = [
  "id", "entry_id", "at", "failure_class", "context_json", "outcome",
] as const;

const QUEUE_EVENT_COLUMNS = [
  "id", "entry_id", "at", "from_status", "to_status", "detail", "base_sha",
] as const;

const REQUIRED_INDEXES = [
  "idx_queue_entries_repo_status",
  "idx_queue_entries_repo_position",
  "idx_queue_incidents_entry",
  "idx_queue_events_entry",
  "idx_one_active_per_pr",
] as const;

function assertCurrentSchema(connection: DatabaseConnection): void {
  assertExactColumns(connection, "queue_entries", QUEUE_ENTRY_COLUMNS);
  assertExactColumns(connection, "queue_incidents", QUEUE_INCIDENT_COLUMNS);
  assertExactColumns(connection, "queue_events", QUEUE_EVENT_COLUMNS);
  const indexes = new Set(connection.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all()
    .map((row) => String(row.name)));
  const missing = REQUIRED_INDEXES.filter((index) => !indexes.has(index));
  if (missing.length > 0) {
    throw new Error(`Merge Steward database schema is incompatible (missing indexes: ${missing.join(", ")})`);
  }
}

function assertExactColumns(
  connection: DatabaseConnection,
  table: string,
  expected: readonly string[],
): void {
  const actual = connection.prepare(`PRAGMA table_info(${table})`).all()
    .map((row) => String(row.name));
  const missing = expected.filter((column) => !actual.includes(column));
  const unexpected = actual.filter((column) => !expected.includes(column));
  if (missing.length === 0 && unexpected.length === 0) return;

  const details = [
    ...(missing.length > 0 ? [`missing: ${missing.join(", ")}`] : []),
    ...(unexpected.length > 0 ? [`unexpected: ${unexpected.join(", ")}`] : []),
  ].join("; ");
  throw new Error(`Merge Steward database schema is incompatible (${table}: ${details})`);
}
