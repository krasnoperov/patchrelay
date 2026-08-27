import type { DatabaseConnection } from "./shared.ts";

/**
 * The complete PatchRelay schema.
 *
 * PatchRelay has one production database. Existing databases must already be
 * on this schema; startup never rewrites tables or transforms stored rows. This
 * bootstrap is intentionally limited to creating missing objects for a new
 * empty database.
 */
const schema = `
CREATE TABLE IF NOT EXISTS issues (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  linear_issue_id TEXT NOT NULL,
  delegated_to_patchrelay INTEGER NOT NULL DEFAULT 1,
  issue_class TEXT,
  issue_class_source TEXT,
  issue_triage_hash TEXT,
  issue_triage_result_json TEXT,
  parent_linear_issue_id TEXT,
  parent_issue_key TEXT,
  issue_key TEXT,
  title TEXT,
  description TEXT,
  url TEXT,
  priority INTEGER,
  estimate REAL,
  current_linear_state TEXT,
  current_linear_state_type TEXT,
  workflow_outcome TEXT,
  workflow_outcome_reason TEXT,
  input_request_kind TEXT,
  branch_name TEXT,
  worktree_path TEXT,
  thread_id TEXT,
  active_run_id INTEGER,
  status_comment_id TEXT,
  agent_session_id TEXT,
  last_linear_activity_key TEXT,
  pr_number INTEGER,
  pr_url TEXT,
  pr_state TEXT,
  pr_is_draft INTEGER,
  pr_head_sha TEXT,
  pr_author_login TEXT,
  pr_review_state TEXT,
  pr_check_status TEXT,
  last_blocking_review_head_sha TEXT,
  last_github_failure_source TEXT,
  last_github_failure_head_sha TEXT,
  last_github_failure_signature TEXT,
  last_github_failure_check_name TEXT,
  last_github_failure_check_url TEXT,
  last_github_failure_context_json TEXT,
  last_github_failure_at TEXT,
  last_github_ci_snapshot_head_sha TEXT,
  last_github_ci_snapshot_gate_check_name TEXT,
  last_github_ci_snapshot_gate_check_status TEXT,
  last_github_ci_snapshot_json TEXT,
  last_github_ci_snapshot_settled_at TEXT,
  last_queue_signal_at TEXT,
  last_queue_incident_json TEXT,
  last_attempted_failure_head_sha TEXT,
  last_attempted_failure_signature TEXT,
  last_attempted_failure_at TEXT,
  last_published_patch_id TEXT,
  last_published_head_sha TEXT,
  parent_pr_branch TEXT,
  ci_repair_attempts INTEGER NOT NULL DEFAULT 0,
  queue_repair_attempts INTEGER NOT NULL DEFAULT 0,
  review_fix_attempts INTEGER NOT NULL DEFAULT 0,
  zombie_recovery_attempts INTEGER NOT NULL DEFAULT 0,
  last_zombie_recovery_at TEXT,
  orchestration_settle_until TEXT,
  deploy_started_at TEXT,
  version INTEGER NOT NULL DEFAULT 0,
  capacity_backoff_until TEXT,
  capacity_backoff_attempts INTEGER NOT NULL DEFAULT 0,
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
  launch_phase TEXT,
  source_head_sha TEXT,
  prompt_text TEXT,
  thread_id TEXT,
  turn_id TEXT,
  parent_thread_id TEXT,
  completion_check_thread_id TEXT,
  completion_check_turn_id TEXT,
  completion_check_outcome TEXT,
  completion_check_summary TEXT,
  completion_check_question TEXT,
  completion_check_why TEXT,
  completion_check_recommended_reply TEXT,
  completion_checked_at TEXT,
  summary_json TEXT,
  failure_reason TEXT,
  last_codex_activity_at TEXT,
  last_codex_activity_kind TEXT,
  last_codex_activity_summary TEXT,
  should_not_publish INTEGER NOT NULL DEFAULT 0,
  authority_epoch INTEGER NOT NULL DEFAULT 0,
  lease_revoked_at TEXT,
  lease_revoke_reason TEXT,
  task_id TEXT,
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
  summary_text TEXT,
  active_run_id INTEGER,
  last_run_type TEXT,
  last_workflow_reason TEXT,
  ci_repair_attempts INTEGER NOT NULL DEFAULT 0,
  queue_repair_attempts INTEGER NOT NULL DEFAULT 0,
  review_fix_attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  display_updated_at TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, linear_issue_id)
);

CREATE TABLE IF NOT EXISTS issue_session_leases (
  project_id TEXT NOT NULL,
  linear_issue_id TEXT NOT NULL,
  lease_id TEXT NOT NULL,
  worker_id TEXT NOT NULL,
  leased_until TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(project_id, linear_issue_id)
);

CREATE TABLE IF NOT EXISTS issue_session_threads (
  project_id TEXT NOT NULL,
  linear_issue_id TEXT NOT NULL,
  active_thread_id TEXT,
  thread_generation INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(project_id, linear_issue_id)
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
  health_status TEXT NOT NULL DEFAULT 'ok',
  health_reason TEXT,
  health_updated_at TEXT,
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
  status TEXT,
  workflow_id TEXT,
  next_stage TEXT
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

CREATE TABLE IF NOT EXISTS issue_children (
  project_id TEXT NOT NULL,
  parent_linear_issue_id TEXT NOT NULL,
  child_linear_issue_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, parent_linear_issue_id, child_linear_issue_id)
);

CREATE TABLE IF NOT EXISTS workflow_observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  source TEXT NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT,
  dedupe_key TEXT,
  observed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workflow_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  task_type TEXT NOT NULL,
  run_type TEXT,
  status TEXT NOT NULL,
  reason TEXT NOT NULL,
  requirements_json TEXT,
  authority_epoch INTEGER NOT NULL DEFAULT 0,
  gate_action TEXT NOT NULL,
  gate_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  closed_at TEXT,
  UNIQUE(project_id, subject_id, task_id)
);

CREATE INDEX IF NOT EXISTS idx_issues_project ON issues(project_id, linear_issue_id);
CREATE INDEX IF NOT EXISTS idx_issues_key ON issues(issue_key);
CREATE INDEX IF NOT EXISTS idx_issues_branch ON issues(branch_name);
CREATE INDEX IF NOT EXISTS idx_issues_pr_number ON issues(pr_number);
CREATE INDEX IF NOT EXISTS idx_issues_parent_pr_branch ON issues(parent_pr_branch);
CREATE INDEX IF NOT EXISTS idx_issues_workflow_outcome ON issues(workflow_outcome, updated_at);
CREATE INDEX IF NOT EXISTS idx_runs_issue ON runs(issue_id);
CREATE INDEX IF NOT EXISTS idx_runs_active ON runs(status, project_id, linear_issue_id);
CREATE INDEX IF NOT EXISTS idx_runs_thread ON runs(thread_id);
CREATE INDEX IF NOT EXISTS idx_runs_issue_latest ON runs(project_id, linear_issue_id, id);
CREATE INDEX IF NOT EXISTS idx_issue_sessions_issue ON issue_sessions(project_id, linear_issue_id);
CREATE INDEX IF NOT EXISTS idx_issue_sessions_key ON issue_sessions(issue_key);
CREATE INDEX IF NOT EXISTS idx_issue_session_leases_until ON issue_session_leases(leased_until);
CREATE INDEX IF NOT EXISTS idx_issue_session_events_issue ON issue_session_events(project_id, linear_issue_id, id);
CREATE INDEX IF NOT EXISTS idx_issue_session_events_pending ON issue_session_events(processed_at, project_id, linear_issue_id, id);
CREATE INDEX IF NOT EXISTS idx_webhook_events_retention ON webhook_events(processing_status, received_at, id);
CREATE INDEX IF NOT EXISTS idx_operator_feed_events_issue ON operator_feed_events(issue_key, id);
CREATE INDEX IF NOT EXISTS idx_operator_feed_events_project ON operator_feed_events(project_id, id);
CREATE INDEX IF NOT EXISTS idx_repository_links_installation ON repository_links(installation_id, github_repo);
CREATE INDEX IF NOT EXISTS idx_linear_catalog_teams_installation ON linear_catalog_teams(installation_id, team_key, team_name);
CREATE INDEX IF NOT EXISTS idx_linear_catalog_projects_installation ON linear_catalog_projects(installation_id, project_name);
CREATE INDEX IF NOT EXISTS idx_issue_dependencies_issue ON issue_dependencies(project_id, linear_issue_id);
CREATE INDEX IF NOT EXISTS idx_issue_dependencies_blocker ON issue_dependencies(project_id, blocker_linear_issue_id);
CREATE INDEX IF NOT EXISTS idx_issue_children_parent ON issue_children(project_id, parent_linear_issue_id);
CREATE INDEX IF NOT EXISTS idx_issue_children_child ON issue_children(project_id, child_linear_issue_id);
CREATE INDEX IF NOT EXISTS idx_workflow_observations_subject ON workflow_observations(project_id, subject_id, id);
CREATE INDEX IF NOT EXISTS idx_workflow_observations_recent ON workflow_observations(observed_at, id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_observations_dedupe
  ON workflow_observations(project_id, subject_id, source, dedupe_key)
  WHERE dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_workflow_tasks_subject ON workflow_tasks(project_id, subject_id, status, id);
CREATE INDEX IF NOT EXISTS idx_workflow_tasks_open ON workflow_tasks(status, project_id, updated_at);
`;

export function initializePatchRelaySchema(connection: DatabaseConnection): boolean {
  const existingTable = connection.prepare(`
    SELECT 1
    FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    LIMIT 1
  `).get();
  if (existingTable) return false;

  connection.exec(schema);
  return true;
}
