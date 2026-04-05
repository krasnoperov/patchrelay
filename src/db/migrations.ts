import type { DatabaseConnection } from "./shared.ts";

const schema = `
CREATE TABLE IF NOT EXISTS issues (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  linear_issue_id TEXT NOT NULL,
  issue_key TEXT,
  title TEXT,
  url TEXT,
  current_linear_state TEXT,
  current_linear_state_type TEXT,
  factory_state TEXT NOT NULL DEFAULT 'delegated',
  pending_run_type TEXT,
  pending_run_context_json TEXT,
  branch_name TEXT,
  branch_owner TEXT NOT NULL DEFAULT 'patchrelay',
  branch_ownership_changed_at TEXT,
  worktree_path TEXT,
  thread_id TEXT,
  active_run_id INTEGER,
  status_comment_id TEXT,
  agent_session_id TEXT,
  pr_number INTEGER,
  pr_url TEXT,
  pr_state TEXT,
  pr_head_sha TEXT,
  pr_author_login TEXT,
  pr_review_state TEXT,
  pr_check_status TEXT,
  ci_repair_attempts INTEGER NOT NULL DEFAULT 0,
  queue_repair_attempts INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, linear_issue_id)
);

CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_id INTEGER NOT NULL REFERENCES issues(id),
  project_id TEXT NOT NULL,
  linear_issue_id TEXT NOT NULL,
  run_type TEXT NOT NULL DEFAULT 'implementation',
  status TEXT NOT NULL,
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

CREATE TABLE IF NOT EXISTS issue_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  linear_issue_id TEXT NOT NULL,
  issue_key TEXT,
  repo_id TEXT NOT NULL,
  branch_name TEXT,
  worktree_path TEXT,
  pr_number INTEGER,
  pr_head_sha TEXT,
  pr_author_login TEXT,
  session_state TEXT NOT NULL DEFAULT 'idle',
  waiting_reason TEXT,
  summary_text TEXT,
  active_thread_id TEXT,
  thread_generation INTEGER NOT NULL DEFAULT 0,
  active_run_id INTEGER,
  last_run_type TEXT,
  last_wake_reason TEXT,
  ci_repair_attempts INTEGER NOT NULL DEFAULT 0,
  queue_repair_attempts INTEGER NOT NULL DEFAULT 0,
  review_fix_attempts INTEGER NOT NULL DEFAULT 0,
  lease_id TEXT,
  worker_id TEXT,
  leased_until TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, linear_issue_id)
);

CREATE TABLE IF NOT EXISTS issue_session_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  linear_issue_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  event_json TEXT,
  dedupe_key TEXT,
  created_at TEXT NOT NULL,
  processed_at TEXT,
  consumed_by_run_id INTEGER
);

CREATE TABLE IF NOT EXISTS webhook_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  webhook_id TEXT NOT NULL UNIQUE,
  received_at TEXT NOT NULL,
  project_id TEXT,
  payload_json TEXT,
  processing_status TEXT NOT NULL DEFAULT 'pending'
);

CREATE TABLE IF NOT EXISTS run_thread_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL,
  thread_id TEXT NOT NULL,
  turn_id TEXT,
  method TEXT NOT NULL,
  event_json TEXT NOT NULL,
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

CREATE TABLE IF NOT EXISTS repository_links (
  github_repo TEXT PRIMARY KEY,
  local_path TEXT NOT NULL,
  installation_id INTEGER NOT NULL,
  linear_team_ids_json TEXT NOT NULL DEFAULT '[]',
  linear_project_ids_json TEXT NOT NULL DEFAULT '[]',
  issue_key_prefixes_json TEXT NOT NULL DEFAULT '[]',
  linked_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS linear_catalog_teams (
  installation_id INTEGER NOT NULL,
  team_id TEXT NOT NULL,
  team_key TEXT,
  team_name TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (installation_id, team_id)
);

CREATE TABLE IF NOT EXISTS linear_catalog_projects (
  installation_id INTEGER NOT NULL,
  project_id TEXT NOT NULL,
  project_name TEXT,
  team_ids_json TEXT NOT NULL DEFAULT '[]',
  active INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (installation_id, project_id)
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
  status TEXT
);

CREATE TABLE IF NOT EXISTS issue_dependencies (
  project_id TEXT NOT NULL,
  linear_issue_id TEXT NOT NULL,
  blocker_linear_issue_id TEXT NOT NULL,
  blocker_issue_key TEXT,
  blocker_title TEXT,
  blocker_current_linear_state TEXT,
  blocker_current_linear_state_type TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, linear_issue_id, blocker_linear_issue_id)
);

CREATE INDEX IF NOT EXISTS idx_issues_project ON issues(project_id, linear_issue_id);
CREATE INDEX IF NOT EXISTS idx_issues_key ON issues(issue_key);
CREATE INDEX IF NOT EXISTS idx_issues_ready ON issues(pending_run_type, active_run_id);
CREATE INDEX IF NOT EXISTS idx_issues_branch ON issues(branch_name);
CREATE INDEX IF NOT EXISTS idx_runs_issue ON runs(issue_id);
CREATE INDEX IF NOT EXISTS idx_runs_active ON runs(status, project_id, linear_issue_id);
CREATE INDEX IF NOT EXISTS idx_runs_thread ON runs(thread_id);
CREATE INDEX IF NOT EXISTS idx_issue_sessions_issue ON issue_sessions(project_id, linear_issue_id);
CREATE INDEX IF NOT EXISTS idx_issue_sessions_key ON issue_sessions(issue_key);
CREATE INDEX IF NOT EXISTS idx_issue_sessions_lease ON issue_sessions(leased_until, session_state);
CREATE INDEX IF NOT EXISTS idx_issue_session_events_issue ON issue_session_events(project_id, linear_issue_id, id);
CREATE INDEX IF NOT EXISTS idx_issue_session_events_pending ON issue_session_events(processed_at, project_id, linear_issue_id, id);
CREATE INDEX IF NOT EXISTS idx_run_thread_events_run ON run_thread_events(run_id, id);
CREATE INDEX IF NOT EXISTS idx_operator_feed_events_issue ON operator_feed_events(issue_key, id);
CREATE INDEX IF NOT EXISTS idx_operator_feed_events_project ON operator_feed_events(project_id, id);
CREATE INDEX IF NOT EXISTS idx_repository_links_installation ON repository_links(installation_id, github_repo);
CREATE INDEX IF NOT EXISTS idx_linear_catalog_teams_installation ON linear_catalog_teams(installation_id, team_key, team_name);
CREATE INDEX IF NOT EXISTS idx_linear_catalog_projects_installation ON linear_catalog_projects(installation_id, project_name);
CREATE INDEX IF NOT EXISTS idx_issue_dependencies_issue ON issue_dependencies(project_id, linear_issue_id);
CREATE INDEX IF NOT EXISTS idx_issue_dependencies_blocker ON issue_dependencies(project_id, blocker_linear_issue_id);
`;

