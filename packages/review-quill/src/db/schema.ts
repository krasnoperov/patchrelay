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
  thread_id TEXT,
  turn_id TEXT,
  external_check_run_id INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE(repo_full_name, pr_number, head_sha)
);

CREATE INDEX IF NOT EXISTS idx_review_attempts_repo_pr
  ON review_attempts(repo_full_name, pr_number, created_at DESC);
`;
