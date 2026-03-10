import Database from "better-sqlite3";
import type {
  IssueLifecycleStatus,
  LinearInstallationRecord,
  OAuthStateRecord,
  PipelineRunRecord,
  PipelineStatus,
  ProjectInstallationRecord,
  QueuedTurnInputRecord,
  StageRunRecord,
  StageRunStatus,
  ThreadEventRecord,
  TrackedIssueRecord,
  WebhookEventRecord,
  WorkflowStage,
  WorkspaceRecord,
} from "./types.js";

const baseMigration = `
DROP TABLE IF EXISTS issues;
DROP TABLE IF EXISTS issue_runs;
DROP TABLE IF EXISTS sessions;

CREATE TABLE IF NOT EXISTS webhook_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  webhook_id TEXT NOT NULL UNIQUE,
  received_at TEXT NOT NULL,
  event_type TEXT NOT NULL,
  issue_id TEXT,
  project_id TEXT,
  headers_json TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  signature_valid INTEGER NOT NULL,
  dedupe_status TEXT NOT NULL,
  processing_status TEXT NOT NULL DEFAULT 'pending'
);

CREATE TABLE IF NOT EXISTS tracked_issues (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  linear_issue_id TEXT NOT NULL,
  issue_key TEXT,
  title TEXT,
  issue_url TEXT,
  current_linear_state TEXT,
  desired_stage TEXT,
  desired_webhook_id TEXT,
  active_workspace_id INTEGER,
  active_pipeline_run_id INTEGER,
  active_stage_run_id INTEGER,
  latest_thread_id TEXT,
  status_comment_id TEXT,
  lifecycle_status TEXT NOT NULL,
  last_webhook_at TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, linear_issue_id)
);

CREATE TABLE IF NOT EXISTS workspaces (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  linear_issue_id TEXT NOT NULL,
  branch_name TEXT NOT NULL,
  worktree_path TEXT NOT NULL,
  status TEXT NOT NULL,
  last_stage TEXT,
  last_thread_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pipeline_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  linear_issue_id TEXT NOT NULL,
  workspace_id INTEGER NOT NULL,
  status TEXT NOT NULL,
  current_stage TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT
);

CREATE TABLE IF NOT EXISTS stage_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pipeline_run_id INTEGER NOT NULL,
  project_id TEXT NOT NULL,
  linear_issue_id TEXT NOT NULL,
  workspace_id INTEGER NOT NULL,
  stage TEXT NOT NULL,
  status TEXT NOT NULL,
  trigger_webhook_id TEXT NOT NULL,
  workflow_file TEXT NOT NULL,
  prompt_text TEXT NOT NULL,
  thread_id TEXT,
  parent_thread_id TEXT,
  turn_id TEXT,
  summary_json TEXT,
  report_json TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT
);

CREATE TABLE IF NOT EXISTS thread_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stage_run_id INTEGER NOT NULL,
  thread_id TEXT NOT NULL,
  turn_id TEXT,
  method TEXT NOT NULL,
  event_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS queued_turn_inputs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stage_run_id INTEGER NOT NULL,
  thread_id TEXT,
  turn_id TEXT,
  source TEXT NOT NULL,
  body TEXT NOT NULL,
  delivered_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS linear_installations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL DEFAULT 'linear',
  workspace_id TEXT,
  workspace_name TEXT,
  workspace_key TEXT,
  actor_id TEXT,
  actor_name TEXT,
  access_token_ciphertext TEXT NOT NULL,
  refresh_token_ciphertext TEXT,
  scopes_json TEXT NOT NULL,
  token_type TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS project_installations (
  project_id TEXT PRIMARY KEY,
  installation_id INTEGER NOT NULL,
  linked_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_states (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  state TEXT NOT NULL UNIQUE,
  project_id TEXT,
  redirect_uri TEXT NOT NULL,
  actor TEXT NOT NULL,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  consumed_at TEXT,
  installation_id INTEGER,
  error_message TEXT
);
`;

function isoNow(): string {
  return new Date().toISOString();
}

export class PatchRelayDatabase {
  readonly connection: Database.Database;

  constructor(databasePath: string, wal: boolean) {
    this.connection = new Database(databasePath);
    this.connection.pragma("foreign_keys = ON");
    if (wal) {
      this.connection.pragma("journal_mode = WAL");
    }
  }

  runMigrations(): void {
    this.connection.exec(baseMigration);
    this.ensureColumnExists("tracked_issues", "status_comment_id", "TEXT");
    this.ensureColumnExists("oauth_states", "status", "TEXT NOT NULL DEFAULT 'pending'");
    this.ensureColumnExists("oauth_states", "installation_id", "INTEGER");
    this.ensureColumnExists("oauth_states", "error_message", "TEXT");
  }

  private ensureColumnExists(tableName: string, columnName: string, definition: string): void {
    const columns = this.connection
      .prepare(`PRAGMA table_info(${tableName})`)
      .all() as Array<{ name?: string }>;
    if (columns.some((column) => String(column.name) === columnName)) {
      return;
    }

    this.connection.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  }

