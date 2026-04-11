import type {
  GitHubCiSnapshotRecord,
  GitHubFailureSource,
  IssueDependencyRecord,
  IssueRecord,
} from "../db-types.ts";
import type { FactoryState, RunType } from "../factory-state.ts";
import { isoNow, type DatabaseConnection } from "./shared.ts";

export interface UpsertIssueParams {
  projectId: string;
  linearIssueId: string;
  delegatedToPatchRelay?: boolean;
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
  ciRepairAttempts?: number;
  queueRepairAttempts?: number;
  reviewFixAttempts?: number;
  zombieRecoveryAttempts?: number;
  lastZombieRecoveryAt?: string | null;
}

export class IssueStore {
  constructor(
    private readonly connection: DatabaseConnection,
    private readonly syncIssueSessionFromIssue: (issue: IssueRecord) => void,
  ) {}

  upsertIssue(params: UpsertIssueParams): IssueRecord {
    const now = isoNow();
    const existing = this.getIssue(params.projectId, params.linearIssueId);
    if (existing) {
      const sets: string[] = ["updated_at = @now"];
      const values: Record<string, unknown> = {
        now,
        projectId: params.projectId,
        linearIssueId: params.linearIssueId,
      };
      if (params.delegatedToPatchRelay !== undefined) { sets.push("delegated_to_patchrelay = @delegatedToPatchRelay"); values.delegatedToPatchRelay = params.delegatedToPatchRelay ? 1 : 0; }
      if (params.issueKey !== undefined) { sets.push("issue_key = COALESCE(@issueKey, issue_key)"); values.issueKey = params.issueKey; }
      if (params.title !== undefined) { sets.push("title = COALESCE(@title, title)"); values.title = params.title; }
      if (params.description !== undefined) { sets.push("description = COALESCE(@description, description)"); values.description = params.description; }
      if (params.url !== undefined) { sets.push("url = COALESCE(@url, url)"); values.url = params.url; }
      if (params.priority !== undefined) { sets.push("priority = @priority"); values.priority = params.priority; }
      if (params.estimate !== undefined) { sets.push("estimate = @estimate"); values.estimate = params.estimate; }
      if (params.currentLinearState !== undefined) { sets.push("current_linear_state = COALESCE(@currentLinearState, current_linear_state)"); values.currentLinearState = params.currentLinearState; }
      if (params.currentLinearStateType !== undefined) { sets.push("current_linear_state_type = COALESCE(@currentLinearStateType, current_linear_state_type)"); values.currentLinearStateType = params.currentLinearStateType; }
      if (params.factoryState !== undefined) { sets.push("factory_state = @factoryState"); values.factoryState = params.factoryState; }
      if (params.pendingRunType !== undefined) { sets.push("pending_run_type = @pendingRunType"); values.pendingRunType = params.pendingRunType; }
      if (params.pendingRunContextJson !== undefined) { sets.push("pending_run_context_json = @pendingRunContextJson"); values.pendingRunContextJson = params.pendingRunContextJson; }
      if (params.branchName !== undefined) { sets.push("branch_name = COALESCE(@branchName, branch_name)"); values.branchName = params.branchName; }
      if (params.worktreePath !== undefined) { sets.push("worktree_path = COALESCE(@worktreePath, worktree_path)"); values.worktreePath = params.worktreePath; }
      if (params.threadId !== undefined) { sets.push("thread_id = @threadId"); values.threadId = params.threadId; }
      if (params.activeRunId !== undefined) { sets.push("active_run_id = @activeRunId"); values.activeRunId = params.activeRunId; }
      if (params.statusCommentId !== undefined) { sets.push("status_comment_id = @statusCommentId"); values.statusCommentId = params.statusCommentId; }
      if (params.agentSessionId !== undefined) { sets.push("agent_session_id = @agentSessionId"); values.agentSessionId = params.agentSessionId; }
      if (params.lastLinearActivityKey !== undefined) { sets.push("last_linear_activity_key = @lastLinearActivityKey"); values.lastLinearActivityKey = params.lastLinearActivityKey; }
      if (params.prNumber !== undefined) { sets.push("pr_number = @prNumber"); values.prNumber = params.prNumber; }
      if (params.prUrl !== undefined) { sets.push("pr_url = @prUrl"); values.prUrl = params.prUrl; }
      if (params.prState !== undefined) { sets.push("pr_state = @prState"); values.prState = params.prState; }
      if (params.prHeadSha !== undefined) { sets.push("pr_head_sha = @prHeadSha"); values.prHeadSha = params.prHeadSha; }
      if (params.prAuthorLogin !== undefined) { sets.push("pr_author_login = @prAuthorLogin"); values.prAuthorLogin = params.prAuthorLogin; }
      if (params.prReviewState !== undefined) { sets.push("pr_review_state = @prReviewState"); values.prReviewState = params.prReviewState; }
      if (params.prCheckStatus !== undefined) { sets.push("pr_check_status = @prCheckStatus"); values.prCheckStatus = params.prCheckStatus; }
      if (params.lastBlockingReviewHeadSha !== undefined) { sets.push("last_blocking_review_head_sha = @lastBlockingReviewHeadSha"); values.lastBlockingReviewHeadSha = params.lastBlockingReviewHeadSha; }
      if (params.lastGitHubFailureSource !== undefined) { sets.push("last_github_failure_source = @lastGitHubFailureSource"); values.lastGitHubFailureSource = params.lastGitHubFailureSource; }
      if (params.lastGitHubFailureHeadSha !== undefined) { sets.push("last_github_failure_head_sha = @lastGitHubFailureHeadSha"); values.lastGitHubFailureHeadSha = params.lastGitHubFailureHeadSha; }
      if (params.lastGitHubFailureSignature !== undefined) { sets.push("last_github_failure_signature = @lastGitHubFailureSignature"); values.lastGitHubFailureSignature = params.lastGitHubFailureSignature; }
      if (params.lastGitHubFailureCheckName !== undefined) { sets.push("last_github_failure_check_name = @lastGitHubFailureCheckName"); values.lastGitHubFailureCheckName = params.lastGitHubFailureCheckName; }
      if (params.lastGitHubFailureCheckUrl !== undefined) { sets.push("last_github_failure_check_url = @lastGitHubFailureCheckUrl"); values.lastGitHubFailureCheckUrl = params.lastGitHubFailureCheckUrl; }
      if (params.lastGitHubFailureContextJson !== undefined) { sets.push("last_github_failure_context_json = @lastGitHubFailureContextJson"); values.lastGitHubFailureContextJson = params.lastGitHubFailureContextJson; }
      if (params.lastGitHubFailureAt !== undefined) { sets.push("last_github_failure_at = @lastGitHubFailureAt"); values.lastGitHubFailureAt = params.lastGitHubFailureAt; }
      if (params.lastGitHubCiSnapshotHeadSha !== undefined) { sets.push("last_github_ci_snapshot_head_sha = @lastGitHubCiSnapshotHeadSha"); values.lastGitHubCiSnapshotHeadSha = params.lastGitHubCiSnapshotHeadSha; }
      if (params.lastGitHubCiSnapshotGateCheckName !== undefined) { sets.push("last_github_ci_snapshot_gate_check_name = @lastGitHubCiSnapshotGateCheckName"); values.lastGitHubCiSnapshotGateCheckName = params.lastGitHubCiSnapshotGateCheckName; }
      if (params.lastGitHubCiSnapshotGateCheckStatus !== undefined) { sets.push("last_github_ci_snapshot_gate_check_status = @lastGitHubCiSnapshotGateCheckStatus"); values.lastGitHubCiSnapshotGateCheckStatus = params.lastGitHubCiSnapshotGateCheckStatus; }
      if (params.lastGitHubCiSnapshotJson !== undefined) { sets.push("last_github_ci_snapshot_json = @lastGitHubCiSnapshotJson"); values.lastGitHubCiSnapshotJson = params.lastGitHubCiSnapshotJson; }
      if (params.lastGitHubCiSnapshotSettledAt !== undefined) { sets.push("last_github_ci_snapshot_settled_at = @lastGitHubCiSnapshotSettledAt"); values.lastGitHubCiSnapshotSettledAt = params.lastGitHubCiSnapshotSettledAt; }
      if (params.lastQueueSignalAt !== undefined) { sets.push("last_queue_signal_at = @lastQueueSignalAt"); values.lastQueueSignalAt = params.lastQueueSignalAt; }
      if (params.lastQueueIncidentJson !== undefined) { sets.push("last_queue_incident_json = @lastQueueIncidentJson"); values.lastQueueIncidentJson = params.lastQueueIncidentJson; }
      if (params.lastAttemptedFailureHeadSha !== undefined) { sets.push("last_attempted_failure_head_sha = @lastAttemptedFailureHeadSha"); values.lastAttemptedFailureHeadSha = params.lastAttemptedFailureHeadSha; }
      if (params.lastAttemptedFailureSignature !== undefined) { sets.push("last_attempted_failure_signature = @lastAttemptedFailureSignature"); values.lastAttemptedFailureSignature = params.lastAttemptedFailureSignature; }
      if (params.ciRepairAttempts !== undefined) { sets.push("ci_repair_attempts = @ciRepairAttempts"); values.ciRepairAttempts = params.ciRepairAttempts; }
      if (params.queueRepairAttempts !== undefined) { sets.push("queue_repair_attempts = @queueRepairAttempts"); values.queueRepairAttempts = params.queueRepairAttempts; }
      if (params.reviewFixAttempts !== undefined) { sets.push("review_fix_attempts = @reviewFixAttempts"); values.reviewFixAttempts = params.reviewFixAttempts; }
      if (params.zombieRecoveryAttempts !== undefined) { sets.push("zombie_recovery_attempts = @zombieRecoveryAttempts"); values.zombieRecoveryAttempts = params.zombieRecoveryAttempts; }
      if (params.lastZombieRecoveryAt !== undefined) { sets.push("last_zombie_recovery_at = @lastZombieRecoveryAt"); values.lastZombieRecoveryAt = params.lastZombieRecoveryAt; }
      this.connection.prepare(`UPDATE issues SET ${sets.join(", ")} WHERE project_id = @projectId AND linear_issue_id = @linearIssueId`).run(values);
    } else {
      this.connection.prepare(`
        INSERT INTO issues (
          project_id, linear_issue_id, delegated_to_patchrelay, issue_key, title, description, url,
          priority, estimate,
          current_linear_state, current_linear_state_type, factory_state, pending_run_type, pending_run_context_json,
          branch_name, worktree_path, thread_id, active_run_id, status_comment_id,
          agent_session_id, last_linear_activity_key,
          pr_number, pr_url, pr_state, pr_head_sha, pr_author_login, pr_review_state, pr_check_status, last_blocking_review_head_sha,
          last_github_failure_source, last_github_failure_head_sha, last_github_failure_signature, last_github_failure_check_name, last_github_failure_check_url, last_github_failure_context_json, last_github_failure_at,
          last_github_ci_snapshot_head_sha, last_github_ci_snapshot_gate_check_name, last_github_ci_snapshot_gate_check_status, last_github_ci_snapshot_json, last_github_ci_snapshot_settled_at,
          last_queue_signal_at, last_queue_incident_json,
          last_attempted_failure_head_sha, last_attempted_failure_signature,
          ci_repair_attempts, queue_repair_attempts, review_fix_attempts, zombie_recovery_attempts, last_zombie_recovery_at,
          updated_at
        ) VALUES (
          @projectId, @linearIssueId, @delegatedToPatchRelay, @issueKey, @title, @description, @url,
          @priority, @estimate,
          @currentLinearState, @currentLinearStateType, @factoryState, @pendingRunType, @pendingRunContextJson,
          @branchName, @worktreePath, @threadId, @activeRunId, @statusCommentId,
          @agentSessionId, @lastLinearActivityKey,
          @prNumber, @prUrl, @prState, @prHeadSha, @prAuthorLogin, @prReviewState, @prCheckStatus, @lastBlockingReviewHeadSha,
          @lastGitHubFailureSource, @lastGitHubFailureHeadSha, @lastGitHubFailureSignature, @lastGitHubFailureCheckName, @lastGitHubFailureCheckUrl, @lastGitHubFailureContextJson, @lastGitHubFailureAt,
          @lastGitHubCiSnapshotHeadSha, @lastGitHubCiSnapshotGateCheckName, @lastGitHubCiSnapshotGateCheckStatus, @lastGitHubCiSnapshotJson, @lastGitHubCiSnapshotSettledAt,
          @lastQueueSignalAt, @lastQueueIncidentJson,
          @lastAttemptedFailureHeadSha, @lastAttemptedFailureSignature,
          @ciRepairAttempts, @queueRepairAttempts, @reviewFixAttempts, @zombieRecoveryAttempts, @lastZombieRecoveryAt,
          @now
        )
      `).run({
        projectId: params.projectId,
        linearIssueId: params.linearIssueId,
        delegatedToPatchRelay: params.delegatedToPatchRelay === false ? 0 : 1,
        issueKey: params.issueKey ?? null,
        title: params.title ?? null,
        description: params.description ?? null,
        url: params.url ?? null,
        priority: params.priority ?? null,
        estimate: params.estimate ?? null,
        currentLinearState: params.currentLinearState ?? null,
        currentLinearStateType: params.currentLinearStateType ?? null,
        factoryState: params.factoryState ?? "delegated",
        pendingRunType: params.pendingRunType ?? null,
        pendingRunContextJson: params.pendingRunContextJson ?? null,
        branchName: params.branchName ?? null,
        worktreePath: params.worktreePath ?? null,
        threadId: params.threadId ?? null,
        activeRunId: params.activeRunId ?? null,
        statusCommentId: params.statusCommentId ?? null,
        agentSessionId: params.agentSessionId ?? null,
        lastLinearActivityKey: params.lastLinearActivityKey ?? null,
        prNumber: params.prNumber ?? null,
        prUrl: params.prUrl ?? null,
        prState: params.prState ?? null,
        prHeadSha: params.prHeadSha ?? null,
        prAuthorLogin: params.prAuthorLogin ?? null,
        prReviewState: params.prReviewState ?? null,
        prCheckStatus: params.prCheckStatus ?? null,
        lastBlockingReviewHeadSha: params.lastBlockingReviewHeadSha ?? null,
        lastGitHubFailureSource: params.lastGitHubFailureSource ?? null,
        lastGitHubFailureHeadSha: params.lastGitHubFailureHeadSha ?? null,
        lastGitHubFailureSignature: params.lastGitHubFailureSignature ?? null,
        lastGitHubFailureCheckName: params.lastGitHubFailureCheckName ?? null,
        lastGitHubFailureCheckUrl: params.lastGitHubFailureCheckUrl ?? null,
        lastGitHubFailureContextJson: params.lastGitHubFailureContextJson ?? null,
        lastGitHubFailureAt: params.lastGitHubFailureAt ?? null,
        lastGitHubCiSnapshotHeadSha: params.lastGitHubCiSnapshotHeadSha ?? null,
        lastGitHubCiSnapshotGateCheckName: params.lastGitHubCiSnapshotGateCheckName ?? null,
        lastGitHubCiSnapshotGateCheckStatus: params.lastGitHubCiSnapshotGateCheckStatus ?? null,
        lastGitHubCiSnapshotJson: params.lastGitHubCiSnapshotJson ?? null,
        lastGitHubCiSnapshotSettledAt: params.lastGitHubCiSnapshotSettledAt ?? null,
        lastQueueSignalAt: params.lastQueueSignalAt ?? null,
        lastQueueIncidentJson: params.lastQueueIncidentJson ?? null,
        lastAttemptedFailureHeadSha: params.lastAttemptedFailureHeadSha ?? null,
        lastAttemptedFailureSignature: params.lastAttemptedFailureSignature ?? null,
        ciRepairAttempts: params.ciRepairAttempts ?? 0,
        queueRepairAttempts: params.queueRepairAttempts ?? 0,
        reviewFixAttempts: params.reviewFixAttempts ?? 0,
        zombieRecoveryAttempts: params.zombieRecoveryAttempts ?? 0,
        lastZombieRecoveryAt: params.lastZombieRecoveryAt ?? null,
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
    ciRepairAttempts: Number(row.ci_repair_attempts ?? 0),
    queueRepairAttempts: Number(row.queue_repair_attempts ?? 0),
    reviewFixAttempts: Number(row.review_fix_attempts ?? 0),
    zombieRecoveryAttempts: Number(row.zombie_recovery_attempts ?? 0),
    ...(row.last_zombie_recovery_at !== null && row.last_zombie_recovery_at !== undefined ? { lastZombieRecoveryAt: String(row.last_zombie_recovery_at) } : {}),
  };
}
