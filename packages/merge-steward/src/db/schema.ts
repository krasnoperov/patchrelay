import type { DatabaseConnection } from "./shared.ts";

/**
 * Create and upgrade the steward's SQLite schema. Idempotent — safe to call
 * on every startup. Migrations preserve active queue state, then remove
 * obsolete columns so the runtime has one candidate model.
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
      candidate_kind TEXT,
      candidate_policy_fingerprint TEXT,
      candidate_ref TEXT,
      candidate_sha TEXT,
      candidate_based_on TEXT,
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
  ensureColumn(connection, "queue_entries", "post_merge_status", "TEXT");
  ensureColumn(connection, "queue_entries", "post_merge_sha", "TEXT");
  ensureColumn(connection, "queue_entries", "post_merge_summary", "TEXT");
  ensureColumn(connection, "queue_entries", "post_merge_checked_at", "TEXT");
  ensureColumn(connection, "queue_entries", "wait_detail", "TEXT");
  ensureColumn(connection, "queue_entries", "pr_title", "TEXT");
  ensureColumn(connection, "queue_entries", "candidate_kind", "TEXT");
  ensureColumn(connection, "queue_entries", "candidate_policy_fingerprint", "TEXT");
  ensureColumn(connection, "queue_entries", "candidate_ref", "TEXT");
  ensureColumn(connection, "queue_entries", "candidate_sha", "TEXT");
  ensureColumn(connection, "queue_entries", "candidate_based_on", "TEXT");
  ensureColumn(connection, "queue_entries", "base_ref_name", "TEXT");
  ensureColumn(connection, "queue_entries", "decided_at", "TEXT");
  migrateLegacyCandidateColumns(connection);
  // Retire patch-equivalence caches from older installations. Candidate
  // validity is SHA-bound; preserving these columns would imply otherwise.
  dropColumnIfPresent(connection, "queue_entries", "head_patch_id");
  dropColumnIfPresent(connection, "queue_entries", "spec_tree_id");
  connection.exec(`
    UPDATE queue_entries
       SET candidate_kind = 'integration'
     WHERE candidate_kind IS NULL
       AND candidate_sha IS NOT NULL
       AND candidate_ref IS NOT NULL
  `);
  connection.exec(`
    UPDATE queue_entries
       SET post_merge_status = 'pending'
     WHERE status = 'merged'
       AND post_merge_status IS NULL
  `);
  // Backfill decided_at for already-terminal rows so historic entries show a
  // sensible duration/age; updated_at is the best estimate we have for them.
  connection.exec(`
    UPDATE queue_entries
       SET decided_at = updated_at
     WHERE decided_at IS NULL
       AND status IN ('merged', 'evicted', 'dequeued')
  `);

  // Must match TERMINAL_STATUSES in types.ts: merged, evicted, dequeued
  connection.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_one_active_per_pr
      ON queue_entries(repo_id, pr_number)
      WHERE status NOT IN ('merged', 'evicted', 'dequeued')
  `);
}

function migrateLegacyCandidateColumns(connection: DatabaseConnection): void {
  const legacyColumns = [
    ["spec_branch", "candidate_ref"],
    ["spec_sha", "candidate_sha"],
    ["spec_based_on", "candidate_based_on"],
  ] as const;

  for (const [legacy, candidate] of legacyColumns) {
    if (!hasColumn(connection, "queue_entries", legacy)) continue;
    connection.exec(`
      UPDATE queue_entries
         SET ${candidate} = ${legacy}
       WHERE ${candidate} IS NULL
         AND ${legacy} IS NOT NULL
    `);
  }

  // Derive kind while the legacy ref is still available, then remove all
  // old candidate representations in this same startup migration.
  connection.exec(`
    UPDATE queue_entries
       SET candidate_kind = CASE
         WHEN candidate_sha = head_sha AND candidate_ref IS NULL THEN 'head'
         WHEN candidate_sha IS NOT NULL THEN 'integration'
         ELSE NULL
       END
     WHERE candidate_kind IS NULL
  `);

  for (const [legacy] of legacyColumns) {
    dropColumnIfPresent(connection, "queue_entries", legacy);
  }
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

function dropColumnIfPresent(
  connection: DatabaseConnection,
  table: string,
  column: string,
): void {
  if (!hasColumn(connection, table, column)) {
    return;
  }
  connection.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
}
