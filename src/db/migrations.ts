import { isoNow, type DatabaseConnection } from "./shared.ts";

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
  url TEXT,
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
  ci_repair_attempts INTEGER NOT NULL DEFAULT 0,
  queue_repair_attempts INTEGER NOT NULL DEFAULT 0,
  orchestration_settle_until TEXT,
  parent_pr_branch TEXT,
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
  last_workflow_reason TEXT,
  ci_repair_attempts INTEGER NOT NULL DEFAULT 0,
  queue_repair_attempts INTEGER NOT NULL DEFAULT 0,
  review_fix_attempts INTEGER NOT NULL DEFAULT 0,
  lease_id TEXT,
  worker_id TEXT,
  leased_until TEXT,
  created_at TEXT NOT NULL,
  display_updated_at TEXT NOT NULL,
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
-- getIssueByPrNumber() runs on the GitHub webhook hot path; without this it
-- full-scanned the issues table for every inbound PR/review/comment event.
CREATE INDEX IF NOT EXISTS idx_issues_pr_number ON issues(pr_number);
CREATE INDEX IF NOT EXISTS idx_runs_issue ON runs(issue_id);
CREATE INDEX IF NOT EXISTS idx_runs_active ON runs(status, project_id, linear_issue_id);
CREATE INDEX IF NOT EXISTS idx_runs_thread ON runs(thread_id);
-- getLatestRunForIssue() filters runs by (project_id, linear_issue_id) with
-- no status constraint, so idx_runs_active (status-led) cannot serve it and it
-- full-scanned the (large) runs table once per issue. This makes it a seek.
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

