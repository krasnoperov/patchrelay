import type {
  GitHubCiSnapshotRecord,
  IssueChildRecord,
  GitHubFailureSource,
  IssueDependencyRecord,
  IssueRecord,
} from "../db-types.ts";
import type { FactoryState, RunType } from "../factory-state.ts";
import type { IssueClass, IssueClassSource } from "../issue-class.ts";
import { buildInsertBindings, buildUpdateAssignments } from "./issue-upsert-columns.ts";
import { isoNow, type DatabaseConnection } from "./shared.ts";

export interface UpsertIssueParams {
  projectId: string;
  linearIssueId: string;
  delegatedToPatchRelay?: boolean;
  issueClass?: IssueClass | null;
  issueClassSource?: IssueClassSource | null;
  issueTriageHash?: string | null;
  issueTriageResultJson?: string | null;
  parentLinearIssueId?: string | null;
  parentIssueKey?: string | null;
  issueKey?: string;
  title?: string;
  description?: string;
  url?: string;
  priority?: number | null;
  estimate?: number | null;
  currentLinearState?: string;
  currentLinearStateType?: string;
  factoryState?: FactoryState;
  pendingRunType?: RunType | null;
  pendingRunContextJson?: string | null;
  branchName?: string;
  worktreePath?: string;
  threadId?: string | null;
  activeRunId?: number | null;
  statusCommentId?: string | null;
  agentSessionId?: string | null;
  lastLinearActivityKey?: string | null;
  prNumber?: number | null;
  prUrl?: string | null;
  prState?: string | null;
  prIsDraft?: boolean | null;
  prHeadSha?: string | null;
  prAuthorLogin?: string | null;
  prReviewState?: string | null;
  prCheckStatus?: string | null;
  lastBlockingReviewHeadSha?: string | null;
  lastGitHubFailureSource?: GitHubFailureSource | null;
  lastGitHubFailureHeadSha?: string | null;
  lastGitHubFailureSignature?: string | null;
  lastGitHubFailureCheckName?: string | null;
  lastGitHubFailureCheckUrl?: string | null;
  lastGitHubFailureContextJson?: string | null;
  lastGitHubFailureAt?: string | null;
  lastGitHubCiSnapshotHeadSha?: string | null;
  lastGitHubCiSnapshotGateCheckName?: string | null;
  lastGitHubCiSnapshotGateCheckStatus?: string | null;
  lastGitHubCiSnapshotJson?: string | null;
  lastGitHubCiSnapshotSettledAt?: string | null;
  lastQueueSignalAt?: string | null;
  lastQueueIncidentJson?: string | null;
  lastAttemptedFailureHeadSha?: string | null;
  lastAttemptedFailureSignature?: string | null;
  lastAttemptedFailureAt?: string | null;
  lastPublishedPatchId?: string | null;
  lastPublishedIntegrationTreeId?: string | null;
  lastPublishedHeadSha?: string | null;
  parentPrBranch?: string | null;
  ciRepairAttempts?: number;
  queueRepairAttempts?: number;
  reviewFixAttempts?: number;
  zombieRecoveryAttempts?: number;
  lastZombieRecoveryAt?: string | null;
  orchestrationSettleUntil?: string | null;
  deployStartedAt?: string | null;
}

const CANCELED_OR_DUPLICATE_CHILD_PREDICATE = `
  LOWER(TRIM(COALESCE(child.current_linear_state_type, ''))) NOT IN ('canceled', 'cancelled')
  AND LOWER(TRIM(COALESCE(child.current_linear_state, ''))) NOT IN ('duplicate', 'canceled', 'cancelled')
`;

const OPEN_CHILD_PREDICATE = `
  LOWER(TRIM(COALESCE(child.current_linear_state_type, ''))) NOT IN ('completed', 'canceled', 'cancelled')
  AND LOWER(TRIM(COALESCE(child.current_linear_state, ''))) NOT IN ('done', 'completed', 'duplicate', 'canceled', 'cancelled')
`;

