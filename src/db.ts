import type { IssueRecord, RunRecord, RunStatus, TrackedIssueRecord, ThreadEventRecord } from "./db-types.ts";
import type { FactoryState, RunType } from "./factory-state.ts";
import { LinearInstallationStore } from "./db/linear-installation-store.ts";
import { OperatorFeedStore } from "./db/operator-feed-store.ts";
import { runPatchRelayMigrations } from "./db/migrations.ts";
import { SqliteConnection, isoNow, type DatabaseConnection } from "./db/shared.ts";

export class PatchRelayDatabase {
  readonly connection: DatabaseConnection;
  readonly linearInstallations: LinearInstallationStore;
  readonly operatorFeed: OperatorFeedStore;

  constructor(databasePath: string, wal: boolean) {
    this.connection = new SqliteConnection(databasePath);
    this.connection.pragma("foreign_keys = ON");
    if (wal) {
      this.connection.pragma("journal_mode = WAL");
    }
    this.linearInstallations = new LinearInstallationStore(this.connection);
    this.operatorFeed = new OperatorFeedStore(this.connection);
  }

  runMigrations(): void {
    runPatchRelayMigrations(this.connection);
  }

  transaction<T>(fn: () => T): T {
    return this.connection.transaction(fn)();
  }

  // ─── Webhook Events ───────────────────────────────────────────────

  insertWebhookEvent(webhookId: string, receivedAt: string): { id: number; duplicate: boolean } {
    const existing = this.connection
      .prepare("SELECT id FROM webhook_events WHERE webhook_id = ?")
      .get(webhookId) as { id: number } | undefined;
    if (existing) {
      return { id: existing.id as number, duplicate: true };
    }
    const result = this.connection
      .prepare("INSERT INTO webhook_events (webhook_id, received_at, processing_status) VALUES (?, ?, 'processed')")
      .run(webhookId, receivedAt);
    return { id: Number(result.lastInsertRowid), duplicate: false };
  }

  insertFullWebhookEvent(params: {
    webhookId: string;
    receivedAt: string;
    payloadJson: string;
  }): { id: number; dedupeStatus: string } {
    const existing = this.connection
      .prepare("SELECT id FROM webhook_events WHERE webhook_id = ?")
      .get(params.webhookId) as { id: number } | undefined;
    if (existing) {
      return { id: existing.id as number, dedupeStatus: "duplicate" };
    }
    const result = this.connection
      .prepare("INSERT INTO webhook_events (webhook_id, received_at, payload_json) VALUES (?, ?, ?)")
      .run(params.webhookId, params.receivedAt, params.payloadJson);
    return { id: Number(result.lastInsertRowid), dedupeStatus: "accepted" };
  }