export function runPatchRelayMigrations(connection: DatabaseConnection): void {
  connection.exec(schema);
  connection.prepare("DROP INDEX IF EXISTS idx_issue_sessions_lease").run();
  connection.prepare("DROP INDEX IF EXISTS idx_issues_ready").run();

  // Clean up stale dedupe-only webhook records (no payload, never processable)
  connection.prepare(
    "UPDATE webhook_events SET processing_status = 'processed' WHERE processing_status = 'pending' AND payload_json IS NULL",
  ).run();

  addColumnIfMissing(connection, "issues", "delegated_to_patchrelay", "INTEGER NOT NULL DEFAULT 1");
  addColumnIfMissing(connection, "issues", "issue_class", "TEXT");
  addColumnIfMissing(connection, "issues", "issue_class_source", "TEXT");
  addColumnIfMissing(connection, "issues", "issue_triage_hash", "TEXT");
  addColumnIfMissing(connection, "issues", "issue_triage_result_json", "TEXT");
  addColumnIfMissing(connection, "issues", "parent_linear_issue_id", "TEXT");
  addColumnIfMissing(connection, "issues", "parent_issue_key", "TEXT");
  addColumnIfMissing(connection, "issues", "orchestration_settle_until", "TEXT");
  addColumnIfMissing(connection, "issues", "workflow_outcome", "TEXT");
  addColumnIfMissing(connection, "issues", "workflow_outcome_reason", "TEXT");
  addColumnIfMissing(connection, "issues", "input_request_kind", "TEXT");
  backfillWorkflowFacts(connection);
  // Earlier releases persisted derived classifications as "explicit", which
  // made bad umbrella guesses sticky forever. We do not have a user-authored
  // explicit classification path yet, so downgrade old rows back to heuristic
  // and let current classification logic recompute them.
  connection.prepare(`
    UPDATE issues
    SET issue_class_source = 'heuristic'
    WHERE issue_class_source = 'explicit'
  `).run();

  // Add pending_merge_prep column for merge queue stewardship
  addColumnIfMissing(connection, "issues", "pending_merge_prep", "INTEGER NOT NULL DEFAULT 0");

  // Add merge_prep_attempts for retry budget / escalation
  addColumnIfMissing(connection, "issues", "merge_prep_attempts", "INTEGER NOT NULL DEFAULT 0");

  // Add review_fix_attempts counter
  addColumnIfMissing(connection, "issues", "review_fix_attempts", "INTEGER NOT NULL DEFAULT 0");

  // Preserve the PR head SHA seen when a run started so PatchRelay can
  // verify that requested-changes work actually published a new head.
  addColumnIfMissing(connection, "issue_sessions", "display_updated_at", "TEXT");
  addColumnIfMissing(connection, "issue_sessions", "last_workflow_reason", "TEXT");
  if (columnExists(connection, "issue_sessions", "last_wake_reason")) {
    connection.prepare(`
      UPDATE issue_sessions
      SET last_workflow_reason = COALESCE(last_workflow_reason, last_wake_reason)
      WHERE last_workflow_reason IS NULL
    `).run();
  }
  connection.prepare(`
    UPDATE issue_sessions
    SET display_updated_at = COALESCE(display_updated_at, updated_at, created_at)
    WHERE display_updated_at IS NULL
  `).run();
  connection.prepare(`
    INSERT INTO issue_session_leases (
      project_id,
      linear_issue_id,
      lease_id,
      worker_id,
      leased_until,
      updated_at
    )
    SELECT
      project_id,
      linear_issue_id,
      lease_id,
      COALESCE(worker_id, 'unknown'),
      leased_until,
      COALESCE(updated_at, created_at)
    FROM issue_sessions
    WHERE lease_id IS NOT NULL
      AND leased_until IS NOT NULL
    ON CONFLICT(project_id, linear_issue_id) DO UPDATE SET
      lease_id = excluded.lease_id,
      worker_id = excluded.worker_id,
      leased_until = excluded.leased_until,
      updated_at = excluded.updated_at
  `).run();
  connection.prepare(`
    INSERT INTO issue_session_threads (
      project_id,
      linear_issue_id,
      active_thread_id,
      thread_generation,
      updated_at
    )
    SELECT
      project_id,
      linear_issue_id,
      active_thread_id,
      COALESCE(thread_generation, 0),
      COALESCE(updated_at, created_at)
    FROM issue_sessions
    WHERE active_thread_id IS NOT NULL
       OR COALESCE(thread_generation, 0) > 0
    ON CONFLICT(project_id, linear_issue_id) DO UPDATE SET
      active_thread_id = excluded.active_thread_id,
      thread_generation = excluded.thread_generation,
      updated_at = excluded.updated_at
  `).run();
  addColumnIfMissing(connection, "runs", "source_head_sha", "TEXT");
  addColumnIfMissing(connection, "runs", "launch_phase", "TEXT");
  addColumnIfMissing(connection, "runs", "completion_check_thread_id", "TEXT");
  addColumnIfMissing(connection, "runs", "completion_check_turn_id", "TEXT");
  addColumnIfMissing(connection, "runs", "completion_check_outcome", "TEXT");
  addColumnIfMissing(connection, "runs", "completion_check_summary", "TEXT");
  addColumnIfMissing(connection, "runs", "completion_check_question", "TEXT");
  addColumnIfMissing(connection, "runs", "completion_check_why", "TEXT");
  addColumnIfMissing(connection, "runs", "completion_check_recommended_reply", "TEXT");
  addColumnIfMissing(connection, "runs", "completion_checked_at", "TEXT");
  // Plan §4.4: hard publication-suppression flag for the
  // mid-run-approval cancellation primitive.
  addColumnIfMissing(connection, "runs", "should_not_publish", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(connection, "runs", "authority_epoch", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(connection, "runs", "lease_revoked_at", "TEXT");
  addColumnIfMissing(connection, "runs", "lease_revoke_reason", "TEXT");
  // S5 (v2 inbox tasks): the workflow task id this run was claimed for. The
  // finalizer prefers this over the reconstructed `run:<runType>` string so an
  // inbox task (run:input / run:orchestration_followup) closes by its real id.
  addColumnIfMissing(connection, "runs", "task_id", "TEXT");
  addColumnIfMissing(connection, "runs", "last_codex_activity_at", "TEXT");
  addColumnIfMissing(connection, "runs", "last_codex_activity_kind", "TEXT");
  addColumnIfMissing(connection, "runs", "last_codex_activity_summary", "TEXT");
  removeRetiredRunHistory(connection);
  addColumnIfMissing(connection, "workflow_tasks", "authority_epoch", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(connection, "workflow_tasks", "gate_action", "TEXT NOT NULL DEFAULT 'wait'");
  addColumnIfMissing(connection, "workflow_tasks", "gate_reason", "TEXT");
  addColumnIfMissing(connection, "issues", "last_blocking_review_head_sha", "TEXT");

  // Add Linear issue description, priority, estimate
  addColumnIfMissing(connection, "issues", "description", "TEXT");
  addColumnIfMissing(connection, "issues", "priority", "INTEGER");
  addColumnIfMissing(connection, "issues", "estimate", "REAL");
  addColumnIfMissing(connection, "issues", "status_comment_id", "TEXT");
  addColumnIfMissing(connection, "issues", "last_linear_activity_key", "TEXT");
  addColumnIfMissing(connection, "issues", "current_linear_state_type", "TEXT");
  addColumnIfMissing(connection, "issue_dependencies", "blocker_current_linear_state_type", "TEXT");

  // Zombie/stale recovery backoff
  addColumnIfMissing(connection, "issues", "zombie_recovery_attempts", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(connection, "issues", "last_zombie_recovery_at", "TEXT");

  // Preserve GitHub failure provenance so reconciliation can distinguish
  // branch CI failures from merge-queue evictions after webhook delivery.
  addColumnIfMissing(connection, "issues", "pr_head_sha", "TEXT");
  addColumnIfMissing(connection, "issues", "pr_author_login", "TEXT");
  addColumnIfMissing(connection, "issues", "pr_is_draft", "INTEGER");
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
  addColumnIfMissing(connection, "issues", "last_attempted_failure_at", "TEXT");
  // Plan §4.1: track the last published change identity so future
  // runs can detect patch-id-equivalent re-publishes (no-op pushes).
  // Currently observability-only — populated when patchrelay observes
  // a push it can attribute to itself; consumers (prompt assembly,
  // post-hoc detection) layer in follow-up PRs.
  addColumnIfMissing(connection, "issues", "last_published_patch_id", "TEXT");
  addColumnIfMissing(connection, "issues", "last_published_integration_tree_id", "TEXT");
  addColumnIfMissing(connection, "issues", "last_published_head_sha", "TEXT");
  // Plan §8.3: parent-of-child index for stacked PRs.
  addColumnIfMissing(connection, "issues", "parent_pr_branch", "TEXT");
  connection.exec(`CREATE INDEX IF NOT EXISTS idx_issues_parent_pr_branch ON issues(parent_pr_branch);`);
  addColumnIfMissing(connection, "linear_installations", "health_status", "TEXT NOT NULL DEFAULT 'ok'");
  addColumnIfMissing(connection, "linear_installations", "health_reason", "TEXT");
  addColumnIfMissing(connection, "linear_installations", "health_updated_at", "TEXT");

  backfillLegacyPendingRunWorkflowTasks(connection);
  removeRetiredIssueColumnsIfPresent(connection);
  addColumnIfMissing(connection, "issues", "issue_triage_hash", "TEXT");
  addColumnIfMissing(connection, "issues", "issue_triage_result_json", "TEXT");
  // PR3: post-merge deploy tracking. Timestamp the issue entered the
  // deploy window, so the deploy watcher only considers deploy runs
  // created at/after the merge (and can time out a never-arriving deploy).
  addColumnIfMissing(connection, "issues", "deploy_started_at", "TEXT");

  // Optimistic-concurrency counter for issue-state writes (core
  // simplification plan, phase A). Bumped on every UPDATE by upsertIssue.
  addColumnIfMissing(connection, "issues", "version", "INTEGER NOT NULL DEFAULT 0");

  // Codex capacity backoff: launches are deferred until this timestamp
  // after a usage-limit / rate-limit / quota failure.
  addColumnIfMissing(connection, "issues", "capacity_backoff_until", "TEXT");

  // Consecutive Codex capacity failures for an issue, driving an escalating
  // backoff (2/5/10 min). Reset when a run completes successfully.
  addColumnIfMissing(connection, "issues", "capacity_backoff_attempts", "INTEGER NOT NULL DEFAULT 0");
  connection.exec("CREATE INDEX IF NOT EXISTS idx_issues_workflow_outcome ON issues(workflow_outcome, updated_at)");
}

function addColumnIfMissing(connection: DatabaseConnection, table: string, column: string, definition: string): void {
  const cols = connection.prepare(`PRAGMA table_info(${table})`).all() as Array<Record<string, unknown>>;
  if (cols.some((c) => c.name === column)) return;
  connection.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function removeRetiredRunHistory(connection: DatabaseConnection): void {
  // Codex owns the transcript. PatchRelay keeps only compact run projections;
  // retaining raw notifications or a second post-run transcript creates two
  // competing histories and can expose data the operator did not ask us to
  // duplicate.
  connection.prepare("DROP TABLE IF EXISTS run_thread_events").run();
  if (columnExists(connection, "runs", "report_json")) {
    connection.prepare("ALTER TABLE runs DROP COLUMN report_json").run();
  }
}

function columnExists(connection: DatabaseConnection, table: string, column: string): boolean {
  const cols = connection.prepare(`PRAGMA table_info(${table})`).all() as Array<Record<string, unknown>>;
  return cols.some((c) => c.name === column);
}

function backfillWorkflowFacts(connection: DatabaseConnection): void {
  if (columnExists(connection, "issues", "factory_state")) {
    connection.prepare(`
    UPDATE issues
    SET workflow_outcome = CASE factory_state
      WHEN 'done' THEN 'completed'
      WHEN 'failed' THEN 'failed'
      WHEN 'escalated' THEN 'escalated'
      ELSE workflow_outcome
    END,
    workflow_outcome_reason = CASE
      WHEN factory_state IN ('done', 'failed', 'escalated')
        THEN COALESCE(workflow_outcome_reason, 'migrated_from_legacy_lifecycle')
      ELSE workflow_outcome_reason
    END,
    input_request_kind = CASE
      WHEN factory_state = 'awaiting_input'
        THEN COALESCE(input_request_kind, 'completion_check_question')
      ELSE input_request_kind
    END
    WHERE workflow_outcome IS NULL OR input_request_kind IS NULL
    `).run();
  }

  const invalid = connection.prepare(`
    SELECT project_id, linear_issue_id, workflow_outcome, input_request_kind
    FROM issues
    WHERE (workflow_outcome IS NOT NULL AND workflow_outcome NOT IN ('completed', 'failed', 'escalated'))
       OR (input_request_kind IS NOT NULL AND input_request_kind NOT IN ('paused_local_work', 'completion_check_question'))
    LIMIT 1
  `).get();
  if (invalid) {
    throw new Error(
      `Invalid workflow facts on ${String(invalid.project_id)}/${String(invalid.linear_issue_id)}: `
      + `outcome=${String(invalid.workflow_outcome)}, input=${String(invalid.input_request_kind)}`,
    );
  }
}

const LEGACY_PENDING_RUN_TYPES = new Set(["implementation", "ci_repair", "review_fix", "branch_upkeep", "queue_repair"]);

function parseObjectJson(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "string" || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function backfillLegacyPendingRunWorkflowTasks(connection: DatabaseConnection): void {
  if (!columnExists(connection, "issues", "pending_run_type")) return;
  const rows = connection.prepare(`
    SELECT
      project_id,
      linear_issue_id,
      pending_run_type,
      pending_run_context_json,
      pr_number,
      pr_head_sha,
      updated_at
    FROM issues
    WHERE pending_run_type IS NOT NULL
  `).all() as Array<Record<string, unknown>>;
  if (rows.length === 0) return;

  const insertTask = connection.prepare(`
    INSERT INTO workflow_tasks (
      project_id, subject_id, task_id, task_type, run_type, status, reason,
      requirements_json, authority_epoch, gate_action, gate_reason,
      created_at, updated_at, closed_at
    ) VALUES (
      @projectId, @subjectId, @taskId, 'run', @runType, 'open', 'Legacy pending run migrated to workflow task',
      @requirementsJson, 0, 'start', 'legacy_pending_run_migration',
      @createdAt, @updatedAt, NULL
    )
    ON CONFLICT(project_id, subject_id, task_id) DO UPDATE SET
      run_type = excluded.run_type,
      status = 'open',
      reason = excluded.reason,
      requirements_json = excluded.requirements_json,
      gate_action = excluded.gate_action,
      gate_reason = excluded.gate_reason,
      updated_at = excluded.updated_at,
      closed_at = NULL
  `);
  const insertBranchObservation = connection.prepare(`
    INSERT INTO workflow_observations (
      project_id, subject_id, source, type, payload_json, dedupe_key, observed_at
    ) VALUES (
      @projectId, @subjectId, 'github', 'github.parent_head_moved', @payloadJson, @dedupeKey, @observedAt
    )
    ON CONFLICT(project_id, subject_id, source, dedupe_key) DO NOTHING
  `);

  const now = isoNow();
  const run = connection.transaction(() => {
    for (const row of rows) {
      const runType = String(row.pending_run_type ?? "");
      if (!LEGACY_PENDING_RUN_TYPES.has(runType)) continue;
      const context = parseObjectJson(row.pending_run_context_json);
      const requirements = {
        ...context,
        source: "legacy_pending_run_migration",
      };
      insertTask.run({
        projectId: String(row.project_id),
        subjectId: String(row.linear_issue_id),
        taskId: `run:${runType}`,
        runType,
        requirementsJson: JSON.stringify(requirements),
        createdAt: typeof row.updated_at === "string" ? row.updated_at : now,
        updatedAt: now,
      });

      if (runType === "branch_upkeep") {
        const payload = {
          parentBranch: typeof context.baseBranch === "string" ? context.baseBranch : "main",
          ...(typeof context.parentHeadSha === "string" ? { parentHeadSha: context.parentHeadSha } : {}),
          ...(typeof row.pr_number === "number" ? { childPrNumber: row.pr_number } : {}),
          ...(typeof row.pr_head_sha === "string" ? { childHeadSha: row.pr_head_sha } : {}),
        };
        insertBranchObservation.run({
          projectId: String(row.project_id),
          subjectId: String(row.linear_issue_id),
          payloadJson: JSON.stringify(payload),
          dedupeKey: `branch_upkeep:${String(row.linear_issue_id)}:${typeof row.pr_head_sha === "string" ? row.pr_head_sha : "legacy-pending-run"}`,
          observedAt: now,
        });
      }
    }
  });
  run();
}

function removeRetiredIssueColumnsIfPresent(connection: DatabaseConnection): void {
  const cols = connection.prepare("PRAGMA table_info(issues)").all() as Array<Record<string, unknown>>;
  const columnNames = new Set(cols.map((column) => String(column.name)));
  const retired = [
    "queue_label_applied",
    "pending_merge_prep",
    "merge_prep_attempts",
    "branch_owner",
    "branch_ownership_changed_at",
    "pending_run_type",
    "pending_run_context_json",
  ];
  if (!columnNames.has("factory_state") && !retired.some((name) => columnNames.has(name))) {
    return;
  }

  connection.exec("PRAGMA foreign_keys = OFF");
  try {
    connection.exec(`
      CREATE TABLE issues_new (
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
        last_published_integration_tree_id TEXT,
        last_published_head_sha TEXT,
        parent_pr_branch TEXT,
        ci_repair_attempts INTEGER NOT NULL DEFAULT 0,
        queue_repair_attempts INTEGER NOT NULL DEFAULT 0,
        review_fix_attempts INTEGER NOT NULL DEFAULT 0,
        zombie_recovery_attempts INTEGER NOT NULL DEFAULT 0,
        last_zombie_recovery_at TEXT,
        orchestration_settle_until TEXT,
        updated_at TEXT NOT NULL,
        UNIQUE(project_id, linear_issue_id)
      );

      INSERT INTO issues_new (
        id,
        project_id,
        linear_issue_id,
        delegated_to_patchrelay,
        issue_class,
        issue_class_source,
        issue_triage_hash,
        issue_triage_result_json,
        parent_linear_issue_id,
        parent_issue_key,
        issue_key,
        title,
        description,
        url,
        priority,
        estimate,
        current_linear_state,
        current_linear_state_type,
        workflow_outcome,
        workflow_outcome_reason,
        input_request_kind,
        branch_name,
        worktree_path,
        thread_id,
        active_run_id,
        status_comment_id,
        agent_session_id,
        last_linear_activity_key,
        pr_number,
        pr_url,
        pr_state,
        pr_is_draft,
        pr_head_sha,
        pr_author_login,
        pr_review_state,
        pr_check_status,
        last_blocking_review_head_sha,
        last_github_failure_source,
        last_github_failure_head_sha,
        last_github_failure_signature,
        last_github_failure_check_name,
        last_github_failure_check_url,
        last_github_failure_context_json,
        last_github_failure_at,
        last_github_ci_snapshot_head_sha,
        last_github_ci_snapshot_gate_check_name,
        last_github_ci_snapshot_gate_check_status,
        last_github_ci_snapshot_json,
        last_github_ci_snapshot_settled_at,
        last_queue_signal_at,
        last_queue_incident_json,
        last_attempted_failure_head_sha,
        last_attempted_failure_signature,
        last_attempted_failure_at,
        last_published_patch_id,
        last_published_integration_tree_id,
        last_published_head_sha,
        parent_pr_branch,
        ci_repair_attempts,
        queue_repair_attempts,
        review_fix_attempts,
        zombie_recovery_attempts,
        last_zombie_recovery_at,
        orchestration_settle_until,
        updated_at
      )
      SELECT
        id,
        project_id,
        linear_issue_id,
        COALESCE(delegated_to_patchrelay, 1),
        issue_class,
        issue_class_source,
        issue_triage_hash,
        issue_triage_result_json,
        parent_linear_issue_id,
        parent_issue_key,
        issue_key,
        title,
        description,
        url,
        priority,
        estimate,
        current_linear_state,
        current_linear_state_type,
        workflow_outcome,
        workflow_outcome_reason,
        input_request_kind,
        branch_name,
        worktree_path,
        thread_id,
        active_run_id,
        status_comment_id,
        agent_session_id,
        last_linear_activity_key,
        pr_number,
        pr_url,
        pr_state,
        pr_is_draft,
        pr_head_sha,
        pr_author_login,
        pr_review_state,
        pr_check_status,
        last_blocking_review_head_sha,
        last_github_failure_source,
        last_github_failure_head_sha,
        last_github_failure_signature,
        last_github_failure_check_name,
        last_github_failure_check_url,
        last_github_failure_context_json,
        last_github_failure_at,
        last_github_ci_snapshot_head_sha,
        last_github_ci_snapshot_gate_check_name,
        last_github_ci_snapshot_gate_check_status,
        last_github_ci_snapshot_json,
        last_github_ci_snapshot_settled_at,
        last_queue_signal_at,
        last_queue_incident_json,
        last_attempted_failure_head_sha,
        last_attempted_failure_signature,
        last_attempted_failure_at,
        last_published_patch_id,
        last_published_integration_tree_id,
        last_published_head_sha,
        parent_pr_branch,
        COALESCE(ci_repair_attempts, 0),
        COALESCE(queue_repair_attempts, 0),
        COALESCE(review_fix_attempts, 0),
        COALESCE(zombie_recovery_attempts, 0),
        last_zombie_recovery_at,
        orchestration_settle_until,
        updated_at
      FROM issues;

      DROP TABLE issues;
      ALTER TABLE issues_new RENAME TO issues;

      CREATE INDEX IF NOT EXISTS idx_issues_project ON issues(project_id, linear_issue_id);
      CREATE INDEX IF NOT EXISTS idx_issues_key ON issues(issue_key);
      CREATE INDEX IF NOT EXISTS idx_issues_branch ON issues(branch_name);
      CREATE INDEX IF NOT EXISTS idx_issues_parent_pr_branch ON issues(parent_pr_branch);
    `);
  } finally {
    connection.exec("PRAGMA foreign_keys = ON");
  }
}
