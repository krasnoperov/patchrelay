import type { UpsertIssueParams } from "./issue-store.ts";

type IssueColumnKey = Exclude<keyof UpsertIssueParams, "projectId" | "linearIssueId">;

/**
 * Declarative description of one column on the `issues` table:
 * - `column` — the SQL column name (snake_case)
 * - `transform` — optional conversion applied to the JS value before binding
 *   (booleans → 0/1, etc.). Run for both UPDATE and INSERT.
 * - `coalesce` — true means the UPDATE assignment is `col = COALESCE(@param, col)`,
 *   so a nullish input preserves the existing value. Used for "discovered once,
 *   never undo" fields like `issue_key` and `title`.
 * - `insertDefault` — value bound when INSERTing if the param is omitted.
 *   Defaults to `null` if not specified. Use sparingly: only when an INSERT
 *   must seed a non-null value (e.g. `delegated_to_patchrelay` defaults to 1).
 */
export interface IssueColumnDef {
  column: string;
  transform?: (value: unknown) => unknown;
  coalesce?: boolean;
  insertDefault?: unknown;
}

const booleanToInt = (value: unknown): number =>
  value === true || value === 1 ? 1 : 0;

const nullableBooleanToInt = (value: unknown): number | null => {
  if (value == null) return null;
  return value === true || value === 1 ? 1 : 0;
};

/**
 * Source-of-truth column map for `upsertIssue`. Ordered to match the INSERT
 * column list so a quick read shows the table shape end-to-end. Adding a new
 * field is a one-line addition here instead of editing three parallel lists.
 */
export const ISSUE_COLUMN_DEFS: Record<IssueColumnKey, IssueColumnDef> = {
  delegatedToPatchRelay: { column: "delegated_to_patchrelay", transform: booleanToInt, insertDefault: 1 },
  issueClass: { column: "issue_class" },
  issueClassSource: { column: "issue_class_source" },
  issueTriageHash: { column: "issue_triage_hash" },
  issueTriageResultJson: { column: "issue_triage_result_json" },
  parentLinearIssueId: { column: "parent_linear_issue_id" },
  parentIssueKey: { column: "parent_issue_key" },
  issueKey: { column: "issue_key", coalesce: true },
  title: { column: "title", coalesce: true },
  description: { column: "description", coalesce: true },
  url: { column: "url", coalesce: true },
  priority: { column: "priority" },
  estimate: { column: "estimate" },
  currentLinearState: { column: "current_linear_state", coalesce: true },
  currentLinearStateType: { column: "current_linear_state_type", coalesce: true },
  factoryState: { column: "factory_state", insertDefault: "delegated" },
  pendingRunType: { column: "pending_run_type" },
  pendingRunContextJson: { column: "pending_run_context_json" },
  branchName: { column: "branch_name", coalesce: true },
  worktreePath: { column: "worktree_path", coalesce: true },
  threadId: { column: "thread_id" },
  activeRunId: { column: "active_run_id" },
  statusCommentId: { column: "status_comment_id" },
  agentSessionId: { column: "agent_session_id" },
  lastLinearActivityKey: { column: "last_linear_activity_key" },
  prNumber: { column: "pr_number" },
  prUrl: { column: "pr_url" },
  prState: { column: "pr_state" },
  prIsDraft: { column: "pr_is_draft", transform: nullableBooleanToInt },
  prHeadSha: { column: "pr_head_sha" },
  prAuthorLogin: { column: "pr_author_login" },
  prReviewState: { column: "pr_review_state" },
  prCheckStatus: { column: "pr_check_status" },
  lastBlockingReviewHeadSha: { column: "last_blocking_review_head_sha" },
  lastGitHubFailureSource: { column: "last_github_failure_source" },
  lastGitHubFailureHeadSha: { column: "last_github_failure_head_sha" },
  lastGitHubFailureSignature: { column: "last_github_failure_signature" },
  lastGitHubFailureCheckName: { column: "last_github_failure_check_name" },
  lastGitHubFailureCheckUrl: { column: "last_github_failure_check_url" },
  lastGitHubFailureContextJson: { column: "last_github_failure_context_json" },
  lastGitHubFailureAt: { column: "last_github_failure_at" },
  lastGitHubCiSnapshotHeadSha: { column: "last_github_ci_snapshot_head_sha" },
  lastGitHubCiSnapshotGateCheckName: { column: "last_github_ci_snapshot_gate_check_name" },
  lastGitHubCiSnapshotGateCheckStatus: { column: "last_github_ci_snapshot_gate_check_status" },
  lastGitHubCiSnapshotJson: { column: "last_github_ci_snapshot_json" },
  lastGitHubCiSnapshotSettledAt: { column: "last_github_ci_snapshot_settled_at" },
  lastQueueSignalAt: { column: "last_queue_signal_at" },
  lastQueueIncidentJson: { column: "last_queue_incident_json" },
  lastAttemptedFailureHeadSha: { column: "last_attempted_failure_head_sha" },
  lastAttemptedFailureSignature: { column: "last_attempted_failure_signature" },
  lastAttemptedFailureAt: { column: "last_attempted_failure_at" },
  lastPublishedPatchId: { column: "last_published_patch_id" },
  lastPublishedIntegrationTreeId: { column: "last_published_integration_tree_id" },
  lastPublishedHeadSha: { column: "last_published_head_sha" },
  parentPrBranch: { column: "parent_pr_branch" },
  ciRepairAttempts: { column: "ci_repair_attempts", insertDefault: 0 },
  queueRepairAttempts: { column: "queue_repair_attempts", insertDefault: 0 },
  reviewFixAttempts: { column: "review_fix_attempts", insertDefault: 0 },
  zombieRecoveryAttempts: { column: "zombie_recovery_attempts", insertDefault: 0 },
  lastZombieRecoveryAt: { column: "last_zombie_recovery_at" },
  orchestrationSettleUntil: { column: "orchestration_settle_until" },
};

