import type {
  BranchOwner,
  GitHubCiSnapshotRecord,
  GitHubFailureSource,
  IssueDependencyRecord,
  IssueRecord,
  IssueSessionEventRecord,
  IssueSessionRecord,
  RunRecord,
  RunStatus,
  TrackedIssueRecord,
  ThreadEventRecord,
} from "./db-types.ts";
import type { FactoryState, RunType } from "./factory-state.ts";
import {
  isIssueSessionReadyForExecution,
  deriveIssueSessionState,
  deriveIssueSessionReactiveIntent,
  deriveIssueSessionWakeReason,
} from "./issue-session.ts";
import {
  extractLatestAssistantSummary,
  type IssueSessionEventType,
} from "./issue-session-events.ts";
import { IssueSessionStore } from "./db/issue-session-store.ts";
import { LinearInstallationStore } from "./db/linear-installation-store.ts";
import { OperatorFeedStore } from "./db/operator-feed-store.ts";
import { RepositoryLinkStore } from "./db/repository-link-store.ts";
import { RunStore } from "./db/run-store.ts";
import { WebhookEventStore } from "./db/webhook-event-store.ts";
import { runPatchRelayMigrations } from "./db/migrations.ts";
import { SqliteConnection, isoNow, type DatabaseConnection } from "./db/shared.ts";
import { buildTrackedIssueRecord } from "./tracked-issue-projector.ts";

function parseObjectJson(raw: string | undefined): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function hasUnattemptedFailureSignature(issue: IssueRecord, fallbackHeadSha?: string): boolean {
  const signature = issue.lastGitHubFailureSignature;
  if (!signature) return false;
  const headSha = issue.lastGitHubFailureHeadSha ?? fallbackHeadSha;
  return issue.lastAttemptedFailureSignature !== signature
    || (headSha !== undefined && issue.lastAttemptedFailureHeadSha !== headSha);
}

function deriveImplicitReactiveWake(issue: IssueRecord):
  | { runType: RunType; wakeReason: string; context: Record<string, unknown> }
  | undefined {
  const reactiveIntent = deriveIssueSessionReactiveIntent({
    activeRunId: issue.activeRunId,
    prNumber: issue.prNumber,
    prState: issue.prState,
    prReviewState: issue.prReviewState,
    prCheckStatus: issue.prCheckStatus,
    latestFailureSource: issue.lastGitHubFailureSource,
  });
  if (!reactiveIntent) return undefined;

  if (reactiveIntent.runType === "ci_repair") {
    const failureContext = parseObjectJson(issue.lastGitHubFailureContextJson) ?? {};
    const snapshot = parseObjectJson(issue.lastGitHubCiSnapshotJson);
    const fallbackHeadSha = typeof failureContext.failureHeadSha === "string"
      ? failureContext.failureHeadSha
      : issue.lastGitHubFailureHeadSha ?? issue.prHeadSha;
    const failureSignature = issue.lastGitHubFailureSignature
      ?? (fallbackHeadSha ? `implicit_branch_ci::${fallbackHeadSha}` : undefined);
    if (!failureSignature || issue.prState !== "open") return undefined;
    if (
      issue.lastAttemptedFailureSignature === failureSignature
      && (fallbackHeadSha === undefined || issue.lastAttemptedFailureHeadSha === fallbackHeadSha)
    ) {
      return undefined;
    }
    return {
      runType: reactiveIntent.runType,
      wakeReason: reactiveIntent.wakeReason,
      context: {
        ...failureContext,
        failureSignature,
        ...(fallbackHeadSha ? { failureHeadSha: fallbackHeadSha } : {}),
        ...(issue.lastGitHubFailureCheckName ? { checkName: issue.lastGitHubFailureCheckName } : {}),
        ...(snapshot ? { ciSnapshot: snapshot } : {}),
      },
    };
  }

  if (reactiveIntent.runType === "queue_repair") {
    const failureContext = parseObjectJson(issue.lastGitHubFailureContextJson) ?? {};
    const incidentContext = parseObjectJson(issue.lastQueueIncidentJson) ?? {};
    const fallbackHeadSha = typeof failureContext.failureHeadSha === "string"
      ? failureContext.failureHeadSha
      : undefined;
    if (!hasUnattemptedFailureSignature(issue, fallbackHeadSha)) return undefined;
    return {
      runType: reactiveIntent.runType,
      wakeReason: reactiveIntent.wakeReason,
      context: {
        ...incidentContext,
        ...failureContext,
      },
    };
  }

  return undefined;
}