  insertWebhookEvent(params: {
    webhookId: string;
    receivedAt: string;
    eventType: string;
    issueId?: string;
    projectId?: string;
    headersJson: string;
    payloadJson: string;
    signatureValid: boolean;
    dedupeStatus: WebhookEventRecord["dedupeStatus"];
  }): { id: number; inserted: boolean } {
    const existing = this.connection.prepare("SELECT id FROM webhook_events WHERE webhook_id = ?").get(params.webhookId) as
      | { id: number }
      | undefined;
    if (existing) {
      this.connection.prepare("UPDATE webhook_events SET dedupe_status = 'duplicate' WHERE id = ?").run(existing.id);
      return { id: existing.id, inserted: false };
    }

    const result = this.connection
      .prepare(
        `
        INSERT INTO webhook_events (
          webhook_id, received_at, event_type, issue_id, project_id, headers_json, payload_json, signature_valid, dedupe_status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        params.webhookId,
        params.receivedAt,
        params.eventType,
        params.issueId ?? null,
        params.projectId ?? null,
        params.headersJson,
        params.payloadJson,
        params.signatureValid ? 1 : 0,
        params.dedupeStatus,
      );

    return { id: Number(result.lastInsertRowid), inserted: true };
  }

  markWebhookProcessed(id: number, status: WebhookEventRecord["processingStatus"]): void {
    this.connection.prepare("UPDATE webhook_events SET processing_status = ? WHERE id = ?").run(status, id);
  }

  assignWebhookProject(id: number, projectId: string): void {
    this.connection.prepare("UPDATE webhook_events SET project_id = ? WHERE id = ?").run(projectId, id);
  }

  getWebhookEvent(id: number): WebhookEventRecord | undefined {
    const row = this.connection.prepare("SELECT * FROM webhook_events WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? this.mapWebhookEvent(row) : undefined;
  }

  upsertTrackedIssue(params: {
    projectId: string;
    linearIssueId: string;
    issueKey?: string;
    title?: string;
    issueUrl?: string;
    currentLinearState?: string;
    desiredStage?: WorkflowStage | null;
    desiredWebhookId?: string | null;
    activeWorkspaceId?: number | null;
    activePipelineRunId?: number | null;
    activeStageRunId?: number | null;
    latestThreadId?: string | null;
    statusCommentId?: string | null;
    lifecycleStatus: IssueLifecycleStatus;
    lastWebhookAt?: string;
  }): TrackedIssueRecord {
    const now = isoNow();
    this.connection
      .prepare(
        `
        INSERT INTO tracked_issues (
          project_id, linear_issue_id, issue_key, title, issue_url, current_linear_state, desired_stage, desired_webhook_id,
          active_workspace_id, active_pipeline_run_id, active_stage_run_id, latest_thread_id, status_comment_id,
          lifecycle_status, last_webhook_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(project_id, linear_issue_id) DO UPDATE SET
          issue_key = COALESCE(excluded.issue_key, tracked_issues.issue_key),
          title = COALESCE(excluded.title, tracked_issues.title),
          issue_url = COALESCE(excluded.issue_url, tracked_issues.issue_url),
          current_linear_state = COALESCE(excluded.current_linear_state, tracked_issues.current_linear_state),
          desired_stage = COALESCE(excluded.desired_stage, tracked_issues.desired_stage),
          desired_webhook_id = COALESCE(excluded.desired_webhook_id, tracked_issues.desired_webhook_id),
          active_workspace_id = COALESCE(excluded.active_workspace_id, tracked_issues.active_workspace_id),
          active_pipeline_run_id = COALESCE(excluded.active_pipeline_run_id, tracked_issues.active_pipeline_run_id),
          active_stage_run_id = COALESCE(excluded.active_stage_run_id, tracked_issues.active_stage_run_id),
          latest_thread_id = COALESCE(excluded.latest_thread_id, tracked_issues.latest_thread_id),
          status_comment_id = COALESCE(excluded.status_comment_id, tracked_issues.status_comment_id),
          lifecycle_status = excluded.lifecycle_status,
          last_webhook_at = COALESCE(excluded.last_webhook_at, tracked_issues.last_webhook_at),
          updated_at = excluded.updated_at
        `,
      )
      .run(
        params.projectId,
        params.linearIssueId,
        params.issueKey ?? null,
        params.title ?? null,
        params.issueUrl ?? null,
        params.currentLinearState ?? null,
        params.desiredStage ?? null,
        params.desiredWebhookId ?? null,
        params.activeWorkspaceId ?? null,
        params.activePipelineRunId ?? null,
        params.activeStageRunId ?? null,
        params.latestThreadId ?? null,
        params.statusCommentId ?? null,
        params.lifecycleStatus,
        params.lastWebhookAt ?? null,
        now,
      );

    return this.getTrackedIssue(params.projectId, params.linearIssueId)!;
  }

  getTrackedIssue(projectId: string, linearIssueId: string): TrackedIssueRecord | undefined {
    const row = this.connection
      .prepare("SELECT * FROM tracked_issues WHERE project_id = ? AND linear_issue_id = ?")
      .get(projectId, linearIssueId) as Record<string, unknown> | undefined;
    return row ? this.mapTrackedIssue(row) : undefined;
  }

  getTrackedIssueByKey(issueKey: string): TrackedIssueRecord | undefined {
    const row = this.connection
      .prepare("SELECT * FROM tracked_issues WHERE issue_key = ? ORDER BY updated_at DESC LIMIT 1")
      .get(issueKey) as Record<string, unknown> | undefined;
    return row ? this.mapTrackedIssue(row) : undefined;
  }

  getTrackedIssueByLinearIssueId(linearIssueId: string): TrackedIssueRecord | undefined {
    const row = this.connection
      .prepare("SELECT * FROM tracked_issues WHERE linear_issue_id = ? ORDER BY updated_at DESC LIMIT 1")
      .get(linearIssueId) as Record<string, unknown> | undefined;
    return row ? this.mapTrackedIssue(row) : undefined;
  }

  recordDesiredStage(params: {
    projectId: string;
    linearIssueId: string;
    issueKey?: string;
    title?: string;
    issueUrl?: string;
    currentLinearState?: string;
    desiredStage?: WorkflowStage;
    desiredWebhookId?: string;
    lastWebhookAt: string;
  }): TrackedIssueRecord {
    const existing = this.getTrackedIssue(params.projectId, params.linearIssueId);
    const lifecycleStatus =
      existing?.activeStageRunId || params.desiredStage ? existing?.lifecycleStatus ?? "queued" : existing?.lifecycleStatus ?? "idle";
    const issueKey = params.issueKey ?? existing?.issueKey;
    const title = params.title ?? existing?.title;
    const issueUrl = params.issueUrl ?? existing?.issueUrl;
    const currentLinearState = params.currentLinearState ?? existing?.currentLinearState;

    return this.upsertTrackedIssue({
      projectId: params.projectId,
      linearIssueId: params.linearIssueId,
      ...(issueKey ? { issueKey } : {}),
      ...(title ? { title } : {}),
      ...(issueUrl ? { issueUrl } : {}),
      ...(currentLinearState ? { currentLinearState } : {}),
      desiredStage: params.desiredStage ?? existing?.desiredStage ?? null,
      desiredWebhookId: params.desiredWebhookId ?? existing?.desiredWebhookId ?? null,
      activeWorkspaceId: existing?.activeWorkspaceId ?? null,
      activePipelineRunId: existing?.activePipelineRunId ?? null,
      activeStageRunId: existing?.activeStageRunId ?? null,
      latestThreadId: existing?.latestThreadId ?? null,
      statusCommentId: existing?.statusCommentId ?? null,
      lifecycleStatus,
      lastWebhookAt: params.lastWebhookAt,
    });
  }

  listIssuesReadyForExecution(): TrackedIssueRecord[] {
    const rows = this.connection
      .prepare("SELECT * FROM tracked_issues WHERE desired_stage IS NOT NULL AND active_stage_run_id IS NULL")
      .all() as Record<string, unknown>[];
    return rows.map((row) => this.mapTrackedIssue(row));
  }

  listActiveStageRuns(): StageRunRecord[] {
    const rows = this.connection.prepare("SELECT * FROM stage_runs WHERE status = 'running'").all() as Record<string, unknown>[];
    return rows.map((row) => this.mapStageRun(row));
  }

  claimStageRun(params: {
    projectId: string;
    linearIssueId: string;
    stage: WorkflowStage;
    triggerWebhookId: string;
    branchName: string;
    worktreePath: string;
    workflowFile: string;
    promptText: string;
  }): { issue: TrackedIssueRecord; workspace: WorkspaceRecord; pipeline: PipelineRunRecord; stageRun: StageRunRecord } | undefined {
    const transaction = this.connection.transaction(() => {
      const issue = this.getTrackedIssue(params.projectId, params.linearIssueId);
      if (!issue || issue.activeStageRunId || issue.desiredStage !== params.stage || issue.desiredWebhookId !== params.triggerWebhookId) {
        return undefined;
      }

      const now = isoNow();
      let workspace = issue.activeWorkspaceId ? this.getWorkspace(issue.activeWorkspaceId) : undefined;
      if (!workspace) {
        const workspaceResult = this.connection
          .prepare(
            `
            INSERT INTO workspaces (project_id, linear_issue_id, branch_name, worktree_path, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, 'active', ?, ?)
            `,
          )
          .run(params.projectId, params.linearIssueId, params.branchName, params.worktreePath, now, now);
        workspace = this.getWorkspace(Number(workspaceResult.lastInsertRowid))!;
      } else {
        this.connection
          .prepare(
            `
            UPDATE workspaces
            SET branch_name = ?, worktree_path = ?, status = 'active', updated_at = ?
            WHERE id = ?
            `,
          )
          .run(params.branchName, params.worktreePath, now, workspace.id);
        workspace = this.getWorkspace(workspace.id)!;
      }

      let pipeline = issue.activePipelineRunId ? this.getPipelineRun(issue.activePipelineRunId) : undefined;
      if (!pipeline || pipeline.status !== "active") {
        const pipelineResult = this.connection
          .prepare(
            `
            INSERT INTO pipeline_runs (project_id, linear_issue_id, workspace_id, status, current_stage, started_at)
            VALUES (?, ?, ?, 'active', ?, ?)
            `,
          )
          .run(params.projectId, params.linearIssueId, workspace.id, params.stage, now);
        pipeline = this.getPipelineRun(Number(pipelineResult.lastInsertRowid))!;
      } else {
        this.connection.prepare("UPDATE pipeline_runs SET current_stage = ? WHERE id = ?").run(params.stage, pipeline.id);
        pipeline = this.getPipelineRun(pipeline.id)!;
      }

      const stageRunResult = this.connection
        .prepare(
          `
          INSERT INTO stage_runs (
            pipeline_run_id, project_id, linear_issue_id, workspace_id, stage, status, trigger_webhook_id, workflow_file, prompt_text, started_at
          ) VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?, ?)
          `,
        )
        .run(
          pipeline.id,
          params.projectId,
          params.linearIssueId,
          workspace.id,
          params.stage,
          params.triggerWebhookId,
          params.workflowFile,
          params.promptText,
          now,
        );
      const stageRun = this.getStageRun(Number(stageRunResult.lastInsertRowid))!;

      this.connection
        .prepare(
          `
          UPDATE tracked_issues
          SET desired_stage = NULL,
              desired_webhook_id = NULL,
              active_workspace_id = ?,
              active_pipeline_run_id = ?,
              active_stage_run_id = ?,
              lifecycle_status = 'running',
              updated_at = ?
          WHERE project_id = ? AND linear_issue_id = ?
          `,
        )
        .run(workspace.id, pipeline.id, stageRun.id, now, params.projectId, params.linearIssueId);

      return {
        issue: this.getTrackedIssue(params.projectId, params.linearIssueId)!,
        workspace,
        pipeline,
        stageRun,
      };
    });

    return transaction();
  }

  getWorkspace(id: number): WorkspaceRecord | undefined {
    const row = this.connection.prepare("SELECT * FROM workspaces WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? this.mapWorkspace(row) : undefined;
  }

  getActiveWorkspaceForIssue(projectId: string, linearIssueId: string): WorkspaceRecord | undefined {
    const row = this.connection
      .prepare("SELECT * FROM workspaces WHERE project_id = ? AND linear_issue_id = ? ORDER BY id DESC LIMIT 1")
      .get(projectId, linearIssueId) as Record<string, unknown> | undefined;
    return row ? this.mapWorkspace(row) : undefined;
  }

  getPipelineRun(id: number): PipelineRunRecord | undefined {
    const row = this.connection.prepare("SELECT * FROM pipeline_runs WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? this.mapPipelineRun(row) : undefined;
  }

  getActivePipelineForIssue(projectId: string, linearIssueId: string): PipelineRunRecord | undefined {
    const row = this.connection
      .prepare("SELECT * FROM pipeline_runs WHERE project_id = ? AND linear_issue_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1")
      .get(projectId, linearIssueId) as Record<string, unknown> | undefined;
    return row ? this.mapPipelineRun(row) : undefined;
  }

  getStageRun(id: number): StageRunRecord | undefined {
    const row = this.connection.prepare("SELECT * FROM stage_runs WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? this.mapStageRun(row) : undefined;
  }

  getStageRunByThreadId(threadId: string): StageRunRecord | undefined {
    const row = this.connection
      .prepare("SELECT * FROM stage_runs WHERE thread_id = ? ORDER BY id DESC LIMIT 1")
      .get(threadId) as Record<string, unknown> | undefined;
    return row ? this.mapStageRun(row) : undefined;
  }

  listStageRunsForIssue(projectId: string, linearIssueId: string): StageRunRecord[] {
    const rows = this.connection
      .prepare("SELECT * FROM stage_runs WHERE project_id = ? AND linear_issue_id = ? ORDER BY id")
      .all(projectId, linearIssueId) as Record<string, unknown>[];
    return rows.map((row) => this.mapStageRun(row));
  }

  updateStageRunThread(params: { stageRunId: number; threadId: string; parentThreadId?: string; turnId?: string }): void {
    this.connection
      .prepare(
        `
        UPDATE stage_runs
        SET thread_id = ?, parent_thread_id = COALESCE(?, parent_thread_id), turn_id = COALESCE(?, turn_id)
        WHERE id = ?
        `,
      )
      .run(params.threadId, params.parentThreadId ?? null, params.turnId ?? null, params.stageRunId);
  }

  finishStageRun(params: {
    stageRunId: number;
    status: StageRunStatus;
    threadId: string;
    turnId?: string;
    summaryJson?: string;
    reportJson?: string;
  }): void {
    const stageRun = this.getStageRun(params.stageRunId);
    if (!stageRun) {
      return;
    }

    const now = isoNow();
    this.connection
      .prepare(
        `
        UPDATE stage_runs
        SET status = ?, thread_id = ?, turn_id = COALESCE(?, turn_id), summary_json = ?, report_json = ?, ended_at = ?
        WHERE id = ?
        `,
      )
      .run(
        params.status,
        params.threadId,
        params.turnId ?? null,
        params.summaryJson ?? null,
        params.reportJson ?? null,
        now,
        params.stageRunId,
      );

    this.connection
      .prepare(
        `
        UPDATE workspaces
        SET last_stage = ?, last_thread_id = ?, status = ?, updated_at = ?
        WHERE id = ?
        `,
      )
      .run(stageRun.stage, params.threadId, params.status === "completed" ? "active" : "paused", now, stageRun.workspaceId);

    this.connection
      .prepare(
        `
        UPDATE tracked_issues
        SET active_stage_run_id = NULL,
            latest_thread_id = ?,
            lifecycle_status = ?,
            updated_at = ?
        WHERE project_id = ? AND linear_issue_id = ?
        `,
      )
      .run(
        params.threadId,
        params.status === "completed" ? "idle" : "failed",
        now,
        stageRun.projectId,
        stageRun.linearIssueId,
      );

    const nextPipelineStatus: PipelineStatus = params.status === "completed" ? "active" : "failed";
    this.connection
      .prepare(
        `
        UPDATE pipeline_runs
        SET status = ?, current_stage = ?, ended_at = CASE WHEN ? = 'failed' THEN ? ELSE ended_at END
        WHERE id = ?
        `,
      )
      .run(nextPipelineStatus, stageRun.stage, nextPipelineStatus, now, stageRun.pipelineRunId);
  }

  markPipelineCompleted(pipelineRunId: number): void {
    this.connection.prepare("UPDATE pipeline_runs SET status = 'completed', ended_at = ? WHERE id = ?").run(isoNow(), pipelineRunId);
  }

  setPipelineStatus(pipelineRunId: number, status: PipelineStatus): void {
    this.connection.prepare("UPDATE pipeline_runs SET status = ? WHERE id = ?").run(status, pipelineRunId);
  }

  setIssueDesiredStage(projectId: string, linearIssueId: string, desiredStage?: WorkflowStage, desiredWebhookId?: string): void {
    this.connection
      .prepare(
        `
        UPDATE tracked_issues
        SET desired_stage = ?, desired_webhook_id = ?, lifecycle_status = ?, updated_at = ?
        WHERE project_id = ? AND linear_issue_id = ?
        `,
      )
      .run(desiredStage ?? null, desiredWebhookId ?? null, desiredStage ? "queued" : "idle", isoNow(), projectId, linearIssueId);
  }

  setIssueLifecycleStatus(projectId: string, linearIssueId: string, lifecycleStatus: IssueLifecycleStatus): void {
    this.connection
      .prepare(
        `
        UPDATE tracked_issues
        SET lifecycle_status = ?, updated_at = ?
        WHERE project_id = ? AND linear_issue_id = ?
        `,
      )
      .run(lifecycleStatus, isoNow(), projectId, linearIssueId);
  }

  setIssueStatusComment(projectId: string, linearIssueId: string, statusCommentId: string): void {
    this.connection
      .prepare(
        `
        UPDATE tracked_issues
        SET status_comment_id = ?, updated_at = ?
        WHERE project_id = ? AND linear_issue_id = ?
        `,
      )
      .run(statusCommentId, isoNow(), projectId, linearIssueId);
  }

  saveThreadEvent(params: { stageRunId: number; threadId: string; turnId?: string; method: string; eventJson: string }): number {
    const result = this.connection
      .prepare(
        `
        INSERT INTO thread_events (stage_run_id, thread_id, turn_id, method, event_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
        `,
      )
      .run(params.stageRunId, params.threadId, params.turnId ?? null, params.method, params.eventJson, isoNow());
    return Number(result.lastInsertRowid);
  }

  listThreadEvents(stageRunId: number): ThreadEventRecord[] {
    const rows = this.connection
      .prepare("SELECT * FROM thread_events WHERE stage_run_id = ? ORDER BY id")
      .all(stageRunId) as Record<string, unknown>[];
    return rows.map((row) => this.mapThreadEvent(row));
  }

  enqueueTurnInput(params: { stageRunId: number; threadId?: string; turnId?: string; source: string; body: string }): number {
    const result = this.connection
      .prepare(
        `
        INSERT INTO queued_turn_inputs (stage_run_id, thread_id, turn_id, source, body, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
        `,
      )
      .run(params.stageRunId, params.threadId ?? null, params.turnId ?? null, params.source, params.body, isoNow());
    return Number(result.lastInsertRowid);
  }

  listPendingTurnInputs(stageRunId: number): QueuedTurnInputRecord[] {
    const rows = this.connection
      .prepare("SELECT * FROM queued_turn_inputs WHERE stage_run_id = ? AND delivered_at IS NULL ORDER BY id")
      .all(stageRunId) as Record<string, unknown>[];
    return rows.map((row) => this.mapQueuedTurnInput(row));
  }

  markTurnInputDelivered(id: number): void {
    this.connection.prepare("UPDATE queued_turn_inputs SET delivered_at = ? WHERE id = ?").run(isoNow(), id);
  }

  setPendingTurnInputRouting(id: number, threadId: string, turnId: string): void {
    this.connection.prepare("UPDATE queued_turn_inputs SET thread_id = ?, turn_id = ? WHERE id = ?").run(threadId, turnId, id);
  }

  getLatestStageRunForIssue(projectId: string, linearIssueId: string): StageRunRecord | undefined {
    const row = this.connection
      .prepare("SELECT * FROM stage_runs WHERE project_id = ? AND linear_issue_id = ? ORDER BY id DESC LIMIT 1")
      .get(projectId, linearIssueId) as Record<string, unknown> | undefined;
    return row ? this.mapStageRun(row) : undefined;
  }

  getIssueOverview(issueKey: string): {
    issue: TrackedIssueRecord;
    workspace?: WorkspaceRecord;
    pipeline?: PipelineRunRecord;
    activeStageRun?: StageRunRecord;
  } | undefined {
    const issue = this.getTrackedIssueByKey(issueKey);
    if (!issue) {
      return undefined;
    }

    const workspace = issue.activeWorkspaceId ? this.getWorkspace(issue.activeWorkspaceId) : undefined;
    const pipeline = issue.activePipelineRunId ? this.getPipelineRun(issue.activePipelineRunId) : undefined;
    const activeStageRun = issue.activeStageRunId ? this.getStageRun(issue.activeStageRunId) : undefined;

    return {
      issue,
      ...(workspace ? { workspace } : {}),
      ...(pipeline ? { pipeline } : {}),
      ...(activeStageRun ? { activeStageRun } : {}),
    };
  }

  upsertLinearInstallation(params: {
    workspaceId?: string;
    workspaceName?: string;
    workspaceKey?: string;
    actorId?: string;
    actorName?: string;
    accessTokenCiphertext: string;
    refreshTokenCiphertext?: string | null;
    scopesJson: string;
    tokenType?: string;
    expiresAt?: string | null;
  }): LinearInstallationRecord {
    const now = isoNow();
    const existing =
      (params.workspaceId
        ? (this.connection
            .prepare("SELECT id FROM linear_installations WHERE workspace_id = ? ORDER BY id DESC LIMIT 1")
            .get(params.workspaceId) as { id: number } | undefined)
        : undefined) ??
      (params.actorId
        ? (this.connection
            .prepare("SELECT id FROM linear_installations WHERE actor_id = ? ORDER BY id DESC LIMIT 1")
            .get(params.actorId) as { id: number } | undefined)
        : undefined);

    if (existing) {
      this.connection
        .prepare(
          `
          UPDATE linear_installations
          SET workspace_id = COALESCE(?, workspace_id),
              workspace_name = COALESCE(?, workspace_name),
              workspace_key = COALESCE(?, workspace_key),
              actor_id = COALESCE(?, actor_id),
              actor_name = COALESCE(?, actor_name),
              access_token_ciphertext = ?,
              refresh_token_ciphertext = COALESCE(?, refresh_token_ciphertext),
              scopes_json = ?,
              token_type = COALESCE(?, token_type),
              expires_at = COALESCE(?, expires_at),
              updated_at = ?
          WHERE id = ?
          `,
        )
        .run(
          params.workspaceId ?? null,
          params.workspaceName ?? null,
          params.workspaceKey ?? null,
          params.actorId ?? null,
          params.actorName ?? null,
          params.accessTokenCiphertext,
          params.refreshTokenCiphertext ?? null,
          params.scopesJson,
          params.tokenType ?? null,
          params.expiresAt ?? null,
          now,
          existing.id,
        );
      return this.getLinearInstallation(existing.id)!;
    }

    const result = this.connection
      .prepare(
        `
        INSERT INTO linear_installations (
          provider, workspace_id, workspace_name, workspace_key, actor_id, actor_name,
          access_token_ciphertext, refresh_token_ciphertext, scopes_json, token_type, expires_at, created_at, updated_at
        ) VALUES ('linear', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        params.workspaceId ?? null,
        params.workspaceName ?? null,
        params.workspaceKey ?? null,
        params.actorId ?? null,
        params.actorName ?? null,
        params.accessTokenCiphertext,
        params.refreshTokenCiphertext ?? null,
        params.scopesJson,
        params.tokenType ?? null,
        params.expiresAt ?? null,
        now,
        now,
      );
    return this.getLinearInstallation(Number(result.lastInsertRowid))!;
  }

  saveLinearInstallation(params: {
    workspaceId?: string;
    workspaceName?: string;
    workspaceKey?: string;
    actorId?: string;
    actorName?: string;
    accessTokenCiphertext: string;
    refreshTokenCiphertext?: string | null;
    scopesJson: string;
    tokenType?: string;
    expiresAt?: string | null;
  }): LinearInstallationRecord {
    return this.upsertLinearInstallation(params);
  }

  updateLinearInstallationTokens(
    id: number,
    params: {
      accessTokenCiphertext: string;
      refreshTokenCiphertext?: string | null;
      scopesJson?: string;
      tokenType?: string | null;
      expiresAt?: string | null;
    },
  ): LinearInstallationRecord | undefined {
    this.connection
      .prepare(
        `
        UPDATE linear_installations
        SET access_token_ciphertext = ?,
            refresh_token_ciphertext = COALESCE(?, refresh_token_ciphertext),
            scopes_json = COALESCE(?, scopes_json),
            token_type = COALESCE(?, token_type),
            expires_at = COALESCE(?, expires_at),
            updated_at = ?
        WHERE id = ?
        `,
      )
      .run(
        params.accessTokenCiphertext,
        params.refreshTokenCiphertext ?? null,
        params.scopesJson ?? null,
        params.tokenType ?? null,
        params.expiresAt ?? null,
        isoNow(),
        id,
      );
    return this.getLinearInstallation(id);
  }

  getLinearInstallation(id: number): LinearInstallationRecord | undefined {
    const row = this.connection
      .prepare("SELECT * FROM linear_installations WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    return row ? this.mapLinearInstallation(row) : undefined;
  }

  listLinearInstallations(): LinearInstallationRecord[] {
    const rows = this.connection
      .prepare("SELECT * FROM linear_installations ORDER BY updated_at DESC, id DESC")
      .all() as Record<string, unknown>[];
    return rows.map((row) => this.mapLinearInstallation(row));
  }

  linkProjectInstallation(projectId: string, installationId: number): ProjectInstallationRecord {
    const now = isoNow();
    this.connection
      .prepare(
        `
        INSERT INTO project_installations (project_id, installation_id, linked_at)
        VALUES (?, ?, ?)
        ON CONFLICT(project_id) DO UPDATE SET installation_id = excluded.installation_id, linked_at = excluded.linked_at
        `,
      )
      .run(projectId, installationId, now);
    return this.getProjectInstallation(projectId)!;
  }

  setProjectInstallation(projectId: string, installationId: number): ProjectInstallationRecord {
    return this.linkProjectInstallation(projectId, installationId);
  }

  getProjectInstallation(projectId: string): ProjectInstallationRecord | undefined {
    const row = this.connection
      .prepare("SELECT * FROM project_installations WHERE project_id = ?")
      .get(projectId) as Record<string, unknown> | undefined;
    return row ? this.mapProjectInstallation(row) : undefined;
  }

  listProjectInstallations(): ProjectInstallationRecord[] {
    const rows = this.connection
      .prepare("SELECT * FROM project_installations ORDER BY project_id")
      .all() as Record<string, unknown>[];
    return rows.map((row) => this.mapProjectInstallation(row));
  }

  unlinkProjectInstallation(projectId: string): void {
    this.connection.prepare("DELETE FROM project_installations WHERE project_id = ?").run(projectId);
  }

  getLinearInstallationForProject(projectId: string): LinearInstallationRecord | undefined {
    const row = this.connection
      .prepare(
        `
        SELECT li.*
        FROM linear_installations li
        INNER JOIN project_installations pi ON pi.installation_id = li.id
        WHERE pi.project_id = ?
        `,
      )
      .get(projectId) as Record<string, unknown> | undefined;
    return row ? this.mapLinearInstallation(row) : undefined;
  }

  createOAuthState(params: {
    provider: "linear";
    state: string;
    projectId?: string;
    redirectUri: string;
    actor: "user" | "app";
  }): OAuthStateRecord {
    const now = isoNow();
    const result = this.connection
      .prepare(
        `
        INSERT INTO oauth_states (provider, state, project_id, redirect_uri, actor, created_at, status)
        VALUES (?, ?, ?, ?, ?, ?, 'pending')
        `,
      )
      .run(params.provider, params.state, params.projectId ?? null, params.redirectUri, params.actor, now);
    return this.getOAuthStateById(Number(result.lastInsertRowid))!;
  }

  getOAuthState(state: string): OAuthStateRecord | undefined {
    const row = this.connection
      .prepare("SELECT * FROM oauth_states WHERE state = ? ORDER BY id DESC LIMIT 1")
      .get(state) as Record<string, unknown> | undefined;
    return row ? this.mapOAuthState(row) : undefined;
  }

  finalizeOAuthState(params: {
    state: string;
    status: "completed" | "failed";
    installationId?: number;
    errorMessage?: string;
  }): OAuthStateRecord | undefined {
    const row = this.connection
      .prepare("SELECT * FROM oauth_states WHERE state = ? AND consumed_at IS NULL ORDER BY id DESC LIMIT 1")
      .get(params.state) as Record<string, unknown> | undefined;
    if (!row) {
      return undefined;
    }

    this.connection
      .prepare(
        `
        UPDATE oauth_states
        SET status = ?,
            consumed_at = ?,
            installation_id = ?,
            error_message = ?
        WHERE id = ?
        `,
      )
      .run(params.status, isoNow(), params.installationId ?? null, params.errorMessage ?? null, Number(row.id));
    return this.getOAuthStateById(Number(row.id));
  }

  private getOAuthStateById(id: number): OAuthStateRecord | undefined {
    const row = this.connection.prepare("SELECT * FROM oauth_states WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? this.mapOAuthState(row) : undefined;
  }

  private mapWebhookEvent(row: Record<string, unknown>): WebhookEventRecord {
    return {
      id: Number(row.id),
      webhookId: String(row.webhook_id),
      receivedAt: String(row.received_at),
      eventType: String(row.event_type),
      ...(row.issue_id === null ? {} : { issueId: String(row.issue_id) }),
      ...(row.project_id === null ? {} : { projectId: String(row.project_id) }),
      headersJson: String(row.headers_json),
      payloadJson: String(row.payload_json),
      signatureValid: Number(row.signature_valid) === 1,
      dedupeStatus: row.dedupe_status as WebhookEventRecord["dedupeStatus"],
      processingStatus: row.processing_status as WebhookEventRecord["processingStatus"],
    };
  }

  private mapLinearInstallation(row: Record<string, unknown>): LinearInstallationRecord {
    return {
      id: Number(row.id),
      provider: "linear",
      ...(row.workspace_id === null ? {} : { workspaceId: String(row.workspace_id) }),
      ...(row.workspace_name === null ? {} : { workspaceName: String(row.workspace_name) }),
      ...(row.workspace_key === null ? {} : { workspaceKey: String(row.workspace_key) }),
      ...(row.actor_id === null ? {} : { actorId: String(row.actor_id) }),
      ...(row.actor_name === null ? {} : { actorName: String(row.actor_name) }),
      accessTokenCiphertext: String(row.access_token_ciphertext),
      ...(row.refresh_token_ciphertext === null ? {} : { refreshTokenCiphertext: String(row.refresh_token_ciphertext) }),
      scopesJson: String(row.scopes_json),
      ...(row.token_type === null ? {} : { tokenType: String(row.token_type) }),
      ...(row.expires_at === null ? {} : { expiresAt: String(row.expires_at) }),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  private mapProjectInstallation(row: Record<string, unknown>): ProjectInstallationRecord {
    return {
      projectId: String(row.project_id),
      installationId: Number(row.installation_id),
      linkedAt: String(row.linked_at),
    };
  }

  private mapOAuthState(row: Record<string, unknown>): OAuthStateRecord {
    return {
      id: Number(row.id),
      provider: "linear",
      state: String(row.state),
      ...(row.project_id === null ? {} : { projectId: String(row.project_id) }),
      redirectUri: String(row.redirect_uri),
      actor: row.actor as OAuthStateRecord["actor"],
      createdAt: String(row.created_at),
      status: (row.status as OAuthStateRecord["status"]) ?? "pending",
      ...(row.consumed_at === null ? {} : { consumedAt: String(row.consumed_at) }),
      ...(row.installation_id === null ? {} : { installationId: Number(row.installation_id) }),
      ...(row.error_message === null ? {} : { errorMessage: String(row.error_message) }),
    };
  }

  private mapTrackedIssue(row: Record<string, unknown>): TrackedIssueRecord {
    return {
      id: Number(row.id),
      projectId: String(row.project_id),
      linearIssueId: String(row.linear_issue_id),
      ...(row.issue_key === null ? {} : { issueKey: String(row.issue_key) }),
      ...(row.title === null ? {} : { title: String(row.title) }),
      ...(row.issue_url === null ? {} : { issueUrl: String(row.issue_url) }),
      ...(row.current_linear_state === null ? {} : { currentLinearState: String(row.current_linear_state) }),
      ...(row.desired_stage === null ? {} : { desiredStage: row.desired_stage as WorkflowStage }),
      ...(row.desired_webhook_id === null ? {} : { desiredWebhookId: String(row.desired_webhook_id) }),
      ...(row.active_workspace_id === null ? {} : { activeWorkspaceId: Number(row.active_workspace_id) }),
      ...(row.active_pipeline_run_id === null ? {} : { activePipelineRunId: Number(row.active_pipeline_run_id) }),
      ...(row.active_stage_run_id === null ? {} : { activeStageRunId: Number(row.active_stage_run_id) }),
      ...(row.latest_thread_id === null ? {} : { latestThreadId: String(row.latest_thread_id) }),
      ...(row.status_comment_id === null ? {} : { statusCommentId: String(row.status_comment_id) }),
      lifecycleStatus: row.lifecycle_status as IssueLifecycleStatus,
      ...(row.last_webhook_at === null ? {} : { lastWebhookAt: String(row.last_webhook_at) }),
      updatedAt: String(row.updated_at),
    };
  }

  private mapWorkspace(row: Record<string, unknown>): WorkspaceRecord {
    return {
      id: Number(row.id),
      projectId: String(row.project_id),
      linearIssueId: String(row.linear_issue_id),
      branchName: String(row.branch_name),
      worktreePath: String(row.worktree_path),
      status: row.status as WorkspaceRecord["status"],
      ...(row.last_stage === null ? {} : { lastStage: row.last_stage as WorkflowStage }),
      ...(row.last_thread_id === null ? {} : { lastThreadId: String(row.last_thread_id) }),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  private mapPipelineRun(row: Record<string, unknown>): PipelineRunRecord {
    return {
      id: Number(row.id),
      projectId: String(row.project_id),
      linearIssueId: String(row.linear_issue_id),
      workspaceId: Number(row.workspace_id),
      status: row.status as PipelineStatus,
      ...(row.current_stage === null ? {} : { currentStage: row.current_stage as WorkflowStage }),
      startedAt: String(row.started_at),
      ...(row.ended_at === null ? {} : { endedAt: String(row.ended_at) }),
    };
  }

  private mapStageRun(row: Record<string, unknown>): StageRunRecord {
    return {
      id: Number(row.id),
      pipelineRunId: Number(row.pipeline_run_id),
      projectId: String(row.project_id),
      linearIssueId: String(row.linear_issue_id),
      workspaceId: Number(row.workspace_id),
      stage: row.stage as WorkflowStage,
      status: row.status as StageRunStatus,
      triggerWebhookId: String(row.trigger_webhook_id),
      workflowFile: String(row.workflow_file),
      promptText: String(row.prompt_text),
      ...(row.thread_id === null ? {} : { threadId: String(row.thread_id) }),
      ...(row.parent_thread_id === null ? {} : { parentThreadId: String(row.parent_thread_id) }),
      ...(row.turn_id === null ? {} : { turnId: String(row.turn_id) }),
      ...(row.summary_json === null ? {} : { summaryJson: String(row.summary_json) }),
      ...(row.report_json === null ? {} : { reportJson: String(row.report_json) }),
      startedAt: String(row.started_at),
      ...(row.ended_at === null ? {} : { endedAt: String(row.ended_at) }),
    };
  }

  private mapThreadEvent(row: Record<string, unknown>): ThreadEventRecord {
    return {
      id: Number(row.id),
      stageRunId: Number(row.stage_run_id),
      threadId: String(row.thread_id),
      ...(row.turn_id === null ? {} : { turnId: String(row.turn_id) }),
      method: String(row.method),
      eventJson: String(row.event_json),
      createdAt: String(row.created_at),
    };
  }

  private mapQueuedTurnInput(row: Record<string, unknown>): QueuedTurnInputRecord {
    return {
      id: Number(row.id),
      stageRunId: Number(row.stage_run_id),
      ...(row.thread_id === null ? {} : { threadId: String(row.thread_id) }),
      ...(row.turn_id === null ? {} : { turnId: String(row.turn_id) }),
      source: String(row.source),
      body: String(row.body),
      ...(row.delivered_at === null ? {} : { deliveredAt: String(row.delivered_at) }),
      createdAt: String(row.created_at),
    };
  }
}