export function runPatchRelayMigrations(connection: DatabaseConnection): void {
  connection.exec(schema);

  // Clean up stale dedupe-only webhook records (no payload, never processable)
  connection.prepare(
    "UPDATE webhook_events SET processing_status = 'processed' WHERE processing_status = 'pending' AND payload_json IS NULL",
  ).run();

  // Add pending_merge_prep column for merge queue stewardship
  addColumnIfMissing(connection, "issues", "pending_merge_prep", "INTEGER NOT NULL DEFAULT 0");

  // Explicit PR branch ownership hand-off between PatchRelay and MergeSteward
  addColumnIfMissing(connection, "issues", "branch_owner", "TEXT NOT NULL DEFAULT 'patchrelay'");
  addColumnIfMissing(connection, "issues", "branch_ownership_changed_at", "TEXT");
  connection.prepare("UPDATE issues SET branch_owner = 'patchrelay' WHERE branch_owner IS NULL OR branch_owner != 'patchrelay'").run();

  // Add merge_prep_attempts for retry budget / escalation
  addColumnIfMissing(connection, "issues", "merge_prep_attempts", "INTEGER NOT NULL DEFAULT 0");

  // Add review_fix_attempts counter
  addColumnIfMissing(connection, "issues", "review_fix_attempts", "INTEGER NOT NULL DEFAULT 0");

  // Collapse awaiting_review into pr_open (state normalization)
  connection.prepare("UPDATE issues SET factory_state = 'pr_open' WHERE factory_state = 'awaiting_review'").run();

  // Add Linear issue description, priority, estimate
  addColumnIfMissing(connection, "issues", "description", "TEXT");
  addColumnIfMissing(connection, "issues", "priority", "INTEGER");
  addColumnIfMissing(connection, "issues", "estimate", "REAL");
  addColumnIfMissing(connection, "issues", "current_linear_state_type", "TEXT");
  addColumnIfMissing(connection, "issue_dependencies", "blocker_current_linear_state_type", "TEXT");

  // Zombie/stale recovery backoff
  addColumnIfMissing(connection, "issues", "zombie_recovery_attempts", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(connection, "issues", "last_zombie_recovery_at", "TEXT");

  // Preserve GitHub failure provenance so reconciliation can distinguish
  // branch CI failures from merge-queue evictions after webhook delivery.
  addColumnIfMissing(connection, "issues", "pr_head_sha", "TEXT");
  addColumnIfMissing(connection, "issues", "pr_author_login", "TEXT");
  addColumnIfMissing(connection, "issues", "last_github_failure_source", "TEXT");
  addColumnIfMissing(connection, "issues", "last_github_failure_head_sha", "TEXT");
  addColumnIfMissing(connection, "issues", "last_github_failure_signature", "TEXT");
  addColumnIfMissing(connection, "issues", "last_github_failure_check_name", "TEXT");
  addColumnIfMissing(connection, "issues", "last_github_failure_check_url", "TEXT");
  addColumnIfMissing(connection, "issues", "last_github_failure_context_json", "TEXT");
  addColumnIfMissing(connection, "issues", "last_github_failure_at", "TEXT");
  addColumnIfMissing(connection, "issues", "last_github_ci_snapshot_head_sha", "TEXT");
  addColumnIfMissing(connection, "issues", "last_github_ci_snapshot_gate_check_name", "TEXT");
  addColumnIfMissing(connection, "issues", "last_github_ci_snapshot_gate_check_status", "TEXT");
  addColumnIfMissing(connection, "issues", "last_github_ci_snapshot_json", "TEXT");
  addColumnIfMissing(connection, "issues", "last_github_ci_snapshot_settled_at", "TEXT");
  addColumnIfMissing(connection, "issues", "last_queue_signal_at", "TEXT");
  addColumnIfMissing(connection, "issues", "last_queue_incident_json", "TEXT");
  addColumnIfMissing(connection, "issues", "last_attempted_failure_head_sha", "TEXT");
  addColumnIfMissing(connection, "issues", "last_attempted_failure_signature", "TEXT");

  // Track whether the merge queue label was successfully applied.
  addColumnIfMissing(connection, "issues", "queue_label_applied", "INTEGER NOT NULL DEFAULT 0");
}

function addColumnIfMissing(connection: DatabaseConnection, table: string, column: string, definition: string): void {
  const cols = connection.prepare(`PRAGMA table_info(${table})`).all() as Array<Record<string, unknown>>;
  if (cols.some((c) => c.name === column)) return;
  connection.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
