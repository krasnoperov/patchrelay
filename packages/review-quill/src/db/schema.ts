export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS webhook_events (
  delivery_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  repo_full_name TEXT,
  received_at TEXT NOT NULL,
  processed_at TEXT,
  ignored_reason TEXT
);

CREATE TABLE IF NOT EXISTS review_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_full_name TEXT NOT NULL,
  pr_number INTEGER NOT NULL,
  head_sha TEXT NOT NULL,
  status TEXT NOT NULL,
  conclusion TEXT,
  summary TEXT,
  pr_title TEXT,
  thread_id TEXT,
  turn_id TEXT,
  external_check_run_id INTEGER,
  patch_id TEXT,
  integration_tree_id TEXT,
  review_surface_mode TEXT,
  base_sha TEXT,
  prior_attempt_id INTEGER,
  review_body TEXT,
  review_event TEXT,
  publication_mode TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE(repo_full_name, pr_number, head_sha)
);

CREATE INDEX IF NOT EXISTS idx_review_attempts_repo_pr
  ON review_attempts(repo_full_name, pr_number, created_at DESC);
`;
// idx_review_attempts_patch and idx_review_attempts_patch_tree are
// created in SqliteStore *after* addColumnIfMissing populates the
// patch_id / integration_tree_id columns. Legacy databases were
// created before those columns existed, so referencing them here
// (CREATE TABLE IF NOT EXISTS skips the body when the table is
// already present) would fail with "no such column: patch_id".
