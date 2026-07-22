import type {
  GitHubCiSnapshotRecord,
  IssueChildRecord,
  GitHubFailureSource,
  IssueDependencyRecord,
  IssueRecord,
} from "../db-types.ts";
import type { InputRequestKind, WorkflowOutcome } from "../issue-phase.ts";
import type { IssueSessionProjectionInvalidator } from "../issue-session-projection-invalidator.ts";
import type { IssueClass, IssueClassSource } from "../issue-class.ts";
import { buildInsertBindings, buildUpdateAssignments } from "./issue-upsert-columns.ts";
import { isoNow, type DatabaseConnection } from "./shared.ts";

const WORKFLOW_OUTCOMES = new Set<WorkflowOutcome>(["completed", "failed", "escalated"]);
const INPUT_REQUEST_KINDS = new Set<InputRequestKind>(["paused_local_work", "completion_check_question"]);

function parseWorkflowOutcome(value: unknown): WorkflowOutcome {
  const outcome = String(value);
  if (!WORKFLOW_OUTCOMES.has(outcome as WorkflowOutcome)) {
    throw new Error(`Invalid persisted workflow_outcome: ${outcome}`);
  }
  return outcome as WorkflowOutcome;
}

function parseInputRequestKind(value: unknown): InputRequestKind {
  const kind = String(value);
  if (!INPUT_REQUEST_KINDS.has(kind as InputRequestKind)) {
    throw new Error(`Invalid persisted input_request_kind: ${kind}`);
  }
  return kind as InputRequestKind;
}

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
  workflowOutcome?: WorkflowOutcome | null;
  workflowOutcomeReason?: string | null;
  inputRequestKind?: InputRequestKind | null;
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
  capacityBackoffUntil?: string | null;
  capacityBackoffAttempts?: number;
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
    private readonly issueSessionProjection: IssueSessionProjectionInvalidator,
  ) {}

  upsertIssue(params: UpsertIssueParams): IssueRecord {
    const now = isoNow();
    const existing = this.getIssue(params.projectId, params.linearIssueId);
    if (existing) {
      const { assignments, values } = buildUpdateAssignments(params);
      const sql = `UPDATE issues SET ${["updated_at = @now", "version = version + 1", ...assignments].join(", ")} WHERE project_id = @projectId AND linear_issue_id = @linearIssueId`;
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
    this.issueSessionProjection.issueChanged(updated);
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

  // Terminal issues (escalated/failed) that still carry an idle PR worth
  // re-probing against GitHub. The vast majority of issues are 'done' and
  // never qualify, so filtering in SQL avoids loading the whole table and
  // running a per-issue run lookup just to discard it. The caller keeps its
  // exact JS predicate (shouldProbeTerminalIssueFromGitHub) as the source of
  // truth; this query only narrows the candidate set.
  listTerminalIssuesNeedingGitHubProbe(): IssueRecord[] {
    const rows = this.connection
      .prepare(
        `SELECT * FROM issues
         WHERE workflow_outcome IN ('escalated', 'failed')
           AND pr_number IS NOT NULL
           AND active_run_id IS NULL
           AND (pr_state IS NULL OR pr_state != 'merged')`,
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map(mapIssueRow);
  }

  // Orchestration issues with a settle deadline that may have elapsed. The
  // exact time/finite-parse check stays in the caller; this narrows from the
  // full table to the handful of orchestration rows with a pending settle.
  listOrchestrationIssuesWithSettleDeadline(): IssueRecord[] {
    const rows = this.connection
      .prepare(
        `SELECT * FROM issues
         WHERE issue_class = 'orchestration'
           AND orchestration_settle_until IS NOT NULL
           AND active_run_id IS NULL
           AND delegated_to_patchrelay = 1`,
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map(mapIssueRow);
  }

  // Recently-updated done/merged issues for the merged-Linear completion
  // reconciler. `updatedSinceIso` is an ISO-8601 UTC timestamp; updated_at is
  // stored in the same format so lexicographic comparison is correct. The
  // caller re-applies its exact recency predicate; this skips the ~98% of
  // 'done' issues that fell outside the reconcile window.
  listRecentCompletionCandidates(updatedSinceIso: string): IssueRecord[] {
    const rows = this.connection
      .prepare(
        `SELECT * FROM issues
         WHERE updated_at >= ?
           AND (workflow_outcome = 'completed' OR pr_state = 'merged')
         ORDER BY updated_at DESC`,
      )
      .all(updatedSinceIso) as Array<Record<string, unknown>>;
    return rows.map(mapIssueRow);
  }

  // Issues whose durable workflow tasks may need reconciling. A done/failed
  // issue produces no tasks (deriveWorkflowTasks short-circuits), so the only
  // terminal issues worth visiting are those that still hold an open task to
  // close. Everything else is non-terminal. This skips the ~98% of issues
  // that are 'done' with nothing open — a guaranteed no-op otherwise.
  listWorkflowTaskReconcileCandidates(): IssueRecord[] {
    const rows = this.connection
      .prepare(
        `SELECT * FROM issues AS i
         WHERE i.workflow_outcome IS NULL
            OR i.workflow_outcome != 'completed'
            OR EXISTS (
                 SELECT 1 FROM workflow_tasks t
                 WHERE t.project_id = i.project_id
                   AND t.subject_id = i.linear_issue_id
                   AND t.status = 'open'
               )`,
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map(mapIssueRow);
  }

  // Terminal, run-free issues whose stale inbox events should be cleared.
  // Iterating the whole table every tick was wasteful
  // (non-actionable events like self_comment/delegation_observed accumulate on
  // done issues and would otherwise be re-checked forever). `nonActionable` is
  // passed from NON_ACTIONABLE_SESSION_EVENTS so the actionable definition has
  // one home; the caller keeps its exact JS guards as the source of truth.
  listTerminalIssuesWithStaleInbox(nonActionable: readonly string[]): IssueRecord[] {
    const placeholders = nonActionable.map(() => "?").join(", ");
    const exclusion = placeholders ? `AND e.event_type NOT IN (${placeholders})` : "";
    const rows = this.connection
      .prepare(
        `SELECT * FROM issues AS i
         WHERE i.active_run_id IS NULL
           AND (i.workflow_outcome IS NOT NULL OR i.input_request_kind IS NOT NULL)
           AND EXISTS (
             SELECT 1 FROM issue_session_events e
             WHERE e.project_id = i.project_id
               AND e.linear_issue_id = i.linear_issue_id
               AND e.processed_at IS NULL
               ${exclusion}
           )`,
      )
      .all(...nonActionable) as Array<Record<string, unknown>>;
    return rows.map(mapIssueRow);
  }

  // Issues that currently pin an active run. Used by restart recovery to
  // re-sync agent sessions without loading the whole (mostly terminal) table.
  listIssuesWithActiveRun(): IssueRecord[] {
    const rows = this.connection
      .prepare("SELECT * FROM issues WHERE active_run_id IS NOT NULL")
      .all() as Array<Record<string, unknown>>;
    return rows.map(mapIssueRow);
  }

  listIdleNonTerminalIssues(): IssueRecord[] {
    const rows = this.connection
      .prepare(
        `SELECT * FROM issues
         WHERE workflow_outcome IS NULL
         AND input_request_kind IS NULL
         AND active_run_id IS NULL
         AND pr_number IS NOT NULL`,
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map(mapIssueRow);
  }

  // Recovery net for a dangling active slot: an issue whose
  // `active_run_id` still points at a run that has already reached a
  // terminal status. This happens when the post-run finalize never ran
  // to completion — almost always a service restart landing between
  // `finishRun` (which marks the run terminal) and the issue write that
  // clears `active_run_id` and arms the next workflow task. The Codex
  // `turn/completed` notification that would finalize it never re-fires
  // after restart, and every idle/recovery pass gates on
  // `active_run_id IS NULL`, so the issue is invisible to all of them
  // and freezes indefinitely. The orchestrator clears the slot so the
  // idle reconciler can route the issue forward (review_fix, etc.).
  listIssuesWithTerminalActiveRun(): IssueRecord[] {
    const rows = this.connection
      .prepare(
        `SELECT i.* FROM issues i
         JOIN runs r ON r.id = i.active_run_id
         WHERE i.active_run_id IS NOT NULL
         AND r.status IN ('completed', 'failed', 'released', 'superseded')`,
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map(mapIssueRow);
  }

  // The idle reconciler's safety-net sweep: idle, delegated, non-terminal
  // issues that carry a runnable workflow task the direct dispatch may have
  // missed (lease race, restart). Session events are inbox/audit facts; they do
  // not make an issue scheduler-ready unless task reconciliation materializes a
  // runnable workflow task from durable facts.
  listIdleIssuesWithRunnableWorkflowTask(): IssueRecord[] {
    const rows = this.connection
      .prepare(
        `SELECT DISTINCT i.* FROM issues i
         INNER JOIN workflow_tasks t
           ON t.project_id = i.project_id
          AND t.subject_id = i.linear_issue_id
         WHERE t.status = 'open'
           AND t.task_type = 'run'
           AND t.gate_action = 'start'
           AND t.run_type IS NOT NULL
           AND i.active_run_id IS NULL
           AND i.delegated_to_patchrelay = 1
           AND i.workflow_outcome IS NULL
           AND i.input_request_kind IS NULL`,
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map(mapIssueRow);
  }

  listBlockedDelegatedIssues(): IssueRecord[] {
    const rows = this.connection
      .prepare(
        `SELECT DISTINCT i.* FROM issues i
         JOIN issue_dependencies d ON d.project_id = i.project_id AND d.linear_issue_id = i.linear_issue_id
         WHERE i.delegated_to_patchrelay = 1
         AND i.workflow_outcome IS NULL
         AND i.input_request_kind IS NULL
         AND i.active_run_id IS NULL`,
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map(mapIssueRow);
  }

  listAwaitingQueueIssues(): IssueRecord[] {
    const rows = this.connection
      .prepare(
        `SELECT * FROM issues
         WHERE workflow_outcome IS NULL
         AND input_request_kind IS NULL
         AND active_run_id IS NULL
         AND pr_number IS NOT NULL
         AND pr_review_state = 'approved'`,
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
      .prepare(`SELECT * FROM issues WHERE parent_pr_branch = ? AND workflow_outcome IS NULL`)
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
         WHERE active_run_id IS NULL
         AND workflow_outcome IS NULL
         AND input_request_kind IS NULL
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
      this.issueSessionProjection.issueDependenciesChanged(params.projectId, params.linearIssueId);
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

    this.issueSessionProjection.issueDependenciesChanged(params.projectId, params.linearIssueId);
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

    if (Number(result.changes) > 0) {
      this.issueSessionProjection.dependencyBlockerChanged(params.projectId, params.blockerLinearIssueId);
    }

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

  /**
   * Raw rows for the CLI issue-summary read model (one row per issue joined to
   * its session and active/latest run), optionally scoped to a project. Row
   * shaping lives in the CLI layer; this owns only the SQL.
   */
  listIssueSummaryRows(project?: string): Array<Record<string, unknown>> {
    const whereClause = project ? "WHERE i.project_id = ?" : "";
    const values = project ? [project] : [];
    return this.connection
      .prepare(
        `
        SELECT
          i.project_id,
          i.linear_issue_id,
          i.issue_key,
          i.title,
          i.current_linear_state,
          i.current_linear_state_type,
          i.delegated_to_patchrelay,
          i.workflow_outcome,
          i.input_request_kind,
          i.pr_number,
          i.pr_state,
          i.pr_is_draft,
          i.pr_review_state,
          i.pr_check_status,
          i.last_github_failure_source,
          i.deploy_started_at,
          i.updated_at,
          s.session_state,
          s.waiting_reason,
          active_run.run_type AS active_run_type,
          latest_run.run_type AS latest_run_type,
          latest_run.status AS latest_run_status
        FROM issues i
        LEFT JOIN issue_sessions s
          ON s.project_id = i.project_id
         AND s.linear_issue_id = i.linear_issue_id
        LEFT JOIN runs active_run ON active_run.id = i.active_run_id
        LEFT JOIN runs latest_run ON latest_run.id = (
          SELECT r.id FROM runs r
          WHERE r.project_id = i.project_id AND r.linear_issue_id = i.linear_issue_id
          ORDER BY r.id DESC LIMIT 1
        )
        ${whereClause}
        ORDER BY i.updated_at DESC, i.issue_key ASC
        `,
      )
      .all(...values) as Array<Record<string, unknown>>;
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
    ...(row.workflow_outcome !== null && row.workflow_outcome !== undefined
      ? { workflowOutcome: parseWorkflowOutcome(row.workflow_outcome) }
      : {}),
    ...(row.workflow_outcome_reason !== null && row.workflow_outcome_reason !== undefined
      ? { workflowOutcomeReason: String(row.workflow_outcome_reason) }
      : {}),
    ...(row.input_request_kind !== null && row.input_request_kind !== undefined
      ? { inputRequestKind: parseInputRequestKind(row.input_request_kind) }
      : {}),
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
    ...(row.capacity_backoff_until !== null && row.capacity_backoff_until !== undefined
      ? { capacityBackoffUntil: String(row.capacity_backoff_until) }
      : {}),
    capacityBackoffAttempts: Number(row.capacity_backoff_attempts ?? 0),
    ...(row.orchestration_settle_until !== null && row.orchestration_settle_until !== undefined
      ? { orchestrationSettleUntil: String(row.orchestration_settle_until) }
      : {}),
    ...(row.deploy_started_at !== null && row.deploy_started_at !== undefined
      ? { deployStartedAt: String(row.deploy_started_at) }
      : {}),
    version: Number(row.version ?? 0),
  };
}
