import type { IssueRecord, RunRecord, RunStatus, StageRunRecord, TrackedIssueRecord, WorkspaceRecord, ThreadEventRecord } from "./db-types.ts";
import type { IssueLifecycleStatus, WorkflowStage } from "./workflow-types.ts";
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
      .prepare("INSERT INTO webhook_events (webhook_id, received_at, event_type, headers_json, payload_json, signature_valid, dedupe_status) VALUES (?, ?, '', '{}', '{}', 1, 'accepted')")
      .run(webhookId, receivedAt);
    return { id: Number(result.lastInsertRowid), duplicate: false };
  }

  getWebhookEvent(id: number) {
    return this.connection.prepare("SELECT * FROM webhook_events WHERE id = ?").get(id) as Record<string, unknown> | undefined;
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

  // Keep full webhook_events access for service-webhooks.ts compatibility
  insertFullWebhookEvent(params: {
    webhookId: string;
    receivedAt: string;
    eventType: string;
    issueId?: string;
    headersJson: string;
    payloadJson: string;
    signatureValid: boolean;
    dedupeStatus: string;
  }): { id: number; dedupeStatus: string } {
    const existing = this.connection
      .prepare("SELECT id FROM webhook_events WHERE webhook_id = ?")
      .get(params.webhookId) as { id: number } | undefined;
    if (existing) {
      return { id: existing.id as number, dedupeStatus: "duplicate" };
    }
    const result = this.connection
      .prepare(`INSERT INTO webhook_events (webhook_id, received_at, event_type, issue_id, headers_json, payload_json, signature_valid, dedupe_status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        params.webhookId,
        params.receivedAt,
        params.eventType,
        params.issueId ?? null,
        params.headersJson,
        params.payloadJson,
        params.signatureValid ? 1 : 0,
        params.dedupeStatus,
      );
    return { id: Number(result.lastInsertRowid), dedupeStatus: params.dedupeStatus };
  }

  getFullWebhookEvent(id: number): {
    id: number;
    webhookId: string;
    receivedAt: string;
    eventType: string;
    issueId?: string;
    projectId?: string;
    headersJson: string;
    payloadJson: string;
    signatureValid: boolean;
    dedupeStatus: string;
    processingStatus: string;
  } | undefined {
    const row = this.connection.prepare("SELECT * FROM webhook_events WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      id: Number(row.id),
      webhookId: String(row.webhook_id),
      receivedAt: String(row.received_at),
      eventType: String(row.event_type),
      ...(row.issue_id !== null ? { issueId: String(row.issue_id) } : {}),
      ...(row.project_id !== null ? { projectId: String(row.project_id) } : {}),
      headersJson: String(row.headers_json),
      payloadJson: String(row.payload_json),
      signatureValid: row.signature_valid === 1,
      dedupeStatus: String(row.dedupe_status),
      processingStatus: String(row.processing_status),
    };
  }

  // ─── Issues ───────────────────────────────────────────────────────

  upsertIssue(params: {
    projectId: string;
    linearIssueId: string;
    issueKey?: string;
    title?: string;
    url?: string;
    selectedWorkflowId?: string | null;
    currentLinearState?: string;
    desiredStage?: WorkflowStage | null;
    branchName?: string;
    worktreePath?: string;
    threadId?: string | null;
    activeRunId?: number | null;
    statusCommentId?: string | null;
    agentSessionId?: string | null;
    continuationBarrierAt?: string | null;
    lifecycleStatus?: IssueLifecycleStatus;
    prNumber?: number | null;
    prUrl?: string | null;
    prState?: string | null;
    prReviewState?: string | null;
    prCheckStatus?: string | null;
    ciRepairAttempts?: number;
    queueRepairAttempts?: number;
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
      if (params.url !== undefined) { sets.push("url = COALESCE(@url, url)"); values.url = params.url; }
      if (params.selectedWorkflowId !== undefined) { sets.push("selected_workflow_id = @selectedWorkflowId"); values.selectedWorkflowId = params.selectedWorkflowId; }
      if (params.currentLinearState !== undefined) { sets.push("current_linear_state = COALESCE(@currentLinearState, current_linear_state)"); values.currentLinearState = params.currentLinearState; }
      if (params.desiredStage !== undefined) { sets.push("desired_stage = @desiredStage"); values.desiredStage = params.desiredStage; }
      if (params.branchName !== undefined) { sets.push("branch_name = COALESCE(@branchName, branch_name)"); values.branchName = params.branchName; }
      if (params.worktreePath !== undefined) { sets.push("worktree_path = COALESCE(@worktreePath, worktree_path)"); values.worktreePath = params.worktreePath; }
      if (params.threadId !== undefined) { sets.push("thread_id = @threadId"); values.threadId = params.threadId; }
      if (params.activeRunId !== undefined) { sets.push("active_run_id = @activeRunId"); values.activeRunId = params.activeRunId; }
      if (params.statusCommentId !== undefined) { sets.push("status_comment_id = @statusCommentId"); values.statusCommentId = params.statusCommentId; }
      if (params.agentSessionId !== undefined) { sets.push("agent_session_id = @agentSessionId"); values.agentSessionId = params.agentSessionId; }
      if (params.continuationBarrierAt !== undefined) { sets.push("continuation_barrier_at = @continuationBarrierAt"); values.continuationBarrierAt = params.continuationBarrierAt; }
      if (params.lifecycleStatus !== undefined) { sets.push("lifecycle_status = @lifecycleStatus"); values.lifecycleStatus = params.lifecycleStatus; }
      if (params.prNumber !== undefined) { sets.push("pr_number = @prNumber"); values.prNumber = params.prNumber; }
      if (params.prUrl !== undefined) { sets.push("pr_url = @prUrl"); values.prUrl = params.prUrl; }
      if (params.prState !== undefined) { sets.push("pr_state = @prState"); values.prState = params.prState; }
      if (params.prReviewState !== undefined) { sets.push("pr_review_state = @prReviewState"); values.prReviewState = params.prReviewState; }
      if (params.prCheckStatus !== undefined) { sets.push("pr_check_status = @prCheckStatus"); values.prCheckStatus = params.prCheckStatus; }
      if (params.ciRepairAttempts !== undefined) { sets.push("ci_repair_attempts = @ciRepairAttempts"); values.ciRepairAttempts = params.ciRepairAttempts; }
      if (params.queueRepairAttempts !== undefined) { sets.push("queue_repair_attempts = @queueRepairAttempts"); values.queueRepairAttempts = params.queueRepairAttempts; }

      this.connection.prepare(`UPDATE issues SET ${sets.join(", ")} WHERE project_id = @projectId AND linear_issue_id = @linearIssueId`).run(values);
    } else {
      this.connection.prepare(`
        INSERT INTO issues (
          project_id, linear_issue_id, issue_key, title, url,
          selected_workflow_id, current_linear_state, desired_stage,
          branch_name, worktree_path, thread_id, active_run_id,
          status_comment_id, agent_session_id, continuation_barrier_at,
          lifecycle_status, updated_at
        ) VALUES (
          @projectId, @linearIssueId, @issueKey, @title, @url,
          @selectedWorkflowId, @currentLinearState, @desiredStage,
          @branchName, @worktreePath, @threadId, @activeRunId,
          @statusCommentId, @agentSessionId, @continuationBarrierAt,
          @lifecycleStatus, @now
        )
      `).run({
        projectId: params.projectId,
        linearIssueId: params.linearIssueId,
        issueKey: params.issueKey ?? null,
        title: params.title ?? null,
        url: params.url ?? null,
        selectedWorkflowId: params.selectedWorkflowId ?? null,
        currentLinearState: params.currentLinearState ?? null,
        desiredStage: params.desiredStage ?? null,
        branchName: params.branchName ?? null,
        worktreePath: params.worktreePath ?? null,
        threadId: params.threadId ?? null,
        activeRunId: params.activeRunId ?? null,
        statusCommentId: params.statusCommentId ?? null,
        agentSessionId: params.agentSessionId ?? null,
        continuationBarrierAt: params.continuationBarrierAt ?? null,
        lifecycleStatus: params.lifecycleStatus ?? "idle",
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

  listIssuesReadyForExecution(): Array<{ projectId: string; linearIssueId: string }> {
    const rows = this.connection
      .prepare("SELECT project_id, linear_issue_id FROM issues WHERE desired_stage IS NOT NULL AND active_run_id IS NULL")
      .all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      projectId: String(row.project_id),
      linearIssueId: String(row.linear_issue_id),
    }));
  }

  // ─── Runs ─────────────────────────────────────────────────────────

  createRun(params: {
    issueId: number;
    projectId: string;
    linearIssueId: string;
    stage: WorkflowStage;
    workflowFile?: string;
    promptText?: string;
  }): RunRecord {
    const now = isoNow();
    const result = this.connection.prepare(`
      INSERT INTO runs (issue_id, project_id, linear_issue_id, stage, status, workflow_file, prompt_text, started_at)
      VALUES (?, ?, ?, ?, 'queued', ?, ?, ?)
    `).run(
      params.issueId,
      params.projectId,
      params.linearIssueId,
      params.stage,
      params.workflowFile ?? null,
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
      .prepare("SELECT * FROM runs WHERE status = 'running'")
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
      INSERT INTO run_thread_events (run_lease_id, thread_id, turn_id, method, event_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(params.runId, params.threadId, params.turnId ?? null, params.method, params.eventJson, isoNow());
  }

  listThreadEvents(runId: number): ThreadEventRecord[] {
    const rows = this.connection
      .prepare("SELECT * FROM run_thread_events WHERE run_lease_id = ? ORDER BY id")
      .all(runId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: Number(row.id),
      stageRunId: Number(row.run_lease_id),
      threadId: String(row.thread_id),
      ...(row.turn_id !== null ? { turnId: String(row.turn_id) } : {}),
      method: String(row.method),
      eventJson: String(row.event_json),
      createdAt: String(row.created_at),
    }));
  }

  // ─── View builders for CLI/query compatibility ────────────────────

  issueToTrackedIssue(issue: IssueRecord): TrackedIssueRecord {
    return {
      id: issue.id,
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      ...(issue.selectedWorkflowId ? { selectedWorkflowId: issue.selectedWorkflowId } : {}),
      ...(issue.issueKey ? { issueKey: issue.issueKey } : {}),
      ...(issue.title ? { title: issue.title } : {}),
      ...(issue.url ? { issueUrl: issue.url } : {}),
      ...(issue.currentLinearState ? { currentLinearState: issue.currentLinearState } : {}),
      ...(issue.desiredStage ? { desiredStage: issue.desiredStage } : {}),
      ...(issue.activeRunId !== undefined ? { activeStageRunId: issue.activeRunId } : {}),
      ...(issue.statusCommentId ? { statusCommentId: issue.statusCommentId } : {}),
      ...(issue.agentSessionId ? { activeAgentSessionId: issue.agentSessionId } : {}),
      ...(issue.continuationBarrierAt ? { continuationBarrierAt: issue.continuationBarrierAt } : {}),
      lifecycleStatus: issue.lifecycleStatus,
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

  runToStageRun(run: RunRecord): StageRunRecord {
    return {
      id: run.id,
      pipelineRunId: run.id,
      projectId: run.projectId,
      linearIssueId: run.linearIssueId,
      workspaceId: run.issueId,
      stage: run.stage,
      status: run.status === "failed" ? "failed" : run.status === "completed" || run.status === "released" ? "completed" : "running",
      triggerWebhookId: `run-${run.id}`,
      workflowFile: run.workflowFile ?? "",
      promptText: run.promptText ?? "",
      ...(run.threadId ? { threadId: run.threadId } : {}),
      ...(run.parentThreadId ? { parentThreadId: run.parentThreadId } : {}),
      ...(run.turnId ? { turnId: run.turnId } : {}),
      ...(run.summaryJson ? { summaryJson: run.summaryJson } : {}),
      ...(run.reportJson ? { reportJson: run.reportJson } : {}),
      startedAt: run.startedAt,
      ...(run.endedAt ? { endedAt: run.endedAt } : {}),
    };
  }

  getStageRun(id: number): StageRunRecord | undefined {
    const run = this.getRun(id);
    return run ? this.runToStageRun(run) : undefined;
  }

  getStageRunByThreadId(threadId: string): StageRunRecord | undefined {
    const run = this.getRunByThreadId(threadId);
    return run ? this.runToStageRun(run) : undefined;
  }

  listStageRunsForIssue(projectId: string, linearIssueId: string): StageRunRecord[] {
    return this.listRunsForIssue(projectId, linearIssueId).map((run) => this.runToStageRun(run));
  }

  getLatestStageRunForIssue(projectId: string, linearIssueId: string): StageRunRecord | undefined {
    const run = this.getLatestRunForIssue(projectId, linearIssueId);
    return run ? this.runToStageRun(run) : undefined;
  }

  issueToWorkspace(issue: IssueRecord): WorkspaceRecord | undefined {
    if (!issue.branchName || !issue.worktreePath) {
      return undefined;
    }
    const activeRun = issue.activeRunId ? this.getRun(issue.activeRunId) : undefined;
    const latestRun = this.getLatestRunForIssue(issue.projectId, issue.linearIssueId);
    return {
      id: issue.id,
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      branchName: issue.branchName,
      worktreePath: issue.worktreePath,
      status: issue.lifecycleStatus === "running" ? "active" : issue.lifecycleStatus === "paused" || issue.lifecycleStatus === "failed" ? "paused" : "active",
      ...(latestRun ? { lastStage: latestRun.stage } : {}),
      ...(activeRun?.threadId ? { lastThreadId: activeRun.threadId } : latestRun?.threadId ? { lastThreadId: latestRun.threadId } : {}),
      createdAt: issue.updatedAt,
      updatedAt: issue.updatedAt,
    };
  }

  getWorkspaceForIssue(projectId: string, linearIssueId: string): WorkspaceRecord | undefined {
    const issue = this.getIssue(projectId, linearIssueId);
    return issue ? this.issueToWorkspace(issue) : undefined;
  }

  getWorkspaceById(id: number): WorkspaceRecord | undefined {
    const issue = this.getIssueById(id);
    return issue ? this.issueToWorkspace(issue) : undefined;
  }

  // ─── Issue overview for query service ─────────────────────────────

  getIssueOverview(issueKey: string): {
    issue: TrackedIssueRecord;
    workspace?: WorkspaceRecord;
    activeStageRun?: StageRunRecord;
  } | undefined {
    const issue = this.getIssueByKey(issueKey);
    if (!issue) return undefined;
    const tracked = this.issueToTrackedIssue(issue);
    const workspace = this.issueToWorkspace(issue);
    const activeStageRun = issue.activeRunId ? this.getStageRun(issue.activeRunId) : undefined;
    return {
      issue: tracked,
      ...(workspace ? { workspace } : {}),
      ...(activeStageRun ? { activeStageRun } : {}),
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
    ...(row.url !== null ? { url: String(row.url) } : {}),
    ...(row.selected_workflow_id !== null ? { selectedWorkflowId: String(row.selected_workflow_id) } : {}),
    ...(row.current_linear_state !== null ? { currentLinearState: String(row.current_linear_state) } : {}),
    ...(row.desired_stage !== null ? { desiredStage: String(row.desired_stage) } : {}),
    ...(row.branch_name !== null ? { branchName: String(row.branch_name) } : {}),
    ...(row.worktree_path !== null ? { worktreePath: String(row.worktree_path) } : {}),
    ...(row.thread_id !== null ? { threadId: String(row.thread_id) } : {}),
    ...(row.active_run_id !== null ? { activeRunId: Number(row.active_run_id) } : {}),
    ...(row.status_comment_id !== null ? { statusCommentId: String(row.status_comment_id) } : {}),
    ...(row.agent_session_id !== null ? { agentSessionId: String(row.agent_session_id) } : {}),
    ...(row.continuation_barrier_at !== null ? { continuationBarrierAt: String(row.continuation_barrier_at) } : {}),
    lifecycleStatus: String(row.lifecycle_status) as IssueLifecycleStatus,
    updatedAt: String(row.updated_at),
    ...(row.pr_number !== null && row.pr_number !== undefined ? { prNumber: Number(row.pr_number) } : {}),
    ...(row.pr_url !== null && row.pr_url !== undefined ? { prUrl: String(row.pr_url) } : {}),
    ...(row.pr_state !== null && row.pr_state !== undefined ? { prState: String(row.pr_state) } : {}),
    ...(row.pr_review_state !== null && row.pr_review_state !== undefined ? { prReviewState: String(row.pr_review_state) } : {}),
    ...(row.pr_check_status !== null && row.pr_check_status !== undefined ? { prCheckStatus: String(row.pr_check_status) } : {}),
    ciRepairAttempts: Number(row.ci_repair_attempts ?? 0),
    queueRepairAttempts: Number(row.queue_repair_attempts ?? 0),
  };
}

function mapRunRow(row: Record<string, unknown>): RunRecord {
  return {
    id: Number(row.id),
    issueId: Number(row.issue_id),
    projectId: String(row.project_id),
    linearIssueId: String(row.linear_issue_id),
    stage: String(row.stage),
    status: String(row.status) as RunStatus,
    runType: (String(row.run_type ?? "stage")) as import("./db-types.ts").RunType,
    ...(row.workflow_file !== null ? { workflowFile: String(row.workflow_file) } : {}),
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