export const ISSUE_COLUMN_KEYS = Object.keys(ISSUE_COLUMN_DEFS) as IssueColumnKey[];

/**
 * Builds the `SET col = @param` fragments and the bound-value bag for an
 * UPDATE. Only fields explicitly set in `params` are included so we don't
 * accidentally clobber other columns.
 */
export function buildUpdateAssignments(
  params: UpsertIssueParams,
): { assignments: string[]; values: Record<string, unknown> } {
  const assignments: string[] = [];
  const values: Record<string, unknown> = {};
  for (const key of ISSUE_COLUMN_KEYS) {
    const value = params[key];
    if (value === undefined) continue;
    const def = ISSUE_COLUMN_DEFS[key];
    const bound = def.transform ? def.transform(value) : value;
    assignments.push(def.coalesce
      ? `${def.column} = COALESCE(@${key}, ${def.column})`
      : `${def.column} = @${key}`);
    values[key] = bound;
  }
  return { assignments, values };
}

/**
 * Builds the columns list, the placeholders list, and the bound-value bag for
 * an INSERT. Every column is emitted (NULL if the param is omitted and no
 * `insertDefault` is set) so the SQL stays stable across calls.
 */
export function buildInsertBindings(
  params: UpsertIssueParams,
): { columns: string[]; placeholders: string[]; values: Record<string, unknown> } {
  const columns: string[] = [];
  const placeholders: string[] = [];
  const values: Record<string, unknown> = {};
  for (const key of ISSUE_COLUMN_KEYS) {
    const def = ISSUE_COLUMN_DEFS[key];
    columns.push(def.column);
    placeholders.push(`@${key}`);
    const raw = params[key];
    const resolved = raw !== undefined ? raw : def.insertDefault;
    if (resolved === undefined) {
      values[key] = null;
      continue;
    }
    values[key] = def.transform ? def.transform(resolved) : resolved;
  }
  return { columns, placeholders, values };
}
