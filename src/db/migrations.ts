import type { DatabaseConnection } from "./shared.ts";

const baseMigration = `
DROP TABLE IF EXISTS issues;
DROP TABLE IF EXISTS issue_runs;
DROP TABLE IF EXISTS sessions;

CREATE TABLE IF NOT EXISTS webhook_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  webhook_id TEXT NOT NULL UNIQUE,
  received_at TEXT NOT NULL,
  event_type TEXT NOT NULL,
  issue_id TEXT,
  project_id TEXT,
  headers_json TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  signature_valid INTEGER NOT NULL,
  dedupe_status TEXT NOT NULL,
  processing_status TEXT NOT NULL DEFAULT 'pending'
);

CREATE TABLE IF NOT EXISTS tracked_issues (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  linear_issue_id TEXT NOT NULL,
  issue_key TEXT,
  title TEXT,
  issue_url TEXT,
  current_linear_state TEXT,
  desired_stage TEXT,
  desired_webhook_id TEXT,
  active_workspace_id INTEGER,
  active_pipeline_run_id INTEGER,
  active_stage_run_id INTEGER,
  latest_thread_id TEXT,
  status_comment_id TEXT,
  active_agent_session_id TEXT,
  pending_launch_input TEXT,
  lifecycle_status TEXT NOT NULL,
  last_webhook_at TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, linear_issue_id)
);

CREATE TABLE IF NOT EXISTS workspaces (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  linear_issue_id TEXT NOT NULL,
  branch_name TEXT NOT NULL,
  worktree_path TEXT NOT NULL,
  status TEXT NOT NULL,
  last_stage TEXT,
  last_thread_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pipeline_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  linear_issue_id TEXT NOT NULL,
  workspace_id INTEGER NOT NULL,
  status TEXT NOT NULL,
  current_stage TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT
);

CREATE TABLE IF NOT EXISTS stage_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pipeline_run_id INTEGER NOT NULL,
  project_id TEXT NOT NULL,
  linear_issue_id TEXT NOT NULL,
  workspace_id INTEGER NOT NULL,
  stage TEXT NOT NULL,
  status TEXT NOT NULL,
  trigger_webhook_id TEXT NOT NULL,
  workflow_file TEXT NOT NULL,
  prompt_text TEXT NOT NULL,
  thread_id TEXT,
  parent_thread_id TEXT,
  turn_id TEXT,
  summary_json TEXT,
  report_json TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT
);

CREATE TABLE IF NOT EXISTS thread_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stage_run_id INTEGER NOT NULL,
  thread_id TEXT NOT NULL,
  turn_id TEXT,
  method TEXT NOT NULL,
  event_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS queued_turn_inputs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stage_run_id INTEGER NOT NULL,
  thread_id TEXT,
  turn_id TEXT,
  source TEXT NOT NULL,
  body TEXT NOT NULL,
  delivered_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS linear_installations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL DEFAULT 'linear',
  workspace_id TEXT,
  workspace_name TEXT,
  workspace_key TEXT,
  actor_id TEXT,
  actor_name TEXT,
  access_token_ciphertext TEXT NOT NULL,
  refresh_token_ciphertext TEXT,
  scopes_json TEXT NOT NULL,
  token_type TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS project_installations (
  project_id TEXT PRIMARY KEY,
  installation_id INTEGER NOT NULL,
  linked_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_states (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  state TEXT NOT NULL UNIQUE,
  project_id TEXT,
  redirect_uri TEXT NOT NULL,
  actor TEXT NOT NULL,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  consumed_at TEXT,
  installation_id INTEGER,
  error_message TEXT
);
`;

function ensureColumnExists(connection: DatabaseConnection, tableName: string, columnName: string, definition: string): void {
  const columns = connection.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name?: string }>;
  if (columns.some((column) => String(column.name) === columnName)) {
    return;
  }

  connection.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
}

export function runPatchRelayMigrations(connection: DatabaseConnection): void {
  connection.exec(baseMigration);
  ensureColumnExists(connection, "tracked_issues", "status_comment_id", "TEXT");
  ensureColumnExists(connection, "tracked_issues", "active_agent_session_id", "TEXT");
  ensureColumnExists(connection, "tracked_issues", "pending_launch_input", "TEXT");
  ensureColumnExists(connection, "oauth_states", "status", "TEXT NOT NULL DEFAULT 'pending'");
  ensureColumnExists(connection, "oauth_states", "installation_id", "INTEGER");
  ensureColumnExists(connection, "oauth_states", "error_message", "TEXT");
}
