import type { DatabaseConnection } from "./shared.ts";

const legacyBaseMigration = `
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
  desired_stage_source_run_lease_id INTEGER,
  continuation_barrier_receipt_id INTEGER,
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

const newSchemaMigration = `
-- New unified issues table
CREATE TABLE IF NOT EXISTS issues (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  linear_issue_id TEXT NOT NULL,
  issue_key TEXT,
  title TEXT,
  url TEXT,
  selected_workflow_id TEXT,
  current_linear_state TEXT,
  desired_stage TEXT,
  branch_name TEXT,
  worktree_path TEXT,
  thread_id TEXT,
  active_run_id INTEGER,
  status_comment_id TEXT,
  agent_session_id TEXT,
  continuation_barrier_at TEXT,
  lifecycle_status TEXT NOT NULL DEFAULT 'idle',
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, linear_issue_id)
);

-- New unified runs table
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_id INTEGER NOT NULL REFERENCES issues(id),
  project_id TEXT NOT NULL,
  linear_issue_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  status TEXT NOT NULL,
  workflow_file TEXT,
  prompt_text TEXT,
  thread_id TEXT,
  turn_id TEXT,
  parent_thread_id TEXT,
  summary_json TEXT,
  report_json TEXT,
  failure_reason TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_issues_project_issue ON issues(project_id, linear_issue_id);
CREATE INDEX IF NOT EXISTS idx_issues_key ON issues(issue_key);
CREATE INDEX IF NOT EXISTS idx_issues_ready ON issues(desired_stage, active_run_id);
CREATE INDEX IF NOT EXISTS idx_runs_issue ON runs(issue_id);
CREATE INDEX IF NOT EXISTS idx_runs_active ON runs(status, project_id, linear_issue_id);
CREATE INDEX IF NOT EXISTS idx_runs_thread ON runs(thread_id);
`;

const dataMigration = `
-- Migrate issue data from old tables into new issues table
INSERT OR IGNORE INTO issues (
  project_id, linear_issue_id, issue_key, title, url,
  selected_workflow_id, current_linear_state, desired_stage,
  branch_name, worktree_path, thread_id, active_run_id,
  status_comment_id, agent_session_id, continuation_barrier_at,
  lifecycle_status, updated_at
)
SELECT
  COALESCE(ic.project_id, ip.project_id) AS project_id,
  COALESCE(ic.linear_issue_id, ip.linear_issue_id) AS linear_issue_id,
  ip.issue_key,
  ip.title,
  ip.issue_url,
  ic.selected_workflow_id,
  ip.current_linear_state,
  ic.desired_stage,
  wo.branch_name,
  wo.worktree_path,
  rl.thread_id,
  ic.active_run_lease_id,
  ic.service_owned_comment_id,
  ic.active_agent_session_id,
  CASE
    WHEN ic.continuation_barrier_receipt_id IS NOT NULL
    THEN COALESCE(
      (SELECT er.received_at FROM event_receipts er WHERE er.id = ic.continuation_barrier_receipt_id),
      ic.updated_at
    )
    ELSE NULL
  END,
  COALESCE(ic.lifecycle_status, 'idle'),
  COALESCE(ic.updated_at, ip.updated_at)
FROM (
  SELECT project_id, linear_issue_id FROM issue_control
  UNION
  SELECT project_id, linear_issue_id FROM issue_projection
) AS all_issues
LEFT JOIN issue_control ic ON ic.project_id = all_issues.project_id AND ic.linear_issue_id = all_issues.linear_issue_id
LEFT JOIN issue_projection ip ON ip.project_id = all_issues.project_id AND ip.linear_issue_id = all_issues.linear_issue_id
LEFT JOIN workspace_ownership wo ON wo.project_id = all_issues.project_id AND wo.linear_issue_id = all_issues.linear_issue_id
LEFT JOIN run_leases rl ON rl.id = ic.active_run_lease_id;

