import type { DatabaseConnection } from "./shared.ts";

const baseMigration = `
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
  selected_workflow_id TEXT,
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

CREATE TABLE IF NOT EXISTS issue_projection (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  linear_issue_id TEXT NOT NULL,
  issue_key TEXT,
  title TEXT,
  issue_url TEXT,
  current_linear_state TEXT,
  last_webhook_at TEXT,
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

CREATE TABLE IF NOT EXISTS run_leases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_control_id INTEGER NOT NULL,
  project_id TEXT NOT NULL,
  linear_issue_id TEXT NOT NULL,
  workspace_ownership_id INTEGER NOT NULL,
  stage TEXT NOT NULL,
  status TEXT NOT NULL,
  trigger_receipt_id INTEGER,
  workflow_file TEXT NOT NULL DEFAULT '',
  prompt_text TEXT NOT NULL DEFAULT '',
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

CREATE TABLE IF NOT EXISTS issue_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  linear_issue_id TEXT NOT NULL,
  workspace_ownership_id INTEGER NOT NULL,
  run_lease_id INTEGER,
  thread_id TEXT NOT NULL UNIQUE,
  parent_thread_id TEXT,
  source TEXT NOT NULL,
  linked_agent_session_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_opened_at TEXT,
  FOREIGN KEY(workspace_ownership_id) REFERENCES workspace_ownership(id) ON DELETE CASCADE,
  FOREIGN KEY(run_lease_id) REFERENCES run_leases(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS run_reports (
  run_lease_id INTEGER PRIMARY KEY,
  summary_json TEXT,
  report_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(run_lease_id) REFERENCES run_leases(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS run_thread_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_lease_id INTEGER NOT NULL,
  thread_id TEXT NOT NULL,
  turn_id TEXT,
  method TEXT NOT NULL,
  event_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(run_lease_id) REFERENCES run_leases(id) ON DELETE CASCADE
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

CREATE TABLE IF NOT EXISTS operator_feed_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  level TEXT NOT NULL,
  kind TEXT NOT NULL,
  summary TEXT NOT NULL,
  detail TEXT,
  issue_key TEXT,
  project_id TEXT,
  stage TEXT,
  status TEXT,
  workflow_id TEXT,
  next_stage TEXT
);

CREATE INDEX IF NOT EXISTS idx_event_receipts_project_issue ON event_receipts(project_id, linear_issue_id);
CREATE INDEX IF NOT EXISTS idx_issue_control_ready ON issue_control(desired_stage, active_run_lease_id);
CREATE INDEX IF NOT EXISTS idx_issue_projection_issue_key ON issue_projection(issue_key);
CREATE INDEX IF NOT EXISTS idx_issue_sessions_issue ON issue_sessions(project_id, linear_issue_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_issue_sessions_last_opened ON issue_sessions(project_id, linear_issue_id, last_opened_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_run_leases_active ON run_leases(status, project_id, linear_issue_id);
CREATE INDEX IF NOT EXISTS idx_run_leases_thread ON run_leases(thread_id);
CREATE INDEX IF NOT EXISTS idx_run_thread_events_run ON run_thread_events(run_lease_id, id);
CREATE INDEX IF NOT EXISTS idx_operator_feed_events_issue ON operator_feed_events(issue_key, id);
CREATE INDEX IF NOT EXISTS idx_operator_feed_events_project ON operator_feed_events(project_id, id);
CREATE INDEX IF NOT EXISTS idx_obligations_pending ON obligations(status, run_lease_id, kind);
CREATE UNIQUE INDEX IF NOT EXISTS idx_obligations_dedupe
ON obligations(run_lease_id, kind, dedupe_key)
WHERE dedupe_key IS NOT NULL;
`;

export function runPatchRelayMigrations(connection: DatabaseConnection): void {
  connection.exec(baseMigration);
  try {
    connection.exec("ALTER TABLE issue_control ADD COLUMN selected_workflow_id TEXT");
  } catch {
    // Column already exists on upgraded installs.
  }
  try {
    connection.exec("ALTER TABLE operator_feed_events ADD COLUMN workflow_id TEXT");
  } catch {
    // Column already exists on upgraded installs.
  }
  try {
    connection.exec("ALTER TABLE operator_feed_events ADD COLUMN next_stage TEXT");
  } catch {
    // Column already exists on upgraded installs.
  }
}