export class PatchRelayDatabase {
  readonly connection: DatabaseConnection;
  readonly linearInstallations: LinearInstallationStore;
  readonly operatorFeed: OperatorFeedStore;
  readonly repositories: RepositoryLinkStore;
  readonly webhookEvents: WebhookEventStore;
  readonly issueSessions: IssueSessionStore;
  readonly runs: RunStore;

  constructor(databasePath: string, wal: boolean) {
    this.connection = new SqliteConnection(databasePath);
    this.connection.pragma("foreign_keys = ON");
    if (wal) {
      this.connection.pragma("journal_mode = WAL");
    }
    this.linearInstallations = new LinearInstallationStore(this.connection);
    this.operatorFeed = new OperatorFeedStore(this.connection);
    this.repositories = new RepositoryLinkStore(this.connection);
    this.webhookEvents = new WebhookEventStore(this.connection);
    this.issueSessions = new IssueSessionStore(
      this.connection,
      mapIssueSessionRow,
      mapIssueSessionEventRow,
      (projectId, linearIssueId) => this.getIssue(projectId, linearIssueId),
      deriveImplicitReactiveWake,
      <T>(fn: () => T) => this.transaction(fn),
      (params) => this.upsertIssue(params as Parameters<PatchRelayDatabase["upsertIssue"]>[0]),
      (runId, params) => this.finishRun(runId, params),
      (runId, params) => this.updateRunThread(runId, params),
      (projectId, linearIssueId, owner) => this.setBranchOwner(projectId, linearIssueId, owner),
    );
    this.runs = new RunStore(
      this.connection,
      mapRunRow,
      (id) => this.getRun(id),
      (projectId, linearIssueId) => this.getIssue(projectId, linearIssueId),
      (issue, options) => this.syncIssueSessionFromIssue(issue, options),
    );
  }

  runMigrations(): void {
    runPatchRelayMigrations(this.connection);
  }

  transaction<T>(fn: () => T): T {
    return this.connection.transaction(fn)();
  }

  // ─── Webhook Events ───────────────────────────────────────────────

  insertWebhookEvent(webhookId: string, receivedAt: string): { id: number; duplicate: boolean } {
    return this.webhookEvents.insertWebhookEvent(webhookId, receivedAt);
  }

  insertFullWebhookEvent(params: {
    webhookId: string;
    receivedAt: string;
    payloadJson: string;
  }): { id: number; dedupeStatus: string } {
    return this.webhookEvents.insertFullWebhookEvent(params);
  }

  getWebhookPayload(id: number): { webhookId: string; payloadJson: string } | undefined {
    return this.webhookEvents.getWebhookPayload(id);
  }

  isWebhookDuplicate(webhookId: string): boolean {
    return this.webhookEvents.isWebhookDuplicate(webhookId);
  }

  markWebhookProcessed(id: number, status: string): void {
    this.webhookEvents.markWebhookProcessed(id, status);
  }

  assignWebhookProject(id: number, projectId: string): void {
    this.webhookEvents.assignWebhookProject(id, projectId);
  }

  // ─── Issues ───────────────────────────────────────────────────────