export class IssueStore {
  constructor(
    private readonly connection: DatabaseConnection,
    private readonly syncIssueSessionFromIssue: (issue: IssueRecord) => void,
  ) {}

  upsertIssue(params: UpsertIssueParams): IssueRecord {
    const now = isoNow();
    const existing = this.getIssue(params.projectId, params.linearIssueId);
    if (existing) {
      const { assignments, values } = buildUpdateAssignments(params);
      const sql = `UPDATE issues SET ${["updated_at = @now", ...assignments].join(", ")} WHERE project_id = @projectId AND linear_issue_id = @linearIssueId`;
      this.connection.prepare(sql).run({
        ...values,
        now,
        projectId: params.projectId,
        linearIssueId: params.linearIssueId,
      });
    } else {
      const { columns, placeholders, values } = buildInsertBindings(params);
      const sql = `INSERT INTO issues (project_id, linear_issue_id, ${columns.join(", ")}, updated_at) VALUES (@projectId, @linearIssueId, ${placeholders.join(", ")}, @now)`;
      this.connection.prepare(sql).run({
        ...values,
        projectId: params.projectId,
        linearIssueId: params.linearIssueId,
        now,
      });
    }
    const updated = this.getIssue(params.projectId, params.linearIssueId)!;
    this.syncIssueSessionFromIssue(updated);
    return updated;
  }

  getIssue(projectId: string, linearIssueId: string): IssueRecord | undefined {
    const row = this.connection
      .prepare("SELECT * FROM issues WHERE project_id = ? AND linear_issue_id = ?")
      .get(projectId, linearIssueId) as Record<string, unknown> | undefined;
    return row ? mapIssueRow(row) : undefined;
  }

