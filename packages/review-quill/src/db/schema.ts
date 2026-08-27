import type { SqliteConnection } from "./shared.ts";

const TABLE_SQL = `
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
  prompt_fingerprint TEXT,
  thread_id TEXT,
  turn_id TEXT,
  external_check_run_id INTEGER,
  patch_id TEXT,
  pr_base_sha TEXT,
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
`;

const INDEX_SQL = `
CREATE INDEX IF NOT EXISTS idx_review_attempts_repo_pr
  ON review_attempts(repo_full_name, pr_number, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_webhook_events_retention
  ON webhook_events(processed_at, received_at);

CREATE INDEX IF NOT EXISTS idx_review_attempts_patch
  ON review_attempts(repo_full_name, pr_number, patch_id);
`;

const EXPECTED_COLUMNS = {
  webhook_events: [
    "delivery_id", "event_type", "repo_full_name", "received_at",
    "processed_at", "ignored_reason",
  ],
  review_attempts: [
    "id", "repo_full_name", "pr_number", "head_sha", "status", "conclusion",
    "summary", "pr_title", "prompt_fingerprint", "thread_id", "turn_id",
    "external_check_run_id", "patch_id", "pr_base_sha", "base_sha",
    "prior_attempt_id", "review_body", "review_event", "publication_mode",
    "created_at", "updated_at", "completed_at",
  ],
} as const;

const REQUIRED_INDEXES = [
  "idx_review_attempts_repo_pr",
  "idx_webhook_events_retention",
  "idx_review_attempts_patch",
] as const;

export function ensureSchema(connection: SqliteConnection): void {
  const existingTables = connection.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
  `).all();
  if (existingTables.length === 0) {
    connection.exec(TABLE_SQL);
    connection.exec(INDEX_SQL);
    return;
  }
  for (const [table, expected] of Object.entries(EXPECTED_COLUMNS)) {
    assertExactColumns(connection, table, expected);
  }
  assertRequiredIndexes(connection);
}

function assertRequiredIndexes(connection: SqliteConnection): void {
  const actual = new Set(connection.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all()
    .map((row) => String(row.name)));
  const missing = REQUIRED_INDEXES.filter((index) => !actual.has(index));
  if (missing.length > 0) {
    throw new Error(`Review Quill database schema is incompatible (missing indexes: ${missing.join(", ")})`);
  }
}

function assertExactColumns(
  connection: SqliteConnection,
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
  throw new Error(`Review Quill database schema is incompatible (${table}: ${details})`);
}
