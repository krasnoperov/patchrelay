import Database from "better-sqlite3";
import type {
  IssueRunRecord,
  IssueState,
  PersistedIssueRecord,
  RunStage,
  RunStatus,
  SessionRecord,
  WebhookEventRecord,
} from "./types.js";

const baseMigration = `
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
  issue_url TEXT,
  current_state TEXT NOT NULL,
  active_stage TEXT,
  desired_stage TEXT,
  desired_state_name TEXT,
  desired_webhook_id TEXT,
  desired_webhook_timestamp INTEGER,
  branch_name TEXT,
  worktree_path TEXT,
  active_run_id INTEGER,
  lease_owner TEXT,
  lease_expires_at TEXT,
  last_heartbeat_at TEXT,
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
`;

function columnExists(connection: Database.Database, table: string, column: string): boolean {
  const rows = connection.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((row) => row.name === column);
}

function addColumnIfMissing(connection: Database.Database, table: string, column: string, definition: string): void {
  if (!columnExists(connection, table, column)) {
    connection.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function isoNow(): string {
  return new Date().toISOString();
}

function isoFromMs(timestampMs: number): string {
  return new Date(timestampMs).toISOString();
}

function parseIsoMs(value?: string): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
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

    addColumnIfMissing(this.connection, "issues", "issue_url", "TEXT");
    addColumnIfMissing(this.connection, "issues", "active_stage", "TEXT");
    addColumnIfMissing(this.connection, "issues", "desired_stage", "TEXT");
    addColumnIfMissing(this.connection, "issues", "desired_state_name", "TEXT");
    addColumnIfMissing(this.connection, "issues", "desired_webhook_id", "TEXT");
    addColumnIfMissing(this.connection, "issues", "desired_webhook_timestamp", "INTEGER");
    addColumnIfMissing(this.connection, "issues", "lease_owner", "TEXT");
    addColumnIfMissing(this.connection, "issues", "lease_expires_at", "TEXT");
    addColumnIfMissing(this.connection, "issues", "last_heartbeat_at", "TEXT");
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
    issueUrl?: string;
    currentState: IssueState;
    branchName?: string;
    worktreePath?: string;
    activeRunId?: number | null;
    activeStage?: RunStage | null;
    desiredStage?: RunStage | null;
    desiredStateName?: string | null;
    desiredWebhookId?: string | null;
    desiredWebhookTimestamp?: number | null;
    leaseOwner?: string | null;
    leaseExpiresAt?: string | null;
    lastHeartbeatAt?: string | null;
    lastWebhookAt: string;
  }): PersistedIssueRecord {
    const now = isoNow();
    this.connection
      .prepare(
        `
        INSERT INTO issues (
          project_id, linear_issue_id, linear_issue_key, title, issue_url, current_state, active_stage, desired_stage,
          desired_state_name, desired_webhook_id, desired_webhook_timestamp, branch_name, worktree_path, active_run_id,
          lease_owner, lease_expires_at, last_heartbeat_at, last_webhook_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(project_id, linear_issue_id) DO UPDATE SET
          linear_issue_key = COALESCE(excluded.linear_issue_key, issues.linear_issue_key),
          title = COALESCE(excluded.title, issues.title),
          issue_url = COALESCE(excluded.issue_url, issues.issue_url),
          current_state = excluded.current_state,
          active_stage = COALESCE(excluded.active_stage, issues.active_stage),
          desired_stage = COALESCE(excluded.desired_stage, issues.desired_stage),
          desired_state_name = COALESCE(excluded.desired_state_name, issues.desired_state_name),
          desired_webhook_id = COALESCE(excluded.desired_webhook_id, issues.desired_webhook_id),
          desired_webhook_timestamp = COALESCE(excluded.desired_webhook_timestamp, issues.desired_webhook_timestamp),
          branch_name = COALESCE(excluded.branch_name, issues.branch_name),
          worktree_path = COALESCE(excluded.worktree_path, issues.worktree_path),
          active_run_id = COALESCE(excluded.active_run_id, issues.active_run_id),
          lease_owner = COALESCE(excluded.lease_owner, issues.lease_owner),
          lease_expires_at = COALESCE(excluded.lease_expires_at, issues.lease_expires_at),
          last_heartbeat_at = COALESCE(excluded.last_heartbeat_at, issues.last_heartbeat_at),
          last_webhook_at = excluded.last_webhook_at,
          updated_at = excluded.updated_at
        `,
      )
      .run(
        params.projectId,
        params.linearIssueId,
        params.linearIssueKey ?? null,
        params.title ?? null,
        params.issueUrl ?? null,
        params.currentState,
        params.activeStage ?? null,
        params.desiredStage ?? null,
        params.desiredStateName ?? null,
        params.desiredWebhookId ?? null,
        params.desiredWebhookTimestamp ?? null,
        params.branchName ?? null,
        params.worktreePath ?? null,
        params.activeRunId ?? null,
        params.leaseOwner ?? null,
        params.leaseExpiresAt ?? null,
        params.lastHeartbeatAt ?? null,
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

  listIssuesWithActiveRuns(): PersistedIssueRecord[] {
    const rows = this.connection
      .prepare("SELECT * FROM issues WHERE active_run_id IS NOT NULL OR current_state IN ('launching', 'running')")
      .all() as Record<string, unknown>[];
    return rows.map((row) => this.mapIssue(row));
  }

  listIssuesReadyForLaunch(): PersistedIssueRecord[] {
    const rows = this.connection
      .prepare("SELECT * FROM issues WHERE desired_stage IS NOT NULL AND active_run_id IS NULL")
      .all() as Record<string, unknown>[];
    return rows.map((row) => this.mapIssue(row));
  }

  updateIssueState(
    projectId: string,
    linearIssueId: string,
    state: IssueState,
    values: {
      branchName?: string;
      worktreePath?: string;
      activeRunId?: number | null;
      activeStage?: RunStage | null;
      leaseOwner?: string | null;
      leaseExpiresAt?: string | null;
      lastHeartbeatAt?: string | null;
    } = {},
  ): void {
    const current = this.getIssue(projectId, linearIssueId);
    if (!current) {
      return;
    }

    const now = isoNow();
    this.connection
      .prepare(
        `
        UPDATE issues
        SET current_state = ?, branch_name = ?, worktree_path = ?, active_run_id = ?, active_stage = ?, lease_owner = ?,
            lease_expires_at = ?, last_heartbeat_at = ?, updated_at = ?
        WHERE project_id = ? AND linear_issue_id = ?
        `,
      )
      .run(
        state,
        values.branchName ?? current.branchName ?? null,
        values.worktreePath ?? current.worktreePath ?? null,
        values.activeRunId ?? current.activeRunId ?? null,
        values.activeStage ?? current.activeStage ?? null,
        values.leaseOwner ?? current.leaseOwner ?? null,
        values.leaseExpiresAt ?? current.leaseExpiresAt ?? null,
        values.lastHeartbeatAt ?? current.lastHeartbeatAt ?? null,
        now,
        projectId,
        linearIssueId,
      );
  }

  recordDesiredStage(params: {
    projectId: string;
    linearIssueId: string;
    currentState: IssueState;
    linearIssueKey?: string;
    title?: string;
    issueUrl?: string;
    desiredStage?: RunStage;
    desiredStateName?: string;
    desiredWebhookId: string;
    desiredWebhookTimestamp: number;
    lastWebhookAt: string;
  }): PersistedIssueRecord {
    const transaction = this.connection.transaction(() => {
      const current = this.getIssue(params.projectId, params.linearIssueId);
      if (!current) {
        throw new Error(`Issue missing while recording desired stage: ${params.projectId}/${params.linearIssueId}`);
      }

      const currentTimestamp = current.desiredWebhookTimestamp ?? -1;
      if (current.desiredWebhookId && currentTimestamp > params.desiredWebhookTimestamp) {
        return current;
      }

      const nextState = current.activeRunId ? current.currentState : params.currentState;
      const now = isoNow();
      this.connection
        .prepare(
          `
          UPDATE issues
          SET linear_issue_key = COALESCE(?, linear_issue_key),
              title = COALESCE(?, title),
              issue_url = COALESCE(?, issue_url),
              current_state = ?,
              desired_stage = ?,
              desired_state_name = ?,
              desired_webhook_id = ?,
              desired_webhook_timestamp = ?,
              last_webhook_at = ?,
              updated_at = ?
          WHERE project_id = ? AND linear_issue_id = ?
          `,
        )
        .run(
          params.linearIssueKey ?? null,
          params.title ?? null,
          params.issueUrl ?? null,
          nextState,
          params.desiredStage ?? null,
          params.desiredStateName ?? null,
          params.desiredWebhookId,
          params.desiredWebhookTimestamp,
          params.lastWebhookAt,
          now,
          params.projectId,
          params.linearIssueId,
        );

      return this.getIssue(params.projectId, params.linearIssueId)!;
    });

    return transaction();
  }

  claimIssueLaunch(params: {
    projectId: string;
    linearIssueId: string;
    stage: RunStage;
    triggerWebhookId: string;
    branchName: string;
    worktreePath: string;
    leaseOwner: string;
    leaseDurationMs: number;
  }): { issue: PersistedIssueRecord; runId: number } | undefined {
    const transaction = this.connection.transaction(() => {
      const issue = this.getIssue(params.projectId, params.linearIssueId);
      if (!issue) {
        return undefined;
      }

      const leaseExpiresAtMs = parseIsoMs(issue.leaseExpiresAt);
      const leaseExpired = leaseExpiresAtMs !== undefined && leaseExpiresAtMs <= Date.now();
      if (issue.activeRunId && !leaseExpired) {
        return undefined;
      }

      if (issue.desiredStage !== params.stage || issue.desiredWebhookId !== params.triggerWebhookId) {
        return undefined;
      }

      const startedAt = isoNow();
      const runResult = this.connection
        .prepare(
          `
          INSERT INTO issue_runs (project_id, linear_issue_id, stage, status, started_at, trigger_webhook_id)
          VALUES (?, ?, ?, 'running', ?, ?)
          `,
        )
        .run(params.projectId, params.linearIssueId, params.stage, startedAt, params.triggerWebhookId);

      const runId = Number(runResult.lastInsertRowid);
      const leaseExpiresAt = isoFromMs(Date.now() + params.leaseDurationMs);
      this.connection
        .prepare(
          `
          UPDATE issues
          SET current_state = 'launching',
              active_stage = ?,
              branch_name = ?,
              worktree_path = ?,
              active_run_id = ?,
              lease_owner = ?,
              lease_expires_at = ?,
              last_heartbeat_at = ?,
              desired_stage = NULL,
              desired_state_name = NULL,
              desired_webhook_id = NULL,
              desired_webhook_timestamp = NULL,
              updated_at = ?
          WHERE project_id = ? AND linear_issue_id = ?
          `,
        )
        .run(
          params.stage,
          params.branchName,
          params.worktreePath,
          runId,
          params.leaseOwner,
          leaseExpiresAt,
          startedAt,
          startedAt,
          params.projectId,
          params.linearIssueId,
        );

      return {
        issue: this.getIssue(params.projectId, params.linearIssueId)!,
        runId,
      };
    });

    return transaction();
  }

  updateRunSessionId(runId: number, sessionId: number): void {
    this.connection.prepare("UPDATE issue_runs SET session_id = ? WHERE id = ?").run(sessionId, runId);
  }

  getIssueRun(runId: number): IssueRunRecord | undefined {
    const row = this.connection.prepare("SELECT * FROM issue_runs WHERE id = ?").get(runId) as Record<string, unknown> | undefined;
    return row ? this.mapIssueRun(row) : undefined;
  }

  finishIssueRun(params: {
    runId: number;
    status: RunStatus;
    resultJson?: string;
    errorJson?: string;
  }): void {
    const now = isoNow();
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
    const now = isoNow();
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

  getSession(sessionId: number): SessionRecord | undefined {
    const row = this.connection.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId) as Record<string, unknown> | undefined;
    return row ? this.mapSession(row) : undefined;
  }

  getSessionByRun(runId: number): SessionRecord | undefined {
    const row = this.connection.prepare("SELECT * FROM sessions WHERE run_id = ?").get(runId) as Record<string, unknown> | undefined;
    return row ? this.mapSession(row) : undefined;
  }

  finishSession(sessionId: number, exitCode: number): void {
    this.connection.prepare("UPDATE sessions SET ended_at = ?, exit_code = ? WHERE id = ?").run(isoNow(), exitCode, sessionId);
  }

  refreshIssueLease(params: {
    projectId: string;
    linearIssueId: string;
    runId: number;
    leaseOwner: string;
    leaseDurationMs: number;
    state?: IssueState;
  }): void {
    const current = this.getIssue(params.projectId, params.linearIssueId);
    if (!current || current.activeRunId !== params.runId) {
      return;
    }

    const now = isoNow();
    this.connection
      .prepare(
        `
        UPDATE issues
        SET current_state = ?, lease_owner = ?, lease_expires_at = ?, last_heartbeat_at = ?, updated_at = ?
        WHERE project_id = ? AND linear_issue_id = ? AND active_run_id = ?
        `,
      )
      .run(
        params.state ?? current.currentState,
        params.leaseOwner,
        isoFromMs(Date.now() + params.leaseDurationMs),
        now,
        now,
        params.projectId,
        params.linearIssueId,
        params.runId,
      );
  }

  clearActiveRun(params: {
    projectId: string;
    linearIssueId: string;
    runId?: number;
    nextState: IssueState;
  }): void {
    const current = this.getIssue(params.projectId, params.linearIssueId);
    if (!current) {
      return;
    }

    if (params.runId !== undefined && current.activeRunId !== params.runId) {
      return;
    }

    this.connection
      .prepare(
        `
        UPDATE issues
        SET current_state = ?, active_run_id = NULL, active_stage = NULL, lease_owner = NULL,
            lease_expires_at = NULL, last_heartbeat_at = NULL, updated_at = ?
        WHERE project_id = ? AND linear_issue_id = ?
        `,
      )
      .run(params.nextState, isoNow(), params.projectId, params.linearIssueId);
  }

  private mapIssue(row: Record<string, unknown>): PersistedIssueRecord {
    return {
      id: Number(row.id),
      projectId: String(row.project_id),
      linearIssueId: String(row.linear_issue_id),
      ...(row.linear_issue_key === null ? {} : { linearIssueKey: String(row.linear_issue_key) }),
      ...(row.title === null ? {} : { title: String(row.title) }),
      ...(row.issue_url === null ? {} : { issueUrl: String(row.issue_url) }),
      currentState: row.current_state as IssueState,
      ...(row.active_stage === null ? {} : { activeStage: row.active_stage as RunStage }),
      ...(row.desired_stage === null ? {} : { desiredStage: row.desired_stage as RunStage }),
      ...(row.desired_state_name === null ? {} : { desiredStateName: String(row.desired_state_name) }),
      ...(row.desired_webhook_id === null ? {} : { desiredWebhookId: String(row.desired_webhook_id) }),
      ...(row.desired_webhook_timestamp === null ? {} : { desiredWebhookTimestamp: Number(row.desired_webhook_timestamp) }),
      ...(row.branch_name === null ? {} : { branchName: String(row.branch_name) }),
      ...(row.worktree_path === null ? {} : { worktreePath: String(row.worktree_path) }),
      ...(row.active_run_id === null ? {} : { activeRunId: Number(row.active_run_id) }),
      ...(row.lease_owner === null ? {} : { leaseOwner: String(row.lease_owner) }),
      ...(row.lease_expires_at === null ? {} : { leaseExpiresAt: String(row.lease_expires_at) }),
      ...(row.last_heartbeat_at === null ? {} : { lastHeartbeatAt: String(row.last_heartbeat_at) }),
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

  private mapSession(row: Record<string, unknown>): SessionRecord {
    return {
      id: Number(row.id),
      projectId: String(row.project_id),
      linearIssueId: String(row.linear_issue_id),
      runId: Number(row.run_id),
      stage: row.stage as RunStage,
      zmxSessionName: String(row.zmx_session_name),
      ...(row.process_id === null ? {} : { processId: Number(row.process_id) }),
      branchName: String(row.branch_name),
      worktreePath: String(row.worktree_path),
      startedAt: String(row.started_at),
      ...(row.ended_at === null ? {} : { endedAt: String(row.ended_at) }),
      ...(row.exit_code === null ? {} : { exitCode: Number(row.exit_code) }),
    };
  }
}
