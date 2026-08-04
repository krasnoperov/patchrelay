import type { DatabaseConnection } from "./shared.ts";

const REQUIRED_PATCHRELAY_COLUMNS: Record<string, readonly string[]> = {
  issue_children: "project_id parent_linear_issue_id child_linear_issue_id updated_at".split(" "),
  issue_dependencies: "project_id linear_issue_id blocker_linear_issue_id blocker_issue_key blocker_title blocker_current_linear_state blocker_current_linear_state_type updated_at".split(" "),
  issue_session_events: "id project_id linear_issue_id event_type event_json dedupe_key created_at processed_at consumed_by_run_id".split(" "),
  issue_session_leases: "project_id linear_issue_id lease_id worker_id leased_until updated_at".split(" "),
  issue_session_threads: "project_id linear_issue_id active_thread_id thread_generation updated_at".split(" "),
  issue_sessions: "id project_id linear_issue_id issue_key repo_id branch_name worktree_path pr_number pr_head_sha pr_author_login summary_text active_run_id last_run_type last_workflow_reason ci_repair_attempts queue_repair_attempts review_fix_attempts created_at display_updated_at updated_at".split(" "),
  issues: "id project_id linear_issue_id delegated_to_patchrelay issue_class issue_class_source issue_triage_hash issue_triage_result_json parent_linear_issue_id parent_issue_key issue_key title description url priority estimate current_linear_state current_linear_state_type workflow_outcome workflow_outcome_reason input_request_kind branch_name worktree_path thread_id active_run_id status_comment_id agent_session_id last_linear_activity_key pr_number pr_url pr_state pr_is_draft pr_head_sha pr_author_login pr_review_state pr_check_status last_blocking_review_head_sha last_github_failure_source last_github_failure_head_sha last_github_failure_signature last_github_failure_check_name last_github_failure_check_url last_github_failure_context_json last_github_failure_at last_github_ci_snapshot_head_sha last_github_ci_snapshot_gate_check_name last_github_ci_snapshot_gate_check_status last_github_ci_snapshot_json last_github_ci_snapshot_settled_at last_queue_signal_at last_queue_incident_json last_attempted_failure_head_sha last_attempted_failure_signature last_attempted_failure_at last_published_patch_id last_published_head_sha parent_pr_branch ci_repair_attempts queue_repair_attempts review_fix_attempts zombie_recovery_attempts last_zombie_recovery_at orchestration_settle_until deploy_started_at version capacity_backoff_until capacity_backoff_attempts updated_at".split(" "),
  linear_catalog_projects: "installation_id project_id project_name team_ids_json active updated_at".split(" "),
  linear_catalog_teams: "installation_id team_id team_key team_name active updated_at".split(" "),
  linear_installations: "id provider workspace_id workspace_name workspace_key actor_id actor_name access_token_ciphertext refresh_token_ciphertext scopes_json token_type expires_at health_status health_reason health_updated_at created_at updated_at".split(" "),
  oauth_states: "id provider state project_id redirect_uri actor created_at status consumed_at installation_id error_message".split(" "),
  operator_feed_events: "id at level kind summary detail issue_key project_id stage status workflow_id next_stage".split(" "),
  project_installations: "project_id installation_id linked_at".split(" "),
  repository_links: "github_repo local_path installation_id linear_team_ids_json linear_project_ids_json issue_key_prefixes_json linked_at updated_at".split(" "),
  runs: "id issue_id project_id linear_issue_id run_type status launch_phase source_head_sha prompt_text thread_id turn_id parent_thread_id completion_check_thread_id completion_check_turn_id completion_check_outcome completion_check_summary completion_check_question completion_check_why completion_check_recommended_reply completion_checked_at summary_json failure_reason last_codex_activity_at last_codex_activity_kind last_codex_activity_summary should_not_publish authority_epoch lease_revoked_at lease_revoke_reason task_id started_at ended_at".split(" "),
  webhook_events: "id webhook_id received_at project_id payload_json processing_status".split(" "),
  workflow_observations: "id project_id subject_id source type payload_json dedupe_key observed_at".split(" "),
  workflow_tasks: "id project_id subject_id task_id task_type run_type status reason requirements_json authority_epoch gate_action gate_reason created_at updated_at closed_at".split(" "),
};

const REQUIRED_PATCHRELAY_INDEXES = "idx_issue_children_child idx_issue_children_parent idx_issue_dependencies_blocker idx_issue_dependencies_issue idx_issue_session_events_issue idx_issue_session_events_pending idx_issue_session_leases_until idx_issue_sessions_issue idx_issue_sessions_key idx_issues_branch idx_issues_key idx_issues_parent_pr_branch idx_issues_pr_number idx_issues_project idx_issues_workflow_outcome idx_linear_catalog_projects_installation idx_linear_catalog_teams_installation idx_operator_feed_events_issue idx_operator_feed_events_project idx_repository_links_installation idx_runs_active idx_runs_issue idx_runs_issue_latest idx_runs_thread idx_webhook_events_retention idx_workflow_observations_dedupe idx_workflow_observations_recent idx_workflow_observations_subject idx_workflow_tasks_open idx_workflow_tasks_subject".split(" ");

export function assertPatchRelaySchemaReady(connection: DatabaseConnection, databasePath: string): void {
  const rows = connection
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all() as Array<Record<string, unknown>>;
  const tables = new Set(rows.map((row) => String(row.name)));
  const missingTables = Object.keys(REQUIRED_PATCHRELAY_COLUMNS).filter((table) => !tables.has(table));
  if (missingTables.length > 0) {
    throw new Error(
      `PatchRelay database is uninitialized or points at the wrong path: ${databasePath}. Missing required table(s): ${missingTables.join(", ")}`,
    );
  }

  const missingColumns = Object.entries(REQUIRED_PATCHRELAY_COLUMNS).flatMap(([table, requiredColumns]) => {
    const columns = new Set(
      connection.prepare(`PRAGMA table_info(${table})`).all().map((row) => String(row.name)),
    );
    return requiredColumns.filter((column) => !columns.has(column)).map((column) => `${table}.${column}`);
  });
  if (missingColumns.length > 0) {
    throw new Error(
      `PatchRelay database schema is incompatible at ${databasePath}. Missing required column(s): ${missingColumns.join(", ")}`,
    );
  }

  const indexRows = connection
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
    .all() as Array<Record<string, unknown>>;
  const indexes = new Set(indexRows.map((row) => String(row.name)));
  const missingIndexes = REQUIRED_PATCHRELAY_INDEXES.filter((index) => !indexes.has(index));
  if (missingIndexes.length > 0) {
    throw new Error(
      `PatchRelay database schema is incompatible at ${databasePath}. Missing required index(es): ${missingIndexes.join(", ")}`,
    );
  }
}