  getIssueById(id: number): IssueRecord | undefined {
    const row = this.connection.prepare("SELECT * FROM issues WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? mapIssueRow(row) : undefined;
  }

  getIssueByKey(issueKey: string): IssueRecord | undefined {
    const row = this.connection.prepare("SELECT * FROM issues WHERE issue_key = ?").get(issueKey) as Record<string, unknown> | undefined;
    return row ? mapIssueRow(row) : undefined;
  }

  getIssueByBranch(branchName: string): IssueRecord | undefined {
    const row = this.connection.prepare("SELECT * FROM issues WHERE branch_name = ?").get(branchName) as Record<string, unknown> | undefined;
    return row ? mapIssueRow(row) : undefined;
  }

  getIssueByPrNumber(prNumber: number): IssueRecord | undefined {
    const row = this.connection.prepare("SELECT * FROM issues WHERE pr_number = ?").get(prNumber) as Record<string, unknown> | undefined;
    return row ? mapIssueRow(row) : undefined;
  }

  listIssues(): IssueRecord[] {
    const rows = this.connection
      .prepare("SELECT * FROM issues ORDER BY updated_at DESC")
      .all() as Array<Record<string, unknown>>;
    return rows.map(mapIssueRow);
  }

  listIssuesWithAgentSessions(): IssueRecord[] {
    const rows = this.connection
      .prepare("SELECT * FROM issues WHERE agent_session_id IS NOT NULL ORDER BY updated_at DESC")
      .all() as Array<Record<string, unknown>>;
    return rows.map(mapIssueRow);
  }

  listIssuesByState(projectId: string, state: FactoryState): IssueRecord[] {
    const rows = this.connection
      .prepare("SELECT * FROM issues WHERE project_id = ? AND factory_state = ? ORDER BY pr_number ASC")
      .all(projectId, state) as Array<Record<string, unknown>>;
    return rows.map(mapIssueRow);
  }

  listIdleNonTerminalIssues(): IssueRecord[] {
    const rows = this.connection
      .prepare(
        `SELECT * FROM issues
         WHERE factory_state NOT IN ('done', 'escalated', 'failed', 'awaiting_input')
         AND active_run_id IS NULL
         AND pending_run_type IS NULL
         AND pr_number IS NOT NULL`,
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map(mapIssueRow);
  }

  // Safety net for orphaned wakes: any delegated, non-terminal issue
  // with at least one unprocessed session event but no active run.
  // The orchestrator's enqueueIssue is the only path that drains these
  // events, and a prior enqueueIssue call can be silently lost (worker
  // race, lease contention, in-memory queue cleared by service restart).
  // The idle reconciler iterates this set and re-enqueues each one.
  listIdleIssuesWithPendingWake(): IssueRecord[] {
    const rows = this.connection
      .prepare(
        `SELECT DISTINCT i.* FROM issues i
         INNER JOIN issue_session_events e
           ON e.project_id = i.project_id
          AND e.linear_issue_id = i.linear_issue_id
         WHERE e.processed_at IS NULL
           AND i.active_run_id IS NULL
           AND i.delegated_to_patchrelay = 1
           AND i.factory_state NOT IN ('done', 'escalated', 'failed', 'awaiting_input')`,
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map(mapIssueRow);
  }

  listBlockedDelegatedIssues(): IssueRecord[] {
    const rows = this.connection
      .prepare(
        `SELECT DISTINCT i.* FROM issues i
         JOIN issue_dependencies d ON d.project_id = i.project_id AND d.linear_issue_id = i.linear_issue_id
         WHERE i.factory_state = 'delegated'
         AND i.active_run_id IS NULL
         AND i.pending_run_type IS NULL`,
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map(mapIssueRow);
  }

  listAwaitingQueueIssues(): IssueRecord[] {
    const rows = this.connection
      .prepare(
        `SELECT * FROM issues
         WHERE factory_state = 'awaiting_queue'
         AND active_run_id IS NULL
         AND pending_run_type IS NULL
         AND pr_number IS NOT NULL`,
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map(mapIssueRow);
  }

  // Plan §8.3: parent-of-child index. Given a parent's branch name,
  // list every issue whose `parent_pr_branch` matches — i.e. PRs
  // stacked on that parent. The index is hit on every
  // `pr_synchronize` for a parent so it must stay cheap.
  listIssuesWithParentBranch(branchName: string): IssueRecord[] {
    const rows = this.connection
      .prepare(`SELECT * FROM issues WHERE parent_pr_branch = ? AND factory_state NOT IN ('done', 'failed')`)
      .all(branchName) as Array<Record<string, unknown>>;
    return rows.map(mapIssueRow);
  }

  // Issues that are approved by review-quill but stuck in In Review
  // because branch CI is failing — the merge-steward never admits them.
  // Plan §6.2: surface this as IN_REVIEW_STUCK so an operator notices
  // before the issue goes silent for hours.
  listApprovedRedCiIssues(): IssueRecord[] {
    const rows = this.connection
      .prepare(
        `SELECT * FROM issues
         WHERE factory_state = 'pr_open'
         AND active_run_id IS NULL
         AND pending_run_type IS NULL
         AND pr_number IS NOT NULL
         AND pr_review_state = 'approved'
         AND pr_check_status = 'failure'`,
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map(mapIssueRow);
  }

  replaceIssueDependencies(params: {
    projectId: string;
    linearIssueId: string;
    blockers: Array<{
      blockerLinearIssueId: string;
      blockerIssueKey?: string;
      blockerTitle?: string;
      blockerCurrentLinearState?: string;
      blockerCurrentLinearStateType?: string;
    }>;
  }): void {
    const now = isoNow();
    this.connection
      .prepare("DELETE FROM issue_dependencies WHERE project_id = ? AND linear_issue_id = ?")
      .run(params.projectId, params.linearIssueId);

    if (params.blockers.length === 0) {
      return;
    }

    const insert = this.connection.prepare(`
      INSERT INTO issue_dependencies (
        project_id,
        linear_issue_id,
        blocker_linear_issue_id,
        blocker_issue_key,
        blocker_title,
        blocker_current_linear_state,
        blocker_current_linear_state_type,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const blocker of params.blockers) {
      insert.run(
        params.projectId,
        params.linearIssueId,
        blocker.blockerLinearIssueId,
        blocker.blockerIssueKey ?? null,
        blocker.blockerTitle ?? null,
        blocker.blockerCurrentLinearState ?? null,
        blocker.blockerCurrentLinearStateType ?? null,
        now,
      );
    }
  }

  updateDependencyBlockerSnapshot(params: {
    projectId: string;
    blockerLinearIssueId: string;
    blockerIssueKey?: string;
    blockerTitle?: string;
    blockerCurrentLinearState?: string;
    blockerCurrentLinearStateType?: string;
  }): number {
    const sets: string[] = ["updated_at = @now"];
    const values: Record<string, unknown> = {
      now: isoNow(),
      projectId: params.projectId,
      blockerLinearIssueId: params.blockerLinearIssueId,
    };

    if (params.blockerIssueKey !== undefined) {
      sets.push("blocker_issue_key = COALESCE(@blockerIssueKey, blocker_issue_key)");
      values.blockerIssueKey = params.blockerIssueKey;
    }
    if (params.blockerTitle !== undefined) {
      sets.push("blocker_title = COALESCE(@blockerTitle, blocker_title)");
      values.blockerTitle = params.blockerTitle;
    }
    if (params.blockerCurrentLinearState !== undefined) {
      sets.push("blocker_current_linear_state = COALESCE(@blockerCurrentLinearState, blocker_current_linear_state)");
      values.blockerCurrentLinearState = params.blockerCurrentLinearState;
    }
    if (params.blockerCurrentLinearStateType !== undefined) {
      sets.push("blocker_current_linear_state_type = COALESCE(@blockerCurrentLinearStateType, blocker_current_linear_state_type)");
      values.blockerCurrentLinearStateType = params.blockerCurrentLinearStateType;
    }

    const result = this.connection.prepare(`
      UPDATE issue_dependencies
      SET ${sets.join(", ")}
      WHERE project_id = @projectId
        AND blocker_linear_issue_id = @blockerLinearIssueId
    `).run(values);

    return Number(result.changes);
  }

  listIssueDependencies(projectId: string, linearIssueId: string): IssueDependencyRecord[] {
    const rows = this.connection.prepare(`
      SELECT
        d.project_id,
        d.linear_issue_id,
        d.blocker_linear_issue_id,
        COALESCE(blockers.issue_key, d.blocker_issue_key) AS blocker_issue_key,
        COALESCE(blockers.title, d.blocker_title) AS blocker_title,
        COALESCE(blockers.current_linear_state, d.blocker_current_linear_state) AS blocker_current_linear_state,
        COALESCE(blockers.current_linear_state_type, d.blocker_current_linear_state_type) AS blocker_current_linear_state_type,
        d.updated_at
      FROM issue_dependencies d
      LEFT JOIN issues blockers
        ON blockers.project_id = d.project_id
       AND blockers.linear_issue_id = d.blocker_linear_issue_id
      WHERE d.project_id = ? AND d.linear_issue_id = ?
      ORDER BY COALESCE(blockers.issue_key, d.blocker_issue_key, d.blocker_linear_issue_id) ASC
    `).all(projectId, linearIssueId) as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      projectId: String(row.project_id),
      linearIssueId: String(row.linear_issue_id),
      blockerLinearIssueId: String(row.blocker_linear_issue_id),
      ...(row.blocker_issue_key !== null && row.blocker_issue_key !== undefined ? { blockerIssueKey: String(row.blocker_issue_key) } : {}),
      ...(row.blocker_title !== null && row.blocker_title !== undefined ? { blockerTitle: String(row.blocker_title) } : {}),
      ...(row.blocker_current_linear_state !== null && row.blocker_current_linear_state !== undefined
        ? { blockerCurrentLinearState: String(row.blocker_current_linear_state) }
        : {}),
      ...(row.blocker_current_linear_state_type !== null && row.blocker_current_linear_state_type !== undefined
        ? { blockerCurrentLinearStateType: String(row.blocker_current_linear_state_type) }
        : {}),
      updatedAt: String(row.updated_at),
    }));
  }

  listDependents(projectId: string, blockerLinearIssueId: string): Array<{ projectId: string; linearIssueId: string }> {
    const rows = this.connection.prepare(`
      SELECT project_id, linear_issue_id
      FROM issue_dependencies
      WHERE project_id = ? AND blocker_linear_issue_id = ?
      ORDER BY linear_issue_id ASC
    `).all(projectId, blockerLinearIssueId) as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      projectId: String(row.project_id),
      linearIssueId: String(row.linear_issue_id),
    }));
  }

  replaceIssueParentLink(params: {
    projectId: string;
    childLinearIssueId: string;
    parentLinearIssueId?: string | null;
  }): void {
    const now = isoNow();
    this.connection
      .prepare("DELETE FROM issue_children WHERE project_id = ? AND child_linear_issue_id = ?")
      .run(params.projectId, params.childLinearIssueId);

    if (!params.parentLinearIssueId) {
      return;
    }

    this.connection.prepare(`
      INSERT INTO issue_children (
        project_id,
        parent_linear_issue_id,
        child_linear_issue_id,
        updated_at
      ) VALUES (?, ?, ?, ?)
    `).run(
      params.projectId,
      params.parentLinearIssueId,
      params.childLinearIssueId,
      now,
    );
  }

  listChildLinks(projectId: string, parentLinearIssueId: string): IssueChildRecord[] {
    const rows = this.connection.prepare(`
      SELECT project_id, parent_linear_issue_id, child_linear_issue_id, updated_at
      FROM issue_children
      WHERE project_id = ? AND parent_linear_issue_id = ?
      ORDER BY child_linear_issue_id ASC
    `).all(projectId, parentLinearIssueId) as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      projectId: String(row.project_id),
      parentLinearIssueId: String(row.parent_linear_issue_id),
      childLinearIssueId: String(row.child_linear_issue_id),
      updatedAt: String(row.updated_at),
    }));
  }

  listChildIssues(projectId: string, parentLinearIssueId: string): IssueRecord[] {
    const rows = this.connection.prepare(`
      SELECT child.*
      FROM issue_children edges
      JOIN issues child
        ON child.project_id = edges.project_id
       AND child.linear_issue_id = edges.child_linear_issue_id
      WHERE edges.project_id = ? AND edges.parent_linear_issue_id = ?
      ORDER BY COALESCE(child.issue_key, child.linear_issue_id) ASC
    `).all(projectId, parentLinearIssueId) as Array<Record<string, unknown>>;

    return rows.map(mapIssueRow);
  }

  listCanonicalChildIssues(projectId: string, parentLinearIssueId: string): IssueRecord[] {
    const rows = this.connection.prepare(`
      SELECT child.*
      FROM issue_children edges
      JOIN issues child
        ON child.project_id = edges.project_id
       AND child.linear_issue_id = edges.child_linear_issue_id
      WHERE edges.project_id = ? AND edges.parent_linear_issue_id = ?
        AND ${CANCELED_OR_DUPLICATE_CHILD_PREDICATE}
      ORDER BY COALESCE(child.issue_key, child.linear_issue_id) ASC
    `).all(projectId, parentLinearIssueId) as Array<Record<string, unknown>>;

    return rows.map(mapIssueRow);
  }

  countOpenChildIssues(projectId: string, parentLinearIssueId: string): number {
    const row = this.connection.prepare(`
      SELECT COUNT(*) AS count
      FROM issue_children edges
      LEFT JOIN issues child
        ON child.project_id = edges.project_id
       AND child.linear_issue_id = edges.child_linear_issue_id
      WHERE edges.project_id = ? AND edges.parent_linear_issue_id = ?
        AND (
          child.linear_issue_id IS NULL
          OR (${OPEN_CHILD_PREDICATE})
        )
    `).get(projectId, parentLinearIssueId) as Record<string, unknown> | undefined;

    return Number(row?.count ?? 0);
  }

  countUnresolvedBlockers(projectId: string, linearIssueId: string): number {
    const row = this.connection.prepare(`
      SELECT COUNT(*) AS count
      FROM issue_dependencies d
      LEFT JOIN issues blockers
        ON blockers.project_id = d.project_id
       AND blockers.linear_issue_id = d.blocker_linear_issue_id
      WHERE d.project_id = ? AND d.linear_issue_id = ?
        AND (
          COALESCE(blockers.current_linear_state_type, d.blocker_current_linear_state_type, '') != 'completed'
          AND LOWER(TRIM(COALESCE(blockers.current_linear_state, d.blocker_current_linear_state, ''))) != 'done'
        )
    `).get(projectId, linearIssueId) as Record<string, unknown> | undefined;
    return Number(row?.count ?? 0);
  }

  getLatestGitHubCiSnapshot(projectId: string, linearIssueId: string): GitHubCiSnapshotRecord | undefined {
    const issue = this.getIssue(projectId, linearIssueId);
    if (!issue?.lastGitHubCiSnapshotJson) return undefined;
    try {
      return JSON.parse(issue.lastGitHubCiSnapshotJson) as GitHubCiSnapshotRecord;
    } catch {
      return undefined;
    }
  }
}

export function mapIssueRow(row: Record<string, unknown>): IssueRecord {
  return {
    id: Number(row.id),
    projectId: String(row.project_id),
    linearIssueId: String(row.linear_issue_id),
    delegatedToPatchRelay: Number(row.delegated_to_patchrelay ?? 1) !== 0,
    ...(row.issue_class !== null && row.issue_class !== undefined ? { issueClass: String(row.issue_class) as IssueClass } : {}),
    ...(row.issue_class_source !== null && row.issue_class_source !== undefined
      ? { issueClassSource: String(row.issue_class_source) as IssueClassSource }
      : {}),
    ...(row.issue_triage_hash !== null && row.issue_triage_hash !== undefined
      ? { issueTriageHash: String(row.issue_triage_hash) }
      : {}),
    ...(row.issue_triage_result_json !== null && row.issue_triage_result_json !== undefined
      ? { issueTriageResultJson: String(row.issue_triage_result_json) }
      : {}),
    ...(row.parent_linear_issue_id !== null && row.parent_linear_issue_id !== undefined
      ? { parentLinearIssueId: String(row.parent_linear_issue_id) }
      : {}),
    ...(row.parent_issue_key !== null && row.parent_issue_key !== undefined ? { parentIssueKey: String(row.parent_issue_key) } : {}),
    ...(row.issue_key !== null ? { issueKey: String(row.issue_key) } : {}),
    ...(row.title !== null ? { title: String(row.title) } : {}),
    ...(row.description !== null && row.description !== undefined ? { description: String(row.description) } : {}),
    ...(row.url !== null ? { url: String(row.url) } : {}),
    ...(row.priority !== null && row.priority !== undefined ? { priority: Number(row.priority) } : {}),
    ...(row.estimate !== null && row.estimate !== undefined ? { estimate: Number(row.estimate) } : {}),
    ...(row.current_linear_state !== null ? { currentLinearState: String(row.current_linear_state) } : {}),
    ...(row.current_linear_state_type !== null && row.current_linear_state_type !== undefined
      ? { currentLinearStateType: String(row.current_linear_state_type) }
      : {}),
    factoryState: String(row.factory_state ?? "delegated") as FactoryState,
    ...(row.pending_run_type !== null && row.pending_run_type !== undefined ? { pendingRunType: String(row.pending_run_type) as RunType } : {}),
    ...(row.pending_run_context_json !== null && row.pending_run_context_json !== undefined ? { pendingRunContextJson: String(row.pending_run_context_json) } : {}),
    ...(row.branch_name !== null ? { branchName: String(row.branch_name) } : {}),
    ...(row.worktree_path !== null ? { worktreePath: String(row.worktree_path) } : {}),
    ...(row.thread_id !== null ? { threadId: String(row.thread_id) } : {}),
    ...(row.active_run_id !== null ? { activeRunId: Number(row.active_run_id) } : {}),
    ...(row.status_comment_id !== null && row.status_comment_id !== undefined ? { statusCommentId: String(row.status_comment_id) } : {}),
    ...(row.agent_session_id !== null ? { agentSessionId: String(row.agent_session_id) } : {}),
    ...(row.last_linear_activity_key !== null && row.last_linear_activity_key !== undefined
      ? { lastLinearActivityKey: String(row.last_linear_activity_key) }
      : {}),
    updatedAt: String(row.updated_at),
    ...(row.pr_number !== null && row.pr_number !== undefined ? { prNumber: Number(row.pr_number) } : {}),
    ...(row.pr_url !== null && row.pr_url !== undefined ? { prUrl: String(row.pr_url) } : {}),
    ...(row.pr_state !== null && row.pr_state !== undefined ? { prState: String(row.pr_state) } : {}),
    ...(row.pr_is_draft !== null && row.pr_is_draft !== undefined ? { prIsDraft: Boolean(row.pr_is_draft) } : {}),
    ...(row.pr_head_sha !== null && row.pr_head_sha !== undefined ? { prHeadSha: String(row.pr_head_sha) } : {}),
    ...(row.pr_author_login !== null && row.pr_author_login !== undefined ? { prAuthorLogin: String(row.pr_author_login) } : {}),
    ...(row.pr_review_state !== null && row.pr_review_state !== undefined ? { prReviewState: String(row.pr_review_state) } : {}),
    ...(row.pr_check_status !== null && row.pr_check_status !== undefined ? { prCheckStatus: String(row.pr_check_status) } : {}),
    ...(row.last_blocking_review_head_sha !== null && row.last_blocking_review_head_sha !== undefined
      ? { lastBlockingReviewHeadSha: String(row.last_blocking_review_head_sha) }
      : {}),
    ...(row.last_github_failure_source !== null && row.last_github_failure_source !== undefined
      ? { lastGitHubFailureSource: String(row.last_github_failure_source) as GitHubFailureSource }
      : {}),
    ...(row.last_github_failure_head_sha !== null && row.last_github_failure_head_sha !== undefined
      ? { lastGitHubFailureHeadSha: String(row.last_github_failure_head_sha) }
      : {}),
    ...(row.last_github_failure_signature !== null && row.last_github_failure_signature !== undefined
      ? { lastGitHubFailureSignature: String(row.last_github_failure_signature) }
      : {}),
    ...(row.last_github_failure_check_name !== null && row.last_github_failure_check_name !== undefined
      ? { lastGitHubFailureCheckName: String(row.last_github_failure_check_name) }
      : {}),
    ...(row.last_github_failure_check_url !== null && row.last_github_failure_check_url !== undefined
      ? { lastGitHubFailureCheckUrl: String(row.last_github_failure_check_url) }
      : {}),
    ...(row.last_github_failure_context_json !== null && row.last_github_failure_context_json !== undefined
      ? { lastGitHubFailureContextJson: String(row.last_github_failure_context_json) }
      : {}),
    ...(row.last_github_failure_at !== null && row.last_github_failure_at !== undefined
      ? { lastGitHubFailureAt: String(row.last_github_failure_at) }
      : {}),
    ...(row.last_github_ci_snapshot_head_sha !== null && row.last_github_ci_snapshot_head_sha !== undefined
      ? { lastGitHubCiSnapshotHeadSha: String(row.last_github_ci_snapshot_head_sha) }
      : {}),
    ...(row.last_github_ci_snapshot_gate_check_name !== null && row.last_github_ci_snapshot_gate_check_name !== undefined
      ? { lastGitHubCiSnapshotGateCheckName: String(row.last_github_ci_snapshot_gate_check_name) }
      : {}),
    ...(row.last_github_ci_snapshot_gate_check_status !== null && row.last_github_ci_snapshot_gate_check_status !== undefined
      ? { lastGitHubCiSnapshotGateCheckStatus: String(row.last_github_ci_snapshot_gate_check_status) }
      : {}),
    ...(row.last_github_ci_snapshot_json !== null && row.last_github_ci_snapshot_json !== undefined
      ? { lastGitHubCiSnapshotJson: String(row.last_github_ci_snapshot_json) }
      : {}),
    ...(row.last_github_ci_snapshot_settled_at !== null && row.last_github_ci_snapshot_settled_at !== undefined
      ? { lastGitHubCiSnapshotSettledAt: String(row.last_github_ci_snapshot_settled_at) }
      : {}),
    ...(row.last_queue_signal_at !== null && row.last_queue_signal_at !== undefined
      ? { lastQueueSignalAt: String(row.last_queue_signal_at) }
      : {}),
    ...(row.last_queue_incident_json !== null && row.last_queue_incident_json !== undefined
      ? { lastQueueIncidentJson: String(row.last_queue_incident_json) }
      : {}),
    ...(row.last_attempted_failure_head_sha !== null && row.last_attempted_failure_head_sha !== undefined
      ? { lastAttemptedFailureHeadSha: String(row.last_attempted_failure_head_sha) }
      : {}),
    ...(row.last_attempted_failure_signature !== null && row.last_attempted_failure_signature !== undefined
      ? { lastAttemptedFailureSignature: String(row.last_attempted_failure_signature) }
      : {}),
    ...(row.last_attempted_failure_at !== null && row.last_attempted_failure_at !== undefined
      ? { lastAttemptedFailureAt: String(row.last_attempted_failure_at) }
      : {}),
    ...(row.last_published_patch_id !== null && row.last_published_patch_id !== undefined
      ? { lastPublishedPatchId: String(row.last_published_patch_id) }
      : {}),
    ...(row.last_published_integration_tree_id !== null && row.last_published_integration_tree_id !== undefined
      ? { lastPublishedIntegrationTreeId: String(row.last_published_integration_tree_id) }
      : {}),
    ...(row.last_published_head_sha !== null && row.last_published_head_sha !== undefined
      ? { lastPublishedHeadSha: String(row.last_published_head_sha) }
      : {}),
    ...(row.parent_pr_branch !== null && row.parent_pr_branch !== undefined
      ? { parentPrBranch: String(row.parent_pr_branch) }
      : {}),
    ciRepairAttempts: Number(row.ci_repair_attempts ?? 0),
    queueRepairAttempts: Number(row.queue_repair_attempts ?? 0),
    reviewFixAttempts: Number(row.review_fix_attempts ?? 0),
    zombieRecoveryAttempts: Number(row.zombie_recovery_attempts ?? 0),
    ...(row.last_zombie_recovery_at !== null && row.last_zombie_recovery_at !== undefined ? { lastZombieRecoveryAt: String(row.last_zombie_recovery_at) } : {}),
    ...(row.orchestration_settle_until !== null && row.orchestration_settle_until !== undefined
      ? { orchestrationSettleUntil: String(row.orchestration_settle_until) }
      : {}),
    ...(row.deploy_started_at !== null && row.deploy_started_at !== undefined
      ? { deployStartedAt: String(row.deploy_started_at) }
      : {}),
  };
}