  upsertIssue(params: {
    projectId: string;
    linearIssueId: string;
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
  }): IssueRecord {
    const now = isoNow();
    const existing = this.getIssue(params.projectId, params.linearIssueId);
    if (existing) {
      // Build dynamic SET clauses for nullable fields
      const sets: string[] = ["updated_at = @now"];
      const values: Record<string, unknown> = {
        now,
        projectId: params.projectId,
        linearIssueId: params.linearIssueId,
      };
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
          project_id, linear_issue_id, issue_key, title, description, url,
          priority, estimate,
          current_linear_state, current_linear_state_type, factory_state, pending_run_type, pending_run_context_json,
          branch_name, worktree_path, thread_id, active_run_id, status_comment_id,
          agent_session_id,
          pr_number, pr_url, pr_state, pr_head_sha, pr_author_login, pr_review_state, pr_check_status, last_blocking_review_head_sha,
          last_github_failure_source, last_github_failure_head_sha, last_github_failure_signature, last_github_failure_check_name, last_github_failure_check_url, last_github_failure_context_json, last_github_failure_at,
          last_github_ci_snapshot_head_sha, last_github_ci_snapshot_gate_check_name, last_github_ci_snapshot_gate_check_status, last_github_ci_snapshot_json, last_github_ci_snapshot_settled_at,
          last_queue_signal_at, last_queue_incident_json,
          last_attempted_failure_head_sha, last_attempted_failure_signature,
          ci_repair_attempts, queue_repair_attempts, review_fix_attempts, zombie_recovery_attempts, last_zombie_recovery_at,
          updated_at
        ) VALUES (
          @projectId, @linearIssueId, @issueKey, @title, @description, @url,
          @priority, @estimate,
          @currentLinearState, @currentLinearStateType, @factoryState, @pendingRunType, @pendingRunContextJson,
          @branchName, @worktreePath, @threadId, @activeRunId, @statusCommentId,
          @agentSessionId,
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

  getIssueSession(projectId: string, linearIssueId: string): IssueSessionRecord | undefined {
    return this.issueSessions.getIssueSession(projectId, linearIssueId);
  }

  getIssueSessionByKey(issueKey: string): IssueSessionRecord | undefined {
    return this.issueSessions.getIssueSessionByKey(issueKey);
  }

  appendIssueSessionEvent(params: {
    projectId: string;
    linearIssueId: string;
    eventType: IssueSessionEventType;
    eventJson?: string | undefined;
    dedupeKey?: string | undefined;
  }): IssueSessionEventRecord {
    return this.issueSessions.appendIssueSessionEvent(params);
  }

  appendIssueSessionEventWithLease(
    lease: { projectId: string; linearIssueId: string; leaseId: string },
    params: Parameters<PatchRelayDatabase["appendIssueSessionEvent"]>[0],
  ): IssueSessionEventRecord | undefined {
    return this.issueSessions.appendIssueSessionEventWithLease(lease, params);
  }

  appendIssueSessionEventRespectingActiveLease(
    projectId: string,
    linearIssueId: string,
    params: Parameters<PatchRelayDatabase["appendIssueSessionEvent"]>[0],
  ): IssueSessionEventRecord | undefined {
    return this.issueSessions.appendIssueSessionEventRespectingActiveLease(projectId, linearIssueId, params);
  }

  getIssueSessionEvent(id: number): IssueSessionEventRecord | undefined {
    return this.issueSessions.getIssueSessionEvent(id);
  }

  listIssueSessionEvents(
    projectId: string,
    linearIssueId: string,
    options?: { pendingOnly?: boolean; limit?: number },
  ): IssueSessionEventRecord[] {
    return this.issueSessions.listIssueSessionEvents(projectId, linearIssueId, options);
  }

  consumeIssueSessionEvents(projectId: string, linearIssueId: string, eventIds: number[], runId: number): void {
    this.issueSessions.consumeIssueSessionEvents(projectId, linearIssueId, eventIds, runId);
  }

  clearPendingIssueSessionEvents(projectId: string, linearIssueId: string): void {
    this.issueSessions.clearPendingIssueSessionEvents(projectId, linearIssueId);
  }

  hasPendingIssueSessionEvents(projectId: string, linearIssueId: string): boolean {
    return this.issueSessions.hasPendingIssueSessionEvents(projectId, linearIssueId);
  }

  peekIssueSessionWake(projectId: string, linearIssueId: string): {
    eventIds: number[];
    runType: RunType;
    context: Record<string, unknown>;
    wakeReason?: string | undefined;
    resumeThread: boolean;
  } | undefined {
    return this.issueSessions.peekIssueSessionWake(projectId, linearIssueId);
  }

  acquireIssueSessionLease(params: {
    projectId: string;
    linearIssueId: string;
    leaseId: string;
    workerId: string;
    leasedUntil: string;
    now?: string;
  }): boolean {
    return this.issueSessions.acquireIssueSessionLease(params);
  }

  forceAcquireIssueSessionLease(params: {
    projectId: string;
    linearIssueId: string;
    leaseId: string;
    workerId: string;
    leasedUntil: string;
    now?: string;
  }): boolean {
    return this.issueSessions.forceAcquireIssueSessionLease(params);
  }

  renewIssueSessionLease(params: {
    projectId: string;
    linearIssueId: string;
    leaseId: string;
    leasedUntil: string;
    now?: string;
  }): boolean {
    return this.issueSessions.renewIssueSessionLease(params);
  }

  releaseIssueSessionLease(projectId: string, linearIssueId: string, leaseId?: string): void {
    this.issueSessions.releaseIssueSessionLease(projectId, linearIssueId, leaseId);
  }

  releaseExpiredIssueSessionLeases(now = isoNow()): void {
    this.issueSessions.releaseExpiredIssueSessionLeases(now);
  }

  hasActiveIssueSessionLease(projectId: string, linearIssueId: string, leaseId: string, now = isoNow()): boolean {
    return this.issueSessions.hasActiveIssueSessionLease(projectId, linearIssueId, leaseId, now);
  }

  getActiveIssueSessionLease(
    projectId: string,
    linearIssueId: string,
    now = isoNow(),
  ): { projectId: string; linearIssueId: string; leaseId: string } | undefined {
    return this.issueSessions.getActiveIssueSessionLease(projectId, linearIssueId, now);
  }

  withIssueSessionLease<T>(
    projectId: string,
    linearIssueId: string,
    leaseId: string,
    fn: () => T,
  ): T | undefined {
    return this.issueSessions.withIssueSessionLease(projectId, linearIssueId, leaseId, fn);
  }

  upsertIssueWithLease(
    lease: { projectId: string; linearIssueId: string; leaseId: string },
    params: Parameters<PatchRelayDatabase["upsertIssue"]>[0],
  ): IssueRecord | undefined {
    return this.issueSessions.upsertIssueWithLease(lease, params);
  }

  upsertIssueRespectingActiveLease(
    projectId: string,
    linearIssueId: string,
    params: Parameters<PatchRelayDatabase["upsertIssue"]>[0],
  ): IssueRecord | undefined {
    return this.issueSessions.upsertIssueRespectingActiveLease(projectId, linearIssueId, params);
  }

  finishRunWithLease(
    lease: { projectId: string; linearIssueId: string; leaseId: string },
    runId: number,
    params: Parameters<PatchRelayDatabase["finishRun"]>[1],
  ): boolean {
    return this.issueSessions.finishRunWithLease(lease, runId, params);
  }

  finishRunRespectingActiveLease(
    projectId: string,
    linearIssueId: string,
    runId: number,
    params: Parameters<PatchRelayDatabase["finishRun"]>[1],
  ): boolean {
    return this.issueSessions.finishRunRespectingActiveLease(projectId, linearIssueId, runId, params);
  }

  updateRunThreadWithLease(
    lease: { projectId: string; linearIssueId: string; leaseId: string },
    runId: number,
    params: Parameters<PatchRelayDatabase["updateRunThread"]>[1],
  ): boolean {
    return this.issueSessions.updateRunThreadWithLease(lease, runId, params);
  }

  consumeIssueSessionEventsWithLease(
    lease: { projectId: string; linearIssueId: string; leaseId: string },
    eventIds: number[],
    runId: number,
  ): boolean {
    return this.issueSessions.consumeIssueSessionEventsWithLease(lease, eventIds, runId);
  }

  clearPendingIssueSessionEventsWithLease(
    lease: { projectId: string; linearIssueId: string; leaseId: string },
  ): boolean {
    return this.issueSessions.clearPendingIssueSessionEventsWithLease(lease);
  }

  clearPendingIssueSessionEventsRespectingActiveLease(projectId: string, linearIssueId: string): boolean {
    return this.issueSessions.clearPendingIssueSessionEventsRespectingActiveLease(projectId, linearIssueId);
  }

  setIssueSessionLastWakeReasonWithLease(
    lease: { projectId: string; linearIssueId: string; leaseId: string },
    lastWakeReason?: string | null,
  ): boolean {
    return this.issueSessions.setIssueSessionLastWakeReasonWithLease(lease, lastWakeReason);
  }

  setIssueSessionLastWakeReason(projectId: string, linearIssueId: string, lastWakeReason?: string | null): void {
    this.issueSessions.setIssueSessionLastWakeReason(projectId, linearIssueId, lastWakeReason);
  }

  setBranchOwner(projectId: string, linearIssueId: string, owner: BranchOwner): void {
    this.connection.prepare(`
      UPDATE issues
      SET branch_owner = ?, branch_ownership_changed_at = ?, updated_at = ?
      WHERE project_id = ? AND linear_issue_id = ?
    `).run(owner, isoNow(), isoNow(), projectId, linearIssueId);
  }

  setBranchOwnerWithLease(
    lease: { projectId: string; linearIssueId: string; leaseId: string },
    owner: BranchOwner,
  ): boolean {
    return this.issueSessions.setBranchOwnerWithLease(lease, owner);
  }

  setBranchOwnerRespectingActiveLease(projectId: string, linearIssueId: string, owner: BranchOwner): boolean {
    return this.issueSessions.setBranchOwnerRespectingActiveLease(projectId, linearIssueId, owner);
  }

  releaseIssueSessionLeaseRespectingActiveLease(projectId: string, linearIssueId: string): void {
    this.issueSessions.releaseIssueSessionLeaseRespectingActiveLease(projectId, linearIssueId);
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

  getLatestGitHubCiSnapshot(projectId: string, linearIssueId: string): GitHubCiSnapshotRecord | undefined {
    const issue = this.getIssue(projectId, linearIssueId);
    if (!issue?.lastGitHubCiSnapshotJson) return undefined;
    try {
      return JSON.parse(issue.lastGitHubCiSnapshotJson) as GitHubCiSnapshotRecord;
    } catch {
      return undefined;
    }
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

  listIssuesReadyForExecution(): Array<{ projectId: string; linearIssueId: string }> {
    return this.listIssues()
      .filter((issue) => isIssueSessionReadyForExecution({
        factoryState: issue.factoryState,
        sessionState: deriveIssueSessionState({
          activeRunId: issue.activeRunId,
          factoryState: issue.factoryState,
        }),
        activeRunId: issue.activeRunId,
        blockedByCount: this.countUnresolvedBlockers(issue.projectId, issue.linearIssueId),
        hasPendingWake: this.peekIssueSessionWake(issue.projectId, issue.linearIssueId) !== undefined,
        hasLegacyPendingRun: issue.pendingRunType !== undefined,
        prNumber: issue.prNumber,
        prState: issue.prState,
        prReviewState: issue.prReviewState,
        prCheckStatus: issue.prCheckStatus,
        latestFailureSource: issue.lastGitHubFailureSource,
      }))
      .map((issue) => ({
        projectId: issue.projectId,
        linearIssueId: issue.linearIssueId,
      }));
  }

  /**
   * Issues idle in pr_open with no active run — candidates for state
   * advancement based on stored PR metadata (missed GitHub webhooks).
   */
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

  /**
   * Issues in delegated state with dependencies but no pending/active run.
   * Candidates for unblocking when their blockers complete.
   */
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

  /**
   * Issues waiting in the merge queue with no active or pending run.
   * Used by the queue health monitor to probe GitHub for stuck PRs.
   */
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

  listIssuesByState(projectId: string, state: FactoryState): IssueRecord[] {
    const rows = this.connection
      .prepare("SELECT * FROM issues WHERE project_id = ? AND factory_state = ? ORDER BY pr_number ASC")
      .all(projectId, state) as Array<Record<string, unknown>>;
    return rows.map(mapIssueRow);
  }

  // ─── Runs ─────────────────────────────────────────────────────────

  createRun(params: {
    issueId: number;
    projectId: string;
    linearIssueId: string;
    runType: RunType;
    sourceHeadSha?: string;
    promptText?: string;
  }): RunRecord {
    return this.runs.createRun(params);
  }

  getRun(id: number): RunRecord | undefined {
    return this.runs.getRunById(id);
  }

  getRunByThreadId(threadId: string): RunRecord | undefined {
    return this.runs.getRunByThreadId(threadId);
  }

  listRunsForIssue(projectId: string, linearIssueId: string): RunRecord[] {
    return this.runs.listRunsForIssue(projectId, linearIssueId);
  }

  getLatestRunForIssue(projectId: string, linearIssueId: string): RunRecord | undefined {
    return this.runs.getLatestRunForIssue(projectId, linearIssueId);
  }

  listActiveRuns(): RunRecord[] {
    return this.runs.listActiveRuns();
  }

  listRunningRuns(): RunRecord[] {
    return this.runs.listRunningRuns();
  }

  updateRunThread(runId: number, params: { threadId: string; parentThreadId?: string; turnId?: string }): void {
    this.runs.updateRunThread(runId, params);
  }

  updateRunTurnId(runId: number, turnId: string): void {
    this.runs.updateRunTurnId(runId, turnId);
  }

  finishRun(runId: number, params: {
    status: RunStatus;
    threadId?: string;
    turnId?: string;
    failureReason?: string;
    summaryJson?: string;
    reportJson?: string;
  }): void {
    this.runs.finishRun(runId, params);
  }

  // ─── Thread Events (kept for extended history) ────────────────────

  saveThreadEvent(params: {
    runId: number;
    threadId: string;
    turnId?: string;
    method: string;
    eventJson: string;
  }): void {
    this.runs.saveThreadEvent(params);
  }

  listThreadEvents(runId: number): ThreadEventRecord[] {
    return this.runs.listThreadEvents(runId);
  }

  // ─── View builders ──────────────────────────────────────────────

  issueToTrackedIssue(issue: IssueRecord): TrackedIssueRecord {
    return buildTrackedIssueRecord({
      issue,
      session: this.getIssueSession(issue.projectId, issue.linearIssueId),
      blockedBy: this.listIssueDependencies(issue.projectId, issue.linearIssueId),
      hasPendingWake: this.peekIssueSessionWake(issue.projectId, issue.linearIssueId) !== undefined,
      latestRun: this.getLatestRunForIssue(issue.projectId, issue.linearIssueId),
      latestEvent: this.listIssueSessionEvents(issue.projectId, issue.linearIssueId, { limit: 1 }).at(-1),
    });
  }

  getTrackedIssue(projectId: string, linearIssueId: string): TrackedIssueRecord | undefined {
    const issue = this.getIssue(projectId, linearIssueId);
    return issue ? this.issueToTrackedIssue(issue) : undefined;
  }

  getTrackedIssueByKey(issueKey: string): TrackedIssueRecord | undefined {
    const issue = this.getIssueByKey(issueKey);
    return issue ? this.issueToTrackedIssue(issue) : undefined;
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

  findLatestAgentSessionIdForIssue(linearIssueId: string): string | undefined {
    const row = this.connection.prepare(`
      SELECT COALESCE(
        json_extract(payload_json, '$.agentSession.id'),
        json_extract(payload_json, '$.data.agentSession.id'),
        json_extract(payload_json, '$.agentSessionId'),
        json_extract(payload_json, '$.data.agentSessionId')
      ) AS agent_session_id
      FROM webhook_events
      WHERE COALESCE(
        json_extract(payload_json, '$.agentSession.issueId'),
        json_extract(payload_json, '$.data.agentSession.issueId'),
        json_extract(payload_json, '$.agentSession.issue.id'),
        json_extract(payload_json, '$.data.agentSession.issue.id')
      ) = ?
        AND COALESCE(
          json_extract(payload_json, '$.agentSession.id'),
          json_extract(payload_json, '$.data.agentSession.id'),
          json_extract(payload_json, '$.agentSessionId'),
          json_extract(payload_json, '$.data.agentSessionId')
        ) IS NOT NULL
      ORDER BY id DESC
      LIMIT 1
    `).get(linearIssueId) as Record<string, unknown> | undefined;

    return row?.agent_session_id != null ? String(row.agent_session_id) : undefined;
  }

  // ─── Issue overview for query service ─────────────────────────────

  getIssueOverview(issueKey: string): {
    issue: TrackedIssueRecord;
    activeRun?: RunRecord;
  } | undefined {
    const issue = this.getIssueByKey(issueKey);
    if (!issue) return undefined;
    const tracked = this.issueToTrackedIssue(issue);
    const activeRun = issue.activeRunId ? this.getRun(issue.activeRunId) : undefined;
    return {
      issue: tracked,
      ...(activeRun ? { activeRun } : {}),
    };
  }

  private syncIssueSessionFromIssue(
    issue: IssueRecord,
    options?: {
      summaryText?: string | undefined;
      lastRunType?: RunType | undefined;
      lastWakeReason?: string | undefined;
    },
  ): void {
    const tracked = this.issueToTrackedIssue(issue);
    const existing = this.getIssueSession(issue.projectId, issue.linearIssueId);
    const latestRun = this.getLatestRunForIssue(issue.projectId, issue.linearIssueId);
    const latestRunType = options?.lastRunType ?? latestRun?.runType ?? existing?.lastRunType;
    const summaryText = this.resolveIssueSessionSummary(issue, latestRun, existing?.summaryText, options?.summaryText);
    const activeThreadId = issue.threadId ?? existing?.activeThreadId;
    const threadGeneration = activeThreadId && activeThreadId !== existing?.activeThreadId
      ? (existing?.threadGeneration ?? 0) + 1
      : (existing?.threadGeneration ?? (activeThreadId ? 1 : 0));
    const sessionState = deriveIssueSessionState({
      ...(issue.activeRunId !== undefined ? { activeRunId: issue.activeRunId } : {}),
      factoryState: issue.factoryState,
    });
    const lastWakeReason = options?.lastWakeReason
      ?? deriveIssueSessionWakeReason({
        pendingRunType: issue.pendingRunType,
        factoryState: issue.factoryState,
        prNumber: issue.prNumber,
        prState: issue.prState,
        prReviewState: issue.prReviewState,
        prCheckStatus: issue.prCheckStatus,
        latestFailureSource: issue.lastGitHubFailureSource,
      })
      ?? existing?.lastWakeReason;
    const now = isoNow();

    if (existing) {
      this.connection.prepare(`
        UPDATE issue_sessions SET
          issue_key = ?,
          repo_id = ?,
          branch_name = ?,
          worktree_path = ?,
          pr_number = ?,
          pr_head_sha = ?,
          pr_author_login = ?,
          session_state = ?,
          waiting_reason = ?,
          summary_text = ?,
          active_thread_id = ?,
          thread_generation = ?,
          active_run_id = ?,
          last_run_type = ?,
          last_wake_reason = ?,
          ci_repair_attempts = ?,
          queue_repair_attempts = ?,
          review_fix_attempts = ?,
          updated_at = ?
        WHERE project_id = ? AND linear_issue_id = ?
      `).run(
        issue.issueKey ?? null,
        issue.projectId,
        issue.branchName ?? null,
        issue.worktreePath ?? null,
        issue.prNumber ?? null,
        issue.prHeadSha ?? null,
        issue.prAuthorLogin ?? null,
        sessionState,
        tracked.waitingReason ?? null,
        summaryText ?? null,
        activeThreadId ?? null,
        threadGeneration,
        issue.activeRunId ?? null,
        latestRunType ?? null,
        lastWakeReason ?? null,
        issue.ciRepairAttempts,
        issue.queueRepairAttempts,
        issue.reviewFixAttempts,
        now,
        issue.projectId,
        issue.linearIssueId,
      );
      return;
    }

    this.connection.prepare(`
      INSERT INTO issue_sessions (
        project_id, linear_issue_id, issue_key, repo_id, branch_name, worktree_path,
        pr_number, pr_head_sha, pr_author_login, session_state, waiting_reason, summary_text,
        active_thread_id, thread_generation, active_run_id, last_run_type, last_wake_reason,
        ci_repair_attempts, queue_repair_attempts, review_fix_attempts,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      issue.projectId,
      issue.linearIssueId,
      issue.issueKey ?? null,
      issue.projectId,
      issue.branchName ?? null,
      issue.worktreePath ?? null,
      issue.prNumber ?? null,
      issue.prHeadSha ?? null,
      issue.prAuthorLogin ?? null,
      sessionState,
      tracked.waitingReason ?? null,
      summaryText ?? null,
      activeThreadId ?? null,
      threadGeneration,
      issue.activeRunId ?? null,
      latestRunType ?? null,
      lastWakeReason ?? null,
      issue.ciRepairAttempts,
      issue.queueRepairAttempts,
      issue.reviewFixAttempts,
      now,
      now,
    );
  }

  private resolveIssueSessionSummary(
    issue: IssueRecord,
    latestRun: RunRecord | undefined,
    existingSummaryText: string | undefined,
    explicitSummaryText: string | undefined,
  ): string | undefined {
    if (explicitSummaryText?.trim()) {
      return explicitSummaryText;
    }

    const latestSummary = extractLatestAssistantSummary(latestRun);
    if (latestRun && (latestRun.status === "queued" || latestRun.status === "running")) {
      return latestSummary;
    }
    if (this.shouldKeepPreviousIssueSummary(issue, latestRun)) {
      return this.findLatestCompletedRunSummary(issue.projectId, issue.linearIssueId)
        ?? existingSummaryText
        ?? latestSummary;
    }

    return latestSummary ?? existingSummaryText;
  }

  private shouldKeepPreviousIssueSummary(issue: IssueRecord, latestRun: RunRecord | undefined): boolean {
    if (!latestRun || latestRun.status !== "failed") {
      return false;
    }
    if (latestRun.summaryJson || latestRun.reportJson) {
      return false;
    }
    return issue.factoryState === "pr_open"
      || issue.factoryState === "awaiting_queue"
      || issue.factoryState === "done";
  }

  private findLatestCompletedRunSummary(projectId: string, linearIssueId: string): string | undefined {
    const runs = this.listRunsForIssue(projectId, linearIssueId);
    for (let index = runs.length - 1; index >= 0; index -= 1) {
      const run = runs[index];
      if (!run || run.status !== "completed") {
        continue;
      }
      const summary = extractLatestAssistantSummary(run);
      if (summary?.trim()) {
        return summary;
      }
    }
    return undefined;
  }
}

// ─── Row mappers ──────────────────────────────────────────────────

function mapIssueRow(row: Record<string, unknown>): IssueRecord {
  return {
    id: Number(row.id),
    projectId: String(row.project_id),
    linearIssueId: String(row.linear_issue_id),
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
    ...(row.branch_owner !== null && row.branch_owner !== undefined && String(row.branch_owner) === "patchrelay"
      ? { branchOwner: "patchrelay" as BranchOwner }
      : { branchOwner: "patchrelay" as BranchOwner }),
    ...(row.branch_ownership_changed_at !== null && row.branch_ownership_changed_at !== undefined
      ? { branchOwnershipChangedAt: String(row.branch_ownership_changed_at) }
      : {}),
    ...(row.worktree_path !== null ? { worktreePath: String(row.worktree_path) } : {}),
    ...(row.thread_id !== null ? { threadId: String(row.thread_id) } : {}),
    ...(row.active_run_id !== null ? { activeRunId: Number(row.active_run_id) } : {}),
    ...(row.status_comment_id !== null && row.status_comment_id !== undefined ? { statusCommentId: String(row.status_comment_id) } : {}),
    ...(row.agent_session_id !== null ? { agentSessionId: String(row.agent_session_id) } : {}),
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

function mapIssueSessionRow(row: Record<string, unknown>): IssueSessionRecord {
  return {
    id: Number(row.id),
    projectId: String(row.project_id),
    linearIssueId: String(row.linear_issue_id),
    ...(row.issue_key !== null && row.issue_key !== undefined ? { issueKey: String(row.issue_key) } : {}),
    repoId: String(row.repo_id),
    ...(row.branch_name !== null && row.branch_name !== undefined ? { branchName: String(row.branch_name) } : {}),
    ...(row.worktree_path !== null && row.worktree_path !== undefined ? { worktreePath: String(row.worktree_path) } : {}),
    ...(row.pr_number !== null && row.pr_number !== undefined ? { prNumber: Number(row.pr_number) } : {}),
    ...(row.pr_head_sha !== null && row.pr_head_sha !== undefined ? { prHeadSha: String(row.pr_head_sha) } : {}),
    ...(row.pr_author_login !== null && row.pr_author_login !== undefined ? { prAuthorLogin: String(row.pr_author_login) } : {}),
    sessionState: String(row.session_state) as IssueSessionRecord["sessionState"],
    ...(row.waiting_reason !== null && row.waiting_reason !== undefined ? { waitingReason: String(row.waiting_reason) } : {}),
    ...(row.summary_text !== null && row.summary_text !== undefined ? { summaryText: String(row.summary_text) } : {}),
    ...(row.active_thread_id !== null && row.active_thread_id !== undefined ? { activeThreadId: String(row.active_thread_id) } : {}),
    threadGeneration: Number(row.thread_generation ?? 0),
    ...(row.active_run_id !== null && row.active_run_id !== undefined ? { activeRunId: Number(row.active_run_id) } : {}),
    ...(row.last_run_type !== null && row.last_run_type !== undefined ? { lastRunType: String(row.last_run_type) as RunType } : {}),
    ...(row.last_wake_reason !== null && row.last_wake_reason !== undefined ? { lastWakeReason: String(row.last_wake_reason) } : {}),
    ciRepairAttempts: Number(row.ci_repair_attempts ?? 0),
    queueRepairAttempts: Number(row.queue_repair_attempts ?? 0),
    reviewFixAttempts: Number(row.review_fix_attempts ?? 0),
    ...(row.lease_id !== null && row.lease_id !== undefined ? { leaseId: String(row.lease_id) } : {}),
    ...(row.worker_id !== null && row.worker_id !== undefined ? { workerId: String(row.worker_id) } : {}),
    ...(row.leased_until !== null && row.leased_until !== undefined ? { leasedUntil: String(row.leased_until) } : {}),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapIssueSessionEventRow(row: Record<string, unknown>): IssueSessionEventRecord {
  return {
    id: Number(row.id),
    projectId: String(row.project_id),
    linearIssueId: String(row.linear_issue_id),
    eventType: String(row.event_type) as IssueSessionEventType,
    ...(row.event_json !== null && row.event_json !== undefined ? { eventJson: String(row.event_json) } : {}),
    ...(row.dedupe_key !== null && row.dedupe_key !== undefined ? { dedupeKey: String(row.dedupe_key) } : {}),
    createdAt: String(row.created_at),
    ...(row.processed_at !== null && row.processed_at !== undefined ? { processedAt: String(row.processed_at) } : {}),
    ...(row.consumed_by_run_id !== null && row.consumed_by_run_id !== undefined ? { consumedByRunId: Number(row.consumed_by_run_id) } : {}),
  };
}

function mapRunRow(row: Record<string, unknown>): RunRecord {
  return {
    id: Number(row.id),
    issueId: Number(row.issue_id),
    projectId: String(row.project_id),
    linearIssueId: String(row.linear_issue_id),
    runType: String(row.run_type ?? "implementation") as RunType,
    status: String(row.status) as RunStatus,
    ...(row.source_head_sha !== null ? { sourceHeadSha: String(row.source_head_sha) } : {}),
    ...(row.prompt_text !== null ? { promptText: String(row.prompt_text) } : {}),
    ...(row.thread_id !== null ? { threadId: String(row.thread_id) } : {}),
    ...(row.turn_id !== null ? { turnId: String(row.turn_id) } : {}),
    ...(row.parent_thread_id !== null ? { parentThreadId: String(row.parent_thread_id) } : {}),
    ...(row.summary_json !== null ? { summaryJson: String(row.summary_json) } : {}),
    ...(row.report_json !== null ? { reportJson: String(row.report_json) } : {}),
    ...(row.failure_reason !== null ? { failureReason: String(row.failure_reason) } : {}),
    startedAt: String(row.started_at),
    ...(row.ended_at !== null ? { endedAt: String(row.ended_at) } : {}),
  };
}