  getWebhookPayload(id: number): { webhookId: string; payloadJson: string } | undefined {
    const row = this.connection.prepare("SELECT webhook_id, payload_json FROM webhook_events WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row || !row.payload_json) return undefined;
    return { webhookId: String(row.webhook_id), payloadJson: String(row.payload_json) };
  }

  isWebhookDuplicate(webhookId: string): boolean {
    return this.connection.prepare("SELECT 1 FROM webhook_events WHERE webhook_id = ?").get(webhookId) !== undefined;
  }

  markWebhookProcessed(id: number, status: string): void {
    this.connection.prepare("UPDATE webhook_events SET processing_status = ? WHERE id = ?").run(status, id);
  }

  assignWebhookProject(id: number, projectId: string): void {
    this.connection.prepare("UPDATE webhook_events SET project_id = ? WHERE id = ?").run(projectId, id);
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
    factoryState?: FactoryState;
    pendingRunType?: RunType | null;
    pendingRunContextJson?: string | null;
    branchName?: string;
    worktreePath?: string;
    threadId?: string | null;
    activeRunId?: number | null;
    agentSessionId?: string | null;
    prNumber?: number | null;
    prUrl?: string | null;
    prState?: string | null;
    prReviewState?: string | null;
    prCheckStatus?: string | null;
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
      if (params.factoryState !== undefined) { sets.push("factory_state = @factoryState"); values.factoryState = params.factoryState; }
      if (params.pendingRunType !== undefined) { sets.push("pending_run_type = @pendingRunType"); values.pendingRunType = params.pendingRunType; }
      if (params.pendingRunContextJson !== undefined) { sets.push("pending_run_context_json = @pendingRunContextJson"); values.pendingRunContextJson = params.pendingRunContextJson; }
      if (params.branchName !== undefined) { sets.push("branch_name = COALESCE(@branchName, branch_name)"); values.branchName = params.branchName; }
      if (params.worktreePath !== undefined) { sets.push("worktree_path = COALESCE(@worktreePath, worktree_path)"); values.worktreePath = params.worktreePath; }
      if (params.threadId !== undefined) { sets.push("thread_id = @threadId"); values.threadId = params.threadId; }
      if (params.activeRunId !== undefined) { sets.push("active_run_id = @activeRunId"); values.activeRunId = params.activeRunId; }
      if (params.agentSessionId !== undefined) { sets.push("agent_session_id = @agentSessionId"); values.agentSessionId = params.agentSessionId; }
      if (params.prNumber !== undefined) { sets.push("pr_number = @prNumber"); values.prNumber = params.prNumber; }
      if (params.prUrl !== undefined) { sets.push("pr_url = @prUrl"); values.prUrl = params.prUrl; }
      if (params.prState !== undefined) { sets.push("pr_state = @prState"); values.prState = params.prState; }
      if (params.prReviewState !== undefined) { sets.push("pr_review_state = @prReviewState"); values.prReviewState = params.prReviewState; }
      if (params.prCheckStatus !== undefined) { sets.push("pr_check_status = @prCheckStatus"); values.prCheckStatus = params.prCheckStatus; }
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
          current_linear_state, factory_state, pending_run_type, pending_run_context_json,
          branch_name, worktree_path, thread_id, active_run_id,
          agent_session_id,
          updated_at
        ) VALUES (
          @projectId, @linearIssueId, @issueKey, @title, @description, @url,
          @priority, @estimate,
          @currentLinearState, @factoryState, @pendingRunType, @pendingRunContextJson,
          @branchName, @worktreePath, @threadId, @activeRunId,
          @agentSessionId,
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
        factoryState: params.factoryState ?? "delegated",
        pendingRunType: params.pendingRunType ?? null,
        pendingRunContextJson: params.pendingRunContextJson ?? null,
        branchName: params.branchName ?? null,
        worktreePath: params.worktreePath ?? null,
        threadId: params.threadId ?? null,
        activeRunId: params.activeRunId ?? null,
        agentSessionId: params.agentSessionId ?? null,
        now,
      });
    }
    return this.getIssue(params.projectId, params.linearIssueId)!;
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

  listIssuesReadyForExecution(): Array<{ projectId: string; linearIssueId: string }> {
    const rows = this.connection
      .prepare("SELECT project_id, linear_issue_id FROM issues WHERE pending_run_type IS NOT NULL AND active_run_id IS NULL")
      .all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      projectId: String(row.project_id),
      linearIssueId: String(row.linear_issue_id),
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
    promptText?: string;
  }): RunRecord {
    const now = isoNow();
    const result = this.connection.prepare(`
      INSERT INTO runs (issue_id, project_id, linear_issue_id, run_type, status, prompt_text, started_at)
      VALUES (?, ?, ?, ?, 'queued', ?, ?)
    `).run(
      params.issueId,
      params.projectId,
      params.linearIssueId,
      params.runType,
      params.promptText ?? null,
      now,
    );
    return this.getRun(Number(result.lastInsertRowid))!;
  }

  getRun(id: number): RunRecord | undefined {
    const row = this.connection.prepare("SELECT * FROM runs WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? mapRunRow(row) : undefined;
  }

  getRunByThreadId(threadId: string): RunRecord | undefined {
    const row = this.connection.prepare("SELECT * FROM runs WHERE thread_id = ?").get(threadId) as Record<string, unknown> | undefined;
    return row ? mapRunRow(row) : undefined;
  }

  listRunsForIssue(projectId: string, linearIssueId: string): RunRecord[] {
    const rows = this.connection
      .prepare("SELECT * FROM runs WHERE project_id = ? AND linear_issue_id = ? ORDER BY id")
      .all(projectId, linearIssueId) as Array<Record<string, unknown>>;
    return rows.map(mapRunRow);
  }

  getLatestRunForIssue(projectId: string, linearIssueId: string): RunRecord | undefined {
    const row = this.connection
      .prepare("SELECT * FROM runs WHERE project_id = ? AND linear_issue_id = ? ORDER BY id DESC LIMIT 1")
      .get(projectId, linearIssueId) as Record<string, unknown> | undefined;
    return row ? mapRunRow(row) : undefined;
  }

  listActiveRuns(): RunRecord[] {
    const rows = this.connection
      .prepare("SELECT * FROM runs WHERE status IN ('queued', 'running')")
      .all() as Array<Record<string, unknown>>;
    return rows.map(mapRunRow);
  }

  listRunningRuns(): RunRecord[] {
    const rows = this.connection
      .prepare("SELECT * FROM runs WHERE status IN ('running', 'queued')")
      .all() as Array<Record<string, unknown>>;
    return rows.map(mapRunRow);
  }

  updateRunThread(runId: number, params: { threadId: string; parentThreadId?: string; turnId?: string }): void {
    this.connection.prepare(`
      UPDATE runs SET
        thread_id = ?,
        parent_thread_id = COALESCE(?, parent_thread_id),
        turn_id = COALESCE(?, turn_id),
        status = 'running'
      WHERE id = ?
    `).run(params.threadId, params.parentThreadId ?? null, params.turnId ?? null, runId);
  }

  updateRunTurnId(runId: number, turnId: string): void {
    this.connection.prepare("UPDATE runs SET turn_id = ? WHERE id = ?").run(turnId, runId);
  }

  finishRun(runId: number, params: {
    status: RunStatus;
    threadId?: string;
    turnId?: string;
    failureReason?: string;
    summaryJson?: string;
    reportJson?: string;
  }): void {
    const now = isoNow();
    this.connection.prepare(`
      UPDATE runs SET
        status = ?,
        thread_id = COALESCE(?, thread_id),
        turn_id = COALESCE(?, turn_id),
        failure_reason = COALESCE(?, failure_reason),
        summary_json = COALESCE(?, summary_json),
        report_json = COALESCE(?, report_json),
        ended_at = ?
      WHERE id = ?
    `).run(
      params.status,
      params.threadId ?? null,
      params.turnId ?? null,
      params.failureReason ?? null,
      params.summaryJson ?? null,
      params.reportJson ?? null,
      now,
      runId,
    );
  }

  // ─── Thread Events (kept for extended history) ────────────────────

  saveThreadEvent(params: {
    runId: number;
    threadId: string;
    turnId?: string;
    method: string;
    eventJson: string;
  }): void {
    this.connection.prepare(`
      INSERT INTO run_thread_events (run_id, thread_id, turn_id, method, event_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(params.runId, params.threadId, params.turnId ?? null, params.method, params.eventJson, isoNow());
  }

  listThreadEvents(runId: number): ThreadEventRecord[] {
    const rows = this.connection
      .prepare("SELECT * FROM run_thread_events WHERE run_id = ? ORDER BY id")
      .all(runId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: Number(row.id),
      runId: Number(row.run_id),
      threadId: String(row.thread_id),
      ...(row.turn_id !== null ? { turnId: String(row.turn_id) } : {}),
      method: String(row.method),
      eventJson: String(row.event_json),
      createdAt: String(row.created_at),
    }));
  }

  // ─── View builders ──────────────────────────────────────────────

  issueToTrackedIssue(issue: IssueRecord): TrackedIssueRecord {
    return {
      id: issue.id,
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      ...(issue.issueKey ? { issueKey: issue.issueKey } : {}),
      ...(issue.title ? { title: issue.title } : {}),
      ...(issue.url ? { issueUrl: issue.url } : {}),
      ...(issue.currentLinearState ? { currentLinearState: issue.currentLinearState } : {}),
      factoryState: issue.factoryState,
      ...(issue.activeRunId !== undefined ? { activeRunId: issue.activeRunId } : {}),
      ...(issue.agentSessionId ? { activeAgentSessionId: issue.agentSessionId } : {}),
      updatedAt: issue.updatedAt,
    };
  }

  getTrackedIssue(projectId: string, linearIssueId: string): TrackedIssueRecord | undefined {
    const issue = this.getIssue(projectId, linearIssueId);
    return issue ? this.issueToTrackedIssue(issue) : undefined;
  }

  getTrackedIssueByKey(issueKey: string): TrackedIssueRecord | undefined {
    const issue = this.getIssueByKey(issueKey);
    return issue ? this.issueToTrackedIssue(issue) : undefined;
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
    factoryState: String(row.factory_state ?? "delegated") as FactoryState,
    ...(row.pending_run_type !== null && row.pending_run_type !== undefined ? { pendingRunType: String(row.pending_run_type) as RunType } : {}),
    ...(row.pending_run_context_json !== null && row.pending_run_context_json !== undefined ? { pendingRunContextJson: String(row.pending_run_context_json) } : {}),
    ...(row.branch_name !== null ? { branchName: String(row.branch_name) } : {}),
    ...(row.worktree_path !== null ? { worktreePath: String(row.worktree_path) } : {}),
    ...(row.thread_id !== null ? { threadId: String(row.thread_id) } : {}),
    ...(row.active_run_id !== null ? { activeRunId: Number(row.active_run_id) } : {}),
    ...(row.agent_session_id !== null ? { agentSessionId: String(row.agent_session_id) } : {}),
    updatedAt: String(row.updated_at),
    ...(row.pr_number !== null && row.pr_number !== undefined ? { prNumber: Number(row.pr_number) } : {}),
    ...(row.pr_url !== null && row.pr_url !== undefined ? { prUrl: String(row.pr_url) } : {}),
    ...(row.pr_state !== null && row.pr_state !== undefined ? { prState: String(row.pr_state) } : {}),
    ...(row.pr_review_state !== null && row.pr_review_state !== undefined ? { prReviewState: String(row.pr_review_state) } : {}),
    ...(row.pr_check_status !== null && row.pr_check_status !== undefined ? { prCheckStatus: String(row.pr_check_status) } : {}),
    ciRepairAttempts: Number(row.ci_repair_attempts ?? 0),
    queueRepairAttempts: Number(row.queue_repair_attempts ?? 0),
    reviewFixAttempts: Number(row.review_fix_attempts ?? 0),
    zombieRecoveryAttempts: Number(row.zombie_recovery_attempts ?? 0),
    ...(row.last_zombie_recovery_at !== null && row.last_zombie_recovery_at !== undefined ? { lastZombieRecoveryAt: String(row.last_zombie_recovery_at) } : {}),
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
