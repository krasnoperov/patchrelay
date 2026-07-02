import type {
  GitHubCiSnapshotRecord,
  IssueChildRecord,
  IssueRecord,
  IssueSessionEventRecord,
  IssueSessionRecord,
  RunRecord,
  RunStatus,
  WorkflowObservationRecord,
  WorkflowTaskRecord,
} from "./db-types.ts";
import type { FactoryState, RunType } from "./factory-state.ts";
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
import { WorkflowObservationStore } from "./db/workflow-observation-store.ts";
import { WorkflowTaskStore } from "./db/workflow-task-store.ts";
import { runPatchRelayMigrations } from "./db/migrations.ts";
import { assertPatchRelaySchemaReady } from "./db/schema-guard.ts";
import { SqliteConnection, type DatabaseConnection } from "./db/shared.ts";
import { ImmediateIssueSessionProjectionInvalidator } from "./issue-session-projection-invalidator.ts";
import { syncIssueSessionFromIssue } from "./issue-session-projector.ts";
import { noopTelemetry, type PatchRelayTelemetry } from "./telemetry.ts";
import { TrackedIssueQuery } from "./tracked-issue-query.ts";
import { hasPendingWake } from "./pending-wake.ts";
import { reconcileWorkflowTasksForIssue } from "./workflow-task-reconciler.ts";

export class PatchRelayDatabase {
  private readonly connection: DatabaseConnection;
  private readonly issueSessionProjection: ImmediateIssueSessionProjectionInvalidator;
  private telemetry: PatchRelayTelemetry = noopTelemetry;
  private readonly telemetryProxy: PatchRelayTelemetry = {
    emit: (event) => this.telemetry.emit(event),
  };
  readonly linearInstallations: LinearInstallationStore;
  readonly operatorFeed: OperatorFeedStore;
  readonly repositories: RepositoryLinkStore;
  readonly webhookEvents: WebhookEventStore;
  readonly workflowObservations: WorkflowObservationStore;
  readonly workflowTasks: WorkflowTaskStore;
  readonly issues: IssueStore;
  readonly issueSessions: IssueSessionStore;
  readonly runs: RunStore;
  readonly trackedIssues: TrackedIssueQuery;

  constructor(databasePath: string, wal: boolean, telemetry?: PatchRelayTelemetry) {
    this.databasePath = databasePath;
    if (telemetry) {
      this.telemetry = telemetry;
    }
    this.connection = new SqliteConnection(databasePath);
    this.connection.pragma("foreign_keys = ON");
    if (wal) {
      this.connection.pragma("journal_mode = WAL");
      this.connection.pragma("synchronous = NORMAL");
    }
    this.linearInstallations = new LinearInstallationStore(this.connection);
    this.operatorFeed = new OperatorFeedStore(this.connection);
    this.repositories = new RepositoryLinkStore(this.connection);
    this.webhookEvents = new WebhookEventStore(this.connection);
    this.workflowObservations = new WorkflowObservationStore(this.connection, mapWorkflowObservationRow);
    this.workflowTasks = new WorkflowTaskStore(this.connection, mapWorkflowTaskRow);
    this.issueSessionProjection = new ImmediateIssueSessionProjectionInvalidator({
      getIssue: (projectId, linearIssueId) => this.issues.getIssue(projectId, linearIssueId),
      listDependents: (projectId, blockerLinearIssueId) => this.issues.listDependents(projectId, blockerLinearIssueId),
      countUnresolvedBlockers: (projectId, linearIssueId) => this.issues.countUnresolvedBlockers(projectId, linearIssueId),
      getIssueSessionWaitingReason: (projectId, linearIssueId) => this.issueSessions.getIssueSession(projectId, linearIssueId)?.waitingReason,
      projectIssue: (issue, options) => syncIssueSessionFromIssue({
        connection: this.connection,
        issues: this.issues,
        issueSessions: this.issueSessions,
        runs: this.runs,
        workflowTasks: this.workflowTasks,
        issue,
        telemetry: this.telemetryProxy,
        ...(options ? { options } : {}),
      }),
      telemetry: this.telemetryProxy,
    });
    this.issues = new IssueStore(this.connection, this.issueSessionProjection);
    this.runs = new RunStore(
      this.connection,
      mapRunRow,
      this.issues,
      this.issueSessionProjection,
      this.telemetryProxy,
      this.workflowObservations,
    );
    this.issueSessions = new IssueSessionStore(
      this.connection,
      mapIssueSessionRow,
      mapIssueSessionEventRow,
      this.issues,
      this.runs,
      this.issueSessionProjection,
      this.telemetryProxy,
    );
    this.trackedIssues = new TrackedIssueQuery(this.issues, this.issueSessions, {
      hasPendingWake: (projectId, linearIssueId) =>
        hasPendingWake(this, projectId, linearIssueId),
    }, this.runs);
  }

