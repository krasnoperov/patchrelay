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

CREATE TABLE IF NOT EXISTS event_receipts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  external_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  received_at TEXT NOT NULL,
  acceptance_status TEXT NOT NULL,
  processing_status TEXT NOT NULL DEFAULT 'pending',
  project_id TEXT,
  linear_issue_id TEXT,
  headers_json TEXT,
  payload_json TEXT,
  UNIQUE(source, external_id)
);

CREATE TABLE IF NOT EXISTS issue_control (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  linear_issue_id TEXT NOT NULL,
  desired_stage TEXT,
  desired_receipt_id INTEGER,
  active_run_lease_id INTEGER,
  active_workspace_ownership_id INTEGER,
  service_owned_comment_id TEXT,
  active_agent_session_id TEXT,
  lifecycle_status TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, linear_issue_id)
);

CREATE TABLE IF NOT EXISTS workspace_ownership (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  linear_issue_id TEXT NOT NULL,
  branch_name TEXT NOT NULL,
  worktree_path TEXT NOT NULL,
  status TEXT NOT NULL,
  current_run_lease_id INTEGER,
  created_at TEXT NOT NULL,
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

CREATE TABLE IF NOT EXISTS run_leases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_control_id INTEGER NOT NULL,
  project_id TEXT NOT NULL,
  linear_issue_id TEXT NOT NULL,
  workspace_ownership_id INTEGER NOT NULL,
  stage TEXT NOT NULL,
  status TEXT NOT NULL,
  trigger_receipt_id INTEGER,
  thread_id TEXT,
  parent_thread_id TEXT,
  turn_id TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  failure_reason TEXT,
  FOREIGN KEY(issue_control_id) REFERENCES issue_control(id) ON DELETE CASCADE,
  FOREIGN KEY(workspace_ownership_id) REFERENCES workspace_ownership(id) ON DELETE CASCADE,
  FOREIGN KEY(trigger_receipt_id) REFERENCES event_receipts(id) ON DELETE SET NULL
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

CREATE TABLE IF NOT EXISTS obligations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  linear_issue_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  source TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  run_lease_id INTEGER,
  thread_id TEXT,
  turn_id TEXT,
  dedupe_key TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  FOREIGN KEY(run_lease_id) REFERENCES run_leases(id) ON DELETE SET NULL
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

CREATE INDEX IF NOT EXISTS idx_event_receipts_project_issue ON event_receipts(project_id, linear_issue_id);
CREATE INDEX IF NOT EXISTS idx_issue_control_ready ON issue_control(desired_stage, active_run_lease_id);
CREATE INDEX IF NOT EXISTS idx_run_leases_active ON run_leases(status, project_id, linear_issue_id);
CREATE INDEX IF NOT EXISTS idx_obligations_pending ON obligations(status, run_lease_id, kind);
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
