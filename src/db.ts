import Database from "better-sqlite3";
import type { IssueRunRecord, IssueState, PersistedIssueRecord, RunStage, RunStatus, WebhookEventRecord } from "./types.js";

const migrations = [
  `
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

  CREATE TABLE IF NOT EXISTS issues (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL,
    linear_issue_id TEXT NOT NULL,
    linear_issue_key TEXT,
    title TEXT,
    current_state TEXT NOT NULL,
    branch_name TEXT,
    worktree_path TEXT,
    active_run_id INTEGER,
    last_webhook_at TEXT,
    updated_at TEXT NOT NULL,
    UNIQUE(project_id, linear_issue_id)
  );

  CREATE TABLE IF NOT EXISTS issue_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL,
    linear_issue_id TEXT NOT NULL,
    stage TEXT NOT NULL,
    status TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    trigger_webhook_id TEXT NOT NULL,
    session_id INTEGER,
    result_json TEXT,
    error_json TEXT
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL,
    linear_issue_id TEXT NOT NULL,
    run_id INTEGER NOT NULL,
    stage TEXT NOT NULL,
    zmx_session_name TEXT NOT NULL,
    process_id INTEGER,
    branch_name TEXT NOT NULL,
    worktree_path TEXT NOT NULL,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    exit_code INTEGER
  );
  `,
];

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
    for (const migration of migrations) {
      this.connection.exec(migration);
    }
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

  upsertIssue(params: {
    projectId: string;
    linearIssueId: string;
    linearIssueKey?: string;
    title?: string;
    currentState: IssueState;
    branchName?: string;
    worktreePath?: string;
    activeRunId?: number | null;
    lastWebhookAt: string;
  }): PersistedIssueRecord {
    const now = new Date().toISOString();
    this.connection
      .prepare(
        `
        INSERT INTO issues (
          project_id, linear_issue_id, linear_issue_key, title, current_state, branch_name, worktree_path, active_run_id, last_webhook_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(project_id, linear_issue_id) DO UPDATE SET
          linear_issue_key = excluded.linear_issue_key,
          title = excluded.title,
          current_state = excluded.current_state,
          branch_name = COALESCE(excluded.branch_name, issues.branch_name),
          worktree_path = COALESCE(excluded.worktree_path, issues.worktree_path),
          active_run_id = excluded.active_run_id,
          last_webhook_at = excluded.last_webhook_at,
          updated_at = excluded.updated_at
        `,
      )
      .run(
        params.projectId,
        params.linearIssueId,
        params.linearIssueKey ?? null,
        params.title ?? null,
        params.currentState,
        params.branchName ?? null,
        params.worktreePath ?? null,
        params.activeRunId ?? null,
        params.lastWebhookAt,
        now,
      );

    return this.getIssue(params.projectId, params.linearIssueId)!;
  }

  getIssue(projectId: string, linearIssueId: string): PersistedIssueRecord | undefined {
    const row = this.connection
      .prepare("SELECT * FROM issues WHERE project_id = ? AND linear_issue_id = ?")
      .get(projectId, linearIssueId) as Record<string, unknown> | undefined;
    return row ? this.mapIssue(row) : undefined;
  }

  updateIssueState(
    projectId: string,
    linearIssueId: string,
    state: IssueState,
    values: {
      branchName?: string;
      worktreePath?: string;
      activeRunId?: number | null;
    } = {},
  ): void {
    const current = this.getIssue(projectId, linearIssueId);
    if (!current) {
      return;
    }

    const now = new Date().toISOString();
    this.connection
      .prepare(
        `
        UPDATE issues
        SET current_state = ?, branch_name = ?, worktree_path = ?, active_run_id = ?, updated_at = ?
        WHERE project_id = ? AND linear_issue_id = ?
        `,
      )
      .run(
        state,
        values.branchName ?? current.branchName ?? null,
        values.worktreePath ?? current.worktreePath ?? null,
        values.activeRunId ?? null,
        now,
        projectId,
        linearIssueId,
      );
  }

  createIssueRun(params: {
    projectId: string;
    linearIssueId: string;
    stage: RunStage;
    triggerWebhookId: string;
  }): number {
    const now = new Date().toISOString();
    const result = this.connection
      .prepare(
        `
        INSERT INTO issue_runs (project_id, linear_issue_id, stage, status, started_at, trigger_webhook_id)
        VALUES (?, ?, ?, 'running', ?, ?)
        `,
      )
      .run(params.projectId, params.linearIssueId, params.stage, now, params.triggerWebhookId);

    return Number(result.lastInsertRowid);
  }

  updateRunSessionId(runId: number, sessionId: number): void {
    this.connection.prepare("UPDATE issue_runs SET session_id = ? WHERE id = ?").run(sessionId, runId);
  }

  finishIssueRun(params: {
    runId: number;
    status: RunStatus;
    resultJson?: string;
    errorJson?: string;
  }): void {
    const now = new Date().toISOString();
    this.connection
      .prepare(
        `
        UPDATE issue_runs
        SET status = ?, finished_at = ?, result_json = ?, error_json = ?
        WHERE id = ?
        `,
      )
      .run(params.status, now, params.resultJson ?? null, params.errorJson ?? null, params.runId);
  }

  createSession(params: {
    projectId: string;
    linearIssueId: string;
    runId: number;
    stage: RunStage;
    zmxSessionName: string;
    processId?: number;
    branchName: string;
    worktreePath: string;
  }): number {
    const now = new Date().toISOString();
    const result = this.connection
      .prepare(
        `
        INSERT INTO sessions (
          project_id, linear_issue_id, run_id, stage, zmx_session_name, process_id, branch_name, worktree_path, started_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        params.projectId,
        params.linearIssueId,
        params.runId,
        params.stage,
        params.zmxSessionName,
        params.processId ?? null,
        params.branchName,
        params.worktreePath,
        now,
      );

    return Number(result.lastInsertRowid);
  }

  finishSession(sessionId: number, exitCode: number): void {
    this.connection.prepare("UPDATE sessions SET ended_at = ?, exit_code = ? WHERE id = ?").run(new Date().toISOString(), exitCode, sessionId);
  }

  private mapIssue(row: Record<string, unknown>): PersistedIssueRecord {
    return {
      id: Number(row.id),
      projectId: String(row.project_id),
      linearIssueId: String(row.linear_issue_id),
      ...(row.linear_issue_key === null ? {} : { linearIssueKey: String(row.linear_issue_key) }),
      ...(row.title === null ? {} : { title: String(row.title) }),
      currentState: row.current_state as IssueState,
      ...(row.branch_name === null ? {} : { branchName: String(row.branch_name) }),
      ...(row.worktree_path === null ? {} : { worktreePath: String(row.worktree_path) }),
      ...(row.active_run_id === null ? {} : { activeRunId: Number(row.active_run_id) }),
      ...(row.last_webhook_at === null ? {} : { lastWebhookAt: String(row.last_webhook_at) }),
      updatedAt: String(row.updated_at),
    };
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

  private mapIssueRun(row: Record<string, unknown>): IssueRunRecord {
    return {
      id: Number(row.id),
      projectId: String(row.project_id),
      linearIssueId: String(row.linear_issue_id),
      stage: row.stage as RunStage,
      status: row.status as RunStatus,
      startedAt: String(row.started_at),
      ...(row.finished_at === null ? {} : { finishedAt: String(row.finished_at) }),
      triggerWebhookId: String(row.trigger_webhook_id),
      ...(row.session_id === null ? {} : { sessionId: Number(row.session_id) }),
      ...(row.result_json === null ? {} : { resultJson: String(row.result_json) }),
      ...(row.error_json === null ? {} : { errorJson: String(row.error_json) }),
    };
  }
}