-- Migrate runs from old run_leases + run_reports into new runs table
INSERT OR IGNORE INTO runs (
  issue_id, project_id, linear_issue_id, stage, status,
  workflow_file, prompt_text, thread_id, turn_id, parent_thread_id,
  summary_json, report_json, failure_reason,
  started_at, ended_at
)
SELECT
  i.id,
  rl.project_id,
  rl.linear_issue_id,
  rl.stage,
  rl.status,
  rl.workflow_file,
  rl.prompt_text,
  rl.thread_id,
  rl.turn_id,
  rl.parent_thread_id,
  rr.summary_json,
  rr.report_json,
  rl.failure_reason,
  rl.started_at,
  rl.ended_at
FROM run_leases rl
JOIN issues i ON i.project_id = rl.project_id AND i.linear_issue_id = rl.linear_issue_id
LEFT JOIN run_reports rr ON rr.run_lease_id = rl.id;

-- Update active_run_id references in issues to point to new runs table
-- The old active_run_lease_id pointed to run_leases; we need to find the corresponding new run
UPDATE issues SET active_run_id = (
  SELECT r.id FROM runs r
  WHERE r.project_id = issues.project_id
    AND r.linear_issue_id = issues.linear_issue_id
    AND r.status IN ('queued', 'running')
  ORDER BY r.id DESC
  LIMIT 1
)
WHERE active_run_id IS NOT NULL;
`;

function hasTable(connection: DatabaseConnection, tableName: string): boolean {
  const row = connection.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(tableName);
  return row !== undefined;
}

export function runPatchRelayMigrations(connection: DatabaseConnection): void {
  // Check if we're on the new schema already
  if (hasTable(connection, "issues") && hasTable(connection, "runs")) {
    // New schema exists, just ensure auth tables and operator_feed_events exist
    connection.exec(newSchemaMigration);
    ensureAuthTables(connection);
    ensureOperatorFeedTable(connection);
    ensureWebhookEventsTable(connection);
    ensureRunThreadEventsTable(connection);
    return;
  }

  // Check if old schema exists and needs migration
  if (hasTable(connection, "issue_control") || hasTable(connection, "issue_projection")) {
    // Run old base migration to ensure all old tables exist fully
    connection.exec(legacyBaseMigration);
    // Apply old ALTER TABLE migrations
    applyLegacyAlterMigrations(connection);
    // Create new tables
    connection.exec(newSchemaMigration);
    // Migrate data
    connection.exec(dataMigration);
    return;
  }

  // Fresh install - create new schema directly
  connection.exec(newSchemaMigration);
  ensureAuthTables(connection);
  ensureOperatorFeedTable(connection);
  ensureWebhookEventsTable(connection);
  ensureRunThreadEventsTable(connection);
}

function ensureWebhookEventsTable(connection: DatabaseConnection): void {
  connection.exec(`
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
  `);
}

function ensureRunThreadEventsTable(connection: DatabaseConnection): void {
  connection.exec(`
    CREATE TABLE IF NOT EXISTS run_thread_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL,
      thread_id TEXT NOT NULL,
      turn_id TEXT,
      method TEXT NOT NULL,
      event_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_run_thread_events_run ON run_thread_events(run_id, id);
  `);
}

function ensureAuthTables(connection: DatabaseConnection): void {
  connection.exec(`
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
  `);
}

function ensureOperatorFeedTable(connection: DatabaseConnection): void {
  connection.exec(`
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
    CREATE INDEX IF NOT EXISTS idx_operator_feed_events_issue ON operator_feed_events(issue_key, id);
    CREATE INDEX IF NOT EXISTS idx_operator_feed_events_project ON operator_feed_events(project_id, id);
  `);
}

function applyLegacyAlterMigrations(connection: DatabaseConnection): void {
  const alters = [
    "ALTER TABLE issue_control ADD COLUMN selected_workflow_id TEXT",
    "ALTER TABLE issue_control ADD COLUMN desired_stage_source_run_lease_id INTEGER",
    "ALTER TABLE issue_control ADD COLUMN continuation_barrier_receipt_id INTEGER",
    "ALTER TABLE operator_feed_events ADD COLUMN workflow_id TEXT",
    "ALTER TABLE operator_feed_events ADD COLUMN next_stage TEXT",
  ];
  for (const alter of alters) {
    try {
      connection.exec(alter);
    } catch {
      // Column already exists on upgraded installs.
    }
  }
}
