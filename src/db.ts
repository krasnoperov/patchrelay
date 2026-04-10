import type {
  GitHubCiSnapshotRecord,
  IssueRecord,
  IssueSessionEventRecord,
  IssueSessionRecord,
  RunRecord,
  RunStatus,
} from "./db-types.ts";
import type { FactoryState, RunType } from "./factory-state.ts";
import {
  deriveIssueSessionReactiveIntent,
} from "./issue-session.ts";
import {
  type IssueSessionEventType,
} from "./issue-session-events.ts";
import { IssueStore, type UpsertIssueParams } from "./db/issue-store.ts";
import { IssueSessionStore } from "./db/issue-session-store.ts";
import { LinearInstallationStore } from "./db/linear-installation-store.ts";
import { OperatorFeedStore } from "./db/operator-feed-store.ts";
import { RepositoryLinkStore } from "./db/repository-link-store.ts";
import { RunStore } from "./db/run-store.ts";
import { WebhookEventStore } from "./db/webhook-event-store.ts";
import { runPatchRelayMigrations } from "./db/migrations.ts";
import { SqliteConnection, type DatabaseConnection } from "./db/shared.ts";
import { syncIssueSessionFromIssue } from "./issue-session-projector.ts";
import { TrackedIssueQuery } from "./tracked-issue-query.ts";

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
    delegatedToPatchRelay: issue.delegatedToPatchRelay,
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
  readonly issues: IssueStore;
  readonly issueSessions: IssueSessionStore;
  readonly runs: RunStore;
  readonly trackedIssues: TrackedIssueQuery;

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
    this.issues = new IssueStore(
      this.connection,
      (issue) => syncIssueSessionFromIssue({ connection: this.connection, issues: this.issues, issueSessions: this.issueSessions, runs: this.runs, issue }),
    );
    this.runs = new RunStore(
      this.connection,
      mapRunRow,
      this.issues,
      (issue, options) => syncIssueSessionFromIssue({
        connection: this.connection,
        issues: this.issues,
        issueSessions: this.issueSessions,
        runs: this.runs,
        issue,
        ...(options ? { options } : {}),
      }),
    );
    this.issueSessions = new IssueSessionStore(
      this.connection,
      mapIssueSessionRow,
      mapIssueSessionEventRow,
      this.issues,
      this.runs,
      deriveImplicitReactiveWake,
    );
    this.trackedIssues = new TrackedIssueQuery(this.issues, this.issueSessions, this.runs);
  }

  runMigrations(): void {
    runPatchRelayMigrations(this.connection);
  }

  transaction<T>(fn: () => T): T {
    return this.connection.transaction(fn)();
  }

  upsertIssue(params: UpsertIssueParams): IssueRecord {
    return this.issues.upsertIssue(params);
  }

  getIssue(projectId: string, linearIssueId: string): IssueRecord | undefined {
    return this.issues.getIssue(projectId, linearIssueId);
  }

  getIssueById(id: number): IssueRecord | undefined {
    return this.issues.getIssueById(id);
  }

  getIssueByKey(issueKey: string): IssueRecord | undefined {
    return this.issues.getIssueByKey(issueKey);
  }

  getIssueByBranch(branchName: string): IssueRecord | undefined {
    return this.issues.getIssueByBranch(branchName);
  }

  getIssueByPrNumber(prNumber: number): IssueRecord | undefined {
    return this.issues.getIssueByPrNumber(prNumber);
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
    this.issues.replaceIssueDependencies(params);
  }

  listIssueDependencies(projectId: string, linearIssueId: string) {
    return this.issues.listIssueDependencies(projectId, linearIssueId);
  }

  listDependents(projectId: string, blockerLinearIssueId: string): Array<{ projectId: string; linearIssueId: string }> {
    return this.issues.listDependents(projectId, blockerLinearIssueId);
  }

  getLatestGitHubCiSnapshot(projectId: string, linearIssueId: string): GitHubCiSnapshotRecord | undefined {
    return this.issues.getLatestGitHubCiSnapshot(projectId, linearIssueId);
  }

  countUnresolvedBlockers(projectId: string, linearIssueId: string): number {
    return this.issues.countUnresolvedBlockers(projectId, linearIssueId);
  }

  listIssuesReadyForExecution(): Array<{ projectId: string; linearIssueId: string }> {
    return this.trackedIssues.listIssuesReadyForExecution();
  }

  /**
   * Issues idle in pr_open with no active run — candidates for state
   * advancement based on stored PR metadata (missed GitHub webhooks).
   */
  listIdleNonTerminalIssues(): IssueRecord[] {
    return this.issues.listIdleNonTerminalIssues();
  }

  /**
   * Issues in delegated state with dependencies but no pending/active run.
   * Candidates for unblocking when their blockers complete.
   */
  listBlockedDelegatedIssues(): IssueRecord[] {
    return this.issues.listBlockedDelegatedIssues();
  }

  /**
   * Issues waiting in the merge queue with no active or pending run.
   * Used by the queue health monitor to probe GitHub for stuck PRs.
   */
  listAwaitingQueueIssues(): IssueRecord[] {
    return this.issues.listAwaitingQueueIssues();
  }

  listIssuesByState(projectId: string, state: FactoryState): IssueRecord[] {
    return this.trackedIssues.listIssuesByState(projectId, state);
  }

  // ─── View builders ──────────────────────────────────────────────

  issueToTrackedIssue(issue: IssueRecord) {
    return this.trackedIssues.issueToTrackedIssue(issue);
  }

  getTrackedIssue(projectId: string, linearIssueId: string) {
    return this.trackedIssues.getTrackedIssue(projectId, linearIssueId);
  }

  getTrackedIssueByKey(issueKey: string) {
    return this.trackedIssues.getTrackedIssueByKey(issueKey);
  }

  listIssues(): IssueRecord[] {
    return this.issues.listIssues();
  }

  listIssuesWithAgentSessions(): IssueRecord[] {
    return this.issues.listIssuesWithAgentSessions();
  }

  // ─── Issue overview for query service ─────────────────────────────

  getIssueOverview(issueKey: string) {
    return this.trackedIssues.getIssueOverview(issueKey);
  }
}

// ─── Row mappers ──────────────────────────────────────────────────

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
    ...(row.completion_check_thread_id !== null ? { completionCheckThreadId: String(row.completion_check_thread_id) } : {}),
    ...(row.completion_check_turn_id !== null ? { completionCheckTurnId: String(row.completion_check_turn_id) } : {}),
    ...(row.completion_check_outcome !== null ? { completionCheckOutcome: String(row.completion_check_outcome) as RunRecord["completionCheckOutcome"] } : {}),
    ...(row.completion_check_summary !== null ? { completionCheckSummary: String(row.completion_check_summary) } : {}),
    ...(row.completion_check_question !== null ? { completionCheckQuestion: String(row.completion_check_question) } : {}),
    ...(row.completion_check_why !== null ? { completionCheckWhy: String(row.completion_check_why) } : {}),
    ...(row.completion_check_recommended_reply !== null ? { completionCheckRecommendedReply: String(row.completion_check_recommended_reply) } : {}),
    ...(row.completion_checked_at !== null ? { completionCheckedAt: String(row.completion_checked_at) } : {}),
    ...(row.summary_json !== null ? { summaryJson: String(row.summary_json) } : {}),
    ...(row.report_json !== null ? { reportJson: String(row.report_json) } : {}),
    ...(row.failure_reason !== null ? { failureReason: String(row.failure_reason) } : {}),
    startedAt: String(row.started_at),
    ...(row.ended_at !== null ? { endedAt: String(row.ended_at) } : {}),
  };
}