  private readonly databasePath: string;

  setTelemetry(telemetry: PatchRelayTelemetry): void {
    this.telemetry = telemetry;
  }

  runMigrations(): void {
    runPatchRelayMigrations(this.connection);
    this.assertSchemaReady();
  }

  assertSchemaReady(): void {
    assertPatchRelaySchemaReady(this.connection, this.databasePath);
  }

  describeSchema(): Record<string, unknown> {
    const tableRows = this.connection.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name IN ('issues', 'issue_sessions', 'runs')
      ORDER BY name
    `).all();
    const issueColumns = tableRows.some((row) => row.name === "issues")
      ? this.connection.prepare("PRAGMA table_info(issues)").all().map((row) => row.name)
      : [];
    return {
      databasePath: this.databasePath,
      tables: tableRows.map((row) => row.name),
      issuesVersionColumnPresent: issueColumns.includes("version"),
    };
  }

  transaction<T>(fn: () => T): T {
    return this.connection.transaction(fn)();
  }

  batchIssueSessionProjections<T>(fn: () => T): T {
    return this.issueSessionProjection.batch(fn);
  }

  runWalCheckpoint(mode: "PASSIVE" | "FULL" | "RESTART" | "TRUNCATE" = "PASSIVE"): Array<Record<string, unknown>> {
    return this.connection.prepare(`PRAGMA wal_checkpoint(${mode})`).all() as Array<Record<string, unknown>>;
  }

  close(): void {
    this.connection.close();
  }

  /**
   * Raw SQLite handle for tests ONLY. Production code must go through the
   * stores; this exists so fixtures can backdate timestamps, force invalid
   * edge states, and exercise the migration/schema-guard machinery — none of
   * which the store API exposes, by design. The deliberately ugly name keeps
   * it greppable so a production leak can't slip back in unnoticed.
   */
  unsafeRawConnectionForTests(): DatabaseConnection {
    return this.connection;
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

  replaceIssueParentLink(params: {
    projectId: string;
    childLinearIssueId: string;
    parentLinearIssueId?: string | null;
  }): void {
    this.issues.replaceIssueParentLink(params);
  }

  listChildLinks(projectId: string, parentLinearIssueId: string): IssueChildRecord[] {
    return this.issues.listChildLinks(projectId, parentLinearIssueId);
  }

  listChildIssues(projectId: string, parentLinearIssueId: string): IssueRecord[] {
    return this.issues.listChildIssues(projectId, parentLinearIssueId);
  }

  listCanonicalChildIssues(projectId: string, parentLinearIssueId: string): IssueRecord[] {
    return this.issues.listCanonicalChildIssues(projectId, parentLinearIssueId);
  }

  countOpenChildIssues(projectId: string, parentLinearIssueId: string): number {
    return this.issues.countOpenChildIssues(projectId, parentLinearIssueId);
  }

  getLatestGitHubCiSnapshot(projectId: string, linearIssueId: string): GitHubCiSnapshotRecord | undefined {
    return this.issues.getLatestGitHubCiSnapshot(projectId, linearIssueId);
  }

  countUnresolvedBlockers(projectId: string, linearIssueId: string): number {
    return this.issues.countUnresolvedBlockers(projectId, linearIssueId);
  }

  listIssuesReadyForExecution(): Array<{ projectId: string; linearIssueId: string }> {
    const ready = new Map<string, { projectId: string; linearIssueId: string }>();
    // Terminal issues with no open workflow task are a guaranteed no-op here
    // (deriveWorkflowTasks short-circuits for done/failed), so reconcile only
    // the workflow-relevant subset instead of the whole table every tick.
    for (const issue of this.issues.listWorkflowTaskReconcileCandidates()) {
      reconcileWorkflowTasksForIssue(this, issue);
    }
    for (const issue of this.trackedIssues.listIssuesReadyForExecution()) {
      ready.set(`${issue.projectId}:${issue.linearIssueId}`, issue);
    }
    for (const task of this.workflowTasks.listOpenRunnableTasks()) {
      ready.set(`${task.projectId}:${task.subjectId}`, {
        projectId: task.projectId,
        linearIssueId: task.subjectId,
      });
    }
    return [...ready.values()];
  }

  /**
   * Issues idle in pr_open with no active run — candidates for state
   * advancement based on stored PR metadata (missed GitHub webhooks).
   */
  listIdleNonTerminalIssues(): IssueRecord[] {
    return this.issues.listIdleNonTerminalIssues();
  }

  /**
   * Idle delegated issues that still have unprocessed session events.
   * The idle reconciler re-enqueues these to recover from a silently
   * dropped enqueueIssue (lease race, in-memory queue cleared at restart).
   */
  listIdleIssuesWithPendingWake(): IssueRecord[] {
    return this.issues.listIdleIssuesWithPendingWake();
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
    displayUpdatedAt: String(row.display_updated_at ?? row.updated_at),
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
    ...(row.launch_phase !== null && row.launch_phase !== undefined ? { launchPhase: String(row.launch_phase) as RunRecord["launchPhase"] } : {}),
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
    ...(row.should_not_publish === 1 || row.should_not_publish === true ? { shouldNotPublish: true } : {}),
    authorityEpoch: Number(row.authority_epoch ?? 0),
    ...(row.lease_revoked_at !== null ? { leaseRevokedAt: String(row.lease_revoked_at) } : {}),
    ...(row.lease_revoke_reason !== null ? { leaseRevokeReason: String(row.lease_revoke_reason) } : {}),
    ...(row.task_id !== null && row.task_id !== undefined ? { taskId: String(row.task_id) } : {}),
    startedAt: String(row.started_at),
    ...(row.ended_at !== null ? { endedAt: String(row.ended_at) } : {}),
  };
}

function mapWorkflowObservationRow(row: Record<string, unknown>): WorkflowObservationRecord {
  return {
    id: Number(row.id),
    projectId: String(row.project_id),
    subjectId: String(row.subject_id),
    source: String(row.source) as WorkflowObservationRecord["source"],
    type: String(row.type),
    ...(row.payload_json !== null && row.payload_json !== undefined ? { payloadJson: String(row.payload_json) } : {}),
    ...(row.dedupe_key !== null && row.dedupe_key !== undefined ? { dedupeKey: String(row.dedupe_key) } : {}),
    observedAt: String(row.observed_at),
  };
}

function mapWorkflowTaskRow(row: Record<string, unknown>): WorkflowTaskRecord {
  return {
    id: Number(row.id),
    projectId: String(row.project_id),
    subjectId: String(row.subject_id),
    taskId: String(row.task_id),
    taskType: String(row.task_type),
    ...(row.run_type !== null && row.run_type !== undefined ? { runType: String(row.run_type) as WorkflowTaskRecord["runType"] } : {}),
    status: String(row.status) as WorkflowTaskRecord["status"],
    reason: String(row.reason),
    ...(row.requirements_json !== null && row.requirements_json !== undefined ? { requirementsJson: String(row.requirements_json) } : {}),
    authorityEpoch: Number(row.authority_epoch ?? 0),
    gateAction: String(row.gate_action),
    ...(row.gate_reason !== null && row.gate_reason !== undefined ? { gateReason: String(row.gate_reason) } : {}),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    ...(row.closed_at !== null && row.closed_at !== undefined ? { closedAt: String(row.closed_at) } : {}),
  };
}
