import type { IssueRecord, IssueSessionEventRecord, IssueSessionRecord, RunStatus } from "../db-types.ts";
import type { RunType } from "../factory-state.ts";
import type { IssueStore, UpsertIssueParams } from "./issue-store.ts";
import type { RunStore } from "./run-store.ts";
import { deriveSessionWakePlan, type IssueSessionEventType } from "../issue-session-events.ts";
import { isoNow, type DatabaseConnection } from "./shared.ts";

interface IssueSessionLease {
  projectId: string;
  linearIssueId: string;
  leaseId: string;
}

export class IssueSessionStore {
  constructor(
    private readonly connection: DatabaseConnection,
    private readonly mapIssueSessionRow: (row: Record<string, unknown>) => IssueSessionRecord,
    private readonly mapIssueSessionEventRow: (row: Record<string, unknown>) => IssueSessionEventRecord,
    private readonly issues: IssueStore,
    private readonly runs: RunStore,
    private readonly deriveImplicitReactiveWake: (issue: IssueRecord) => {
      runType: RunType;
      wakeReason: string;
      context: Record<string, unknown>;
    } | undefined,
  ) {}

  getIssueSession(projectId: string, linearIssueId: string): IssueSessionRecord | undefined {
    const row = this.connection
      .prepare("SELECT * FROM issue_sessions WHERE project_id = ? AND linear_issue_id = ?")
      .get(projectId, linearIssueId) as Record<string, unknown> | undefined;
    return row ? this.mapIssueSessionRow(row) : undefined;
  }

  getIssueSessionByKey(issueKey: string): IssueSessionRecord | undefined {
    const row = this.connection.prepare("SELECT * FROM issue_sessions WHERE issue_key = ?").get(issueKey) as Record<string, unknown> | undefined;
    return row ? this.mapIssueSessionRow(row) : undefined;
  }

  appendIssueSessionEvent(params: {
    projectId: string;
    linearIssueId: string;
    eventType: IssueSessionEventType;
    eventJson?: string | undefined;
    dedupeKey?: string | undefined;
  }): IssueSessionEventRecord {
    if (params.dedupeKey) {
      const existing = this.connection.prepare(`
        SELECT * FROM issue_session_events
        WHERE project_id = ? AND linear_issue_id = ? AND dedupe_key = ? AND processed_at IS NULL
        ORDER BY id DESC LIMIT 1
      `).get(params.projectId, params.linearIssueId, params.dedupeKey) as Record<string, unknown> | undefined;
      if (existing) return this.mapIssueSessionEventRow(existing);
    }

    const now = isoNow();
    const result = this.connection.prepare(`
      INSERT INTO issue_session_events (
        project_id, linear_issue_id, event_type, event_json, dedupe_key, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      params.projectId,
      params.linearIssueId,
      params.eventType,
      params.eventJson ?? null,
      params.dedupeKey ?? null,
      now,
    );
    return this.getIssueSessionEvent(Number(result.lastInsertRowid))!;
  }

  appendIssueSessionEventWithLease(
    lease: IssueSessionLease,
    params: {
      projectId: string;
      linearIssueId: string;
      eventType: IssueSessionEventType;
      eventJson?: string | undefined;
      dedupeKey?: string | undefined;
    },
  ): IssueSessionEventRecord | undefined {
    return this.withIssueSessionLease(lease.projectId, lease.linearIssueId, lease.leaseId, () => this.appendIssueSessionEvent(params));
  }

  appendIssueSessionEventRespectingActiveLease(
    projectId: string,
    linearIssueId: string,
    params: {
      projectId: string;
      linearIssueId: string;
      eventType: IssueSessionEventType;
      eventJson?: string | undefined;
      dedupeKey?: string | undefined;
    },
  ): IssueSessionEventRecord | undefined {
    const lease = this.getActiveIssueSessionLease(projectId, linearIssueId);
    if (!lease) {
      return this.appendIssueSessionEvent(params);
    }
    return this.appendIssueSessionEventWithLease(lease, params);
  }

  getIssueSessionEvent(id: number): IssueSessionEventRecord | undefined {
    const row = this.connection.prepare("SELECT * FROM issue_session_events WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? this.mapIssueSessionEventRow(row) : undefined;
  }

  listIssueSessionEvents(
    projectId: string,
    linearIssueId: string,
    options?: { pendingOnly?: boolean; limit?: number },
  ): IssueSessionEventRecord[] {
    const conditions = ["project_id = ?", "linear_issue_id = ?"];
    const values: Array<string | number> = [projectId, linearIssueId];
    if (options?.pendingOnly) {
      conditions.push("processed_at IS NULL");
    }
    let query = `SELECT * FROM issue_session_events WHERE ${conditions.join(" AND ")} ORDER BY id`;
    if (options?.limit !== undefined) {
      query += " LIMIT ?";
      values.push(options.limit);
    }
    const rows = this.connection.prepare(query).all(...values) as Array<Record<string, unknown>>;
    return rows.map(this.mapIssueSessionEventRow);
  }

  consumeIssueSessionEvents(projectId: string, linearIssueId: string, eventIds: number[], runId: number): void {
    if (eventIds.length === 0) return;
    const now = isoNow();
    const placeholders = eventIds.map(() => "?").join(", ");
    this.connection.prepare(`
      UPDATE issue_session_events
      SET processed_at = ?, consumed_by_run_id = ?
      WHERE project_id = ? AND linear_issue_id = ? AND id IN (${placeholders}) AND processed_at IS NULL
    `).run(now, runId, projectId, linearIssueId, ...eventIds);
  }

  clearPendingIssueSessionEvents(projectId: string, linearIssueId: string): void {
    this.connection.prepare(`
      UPDATE issue_session_events
      SET processed_at = ?, consumed_by_run_id = NULL
      WHERE project_id = ? AND linear_issue_id = ? AND processed_at IS NULL
    `).run(isoNow(), projectId, linearIssueId);
  }

  hasPendingIssueSessionEvents(projectId: string, linearIssueId: string): boolean {
    const row = this.connection.prepare(`
      SELECT 1
      FROM issue_session_events
      WHERE project_id = ? AND linear_issue_id = ? AND processed_at IS NULL
      LIMIT 1
    `).get(projectId, linearIssueId) as Record<string, unknown> | undefined;
    return row !== undefined;
  }

  peekIssueSessionWake(projectId: string, linearIssueId: string): {
    eventIds: number[];
    runType: RunType;
    context: Record<string, unknown>;
    wakeReason?: string | undefined;
    resumeThread: boolean;
  } | undefined {
    const issue = this.issues.getIssue(projectId, linearIssueId);
    if (!issue) return undefined;
    const events = this.listIssueSessionEvents(projectId, linearIssueId, { pendingOnly: true });
    const plan = deriveSessionWakePlan(issue, events);
    if (plan?.runType) {
      return {
        eventIds: events.map((event) => event.id),
        runType: plan.runType,
        context: plan.context,
        ...(plan.wakeReason ? { wakeReason: plan.wakeReason } : {}),
        resumeThread: plan.resumeThread,
      };
    }
    const implicitWake = this.deriveImplicitReactiveWake(issue);
    if (!implicitWake) return undefined;
    return {
      eventIds: [],
      runType: implicitWake.runType,
      context: implicitWake.context,
      wakeReason: implicitWake.wakeReason,
      resumeThread: false,
    };
  }

  acquireIssueSessionLease(params: {
    projectId: string;
    linearIssueId: string;
    leaseId: string;
    workerId: string;
    leasedUntil: string;
    now?: string;
  }): boolean {
    const now = params.now ?? isoNow();
    const result = this.connection.prepare(`
      UPDATE issue_sessions
      SET lease_id = ?, worker_id = ?, leased_until = ?, updated_at = ?
      WHERE project_id = ? AND linear_issue_id = ?
        AND (leased_until IS NULL OR leased_until <= ? OR lease_id = ?)
    `).run(
      params.leaseId,
      params.workerId,
      params.leasedUntil,
      now,
      params.projectId,
      params.linearIssueId,
      now,
      params.leaseId,
    );
    return Number(result.changes ?? 0) > 0;
  }

  forceAcquireIssueSessionLease(params: {
    projectId: string;
    linearIssueId: string;
    leaseId: string;
    workerId: string;
    leasedUntil: string;
    now?: string;
  }): boolean {
    const now = params.now ?? isoNow();
    const result = this.connection.prepare(`
      UPDATE issue_sessions
      SET lease_id = ?, worker_id = ?, leased_until = ?, updated_at = ?
      WHERE project_id = ? AND linear_issue_id = ?
    `).run(
      params.leaseId,
      params.workerId,
      params.leasedUntil,
      now,
      params.projectId,
      params.linearIssueId,
    );
    return Number(result.changes ?? 0) > 0;
  }

  renewIssueSessionLease(params: {
    projectId: string;
    linearIssueId: string;
    leaseId: string;
    leasedUntil: string;
    now?: string;
  }): boolean {
    const now = params.now ?? isoNow();
    const result = this.connection.prepare(`
      UPDATE issue_sessions
      SET leased_until = ?, updated_at = ?
      WHERE project_id = ? AND linear_issue_id = ? AND lease_id = ?
    `).run(
      params.leasedUntil,
      now,
      params.projectId,
      params.linearIssueId,
      params.leaseId,
    );
    return Number(result.changes ?? 0) > 0;
  }

  releaseIssueSessionLease(projectId: string, linearIssueId: string, leaseId?: string): void {
    this.connection.prepare(`
      UPDATE issue_sessions
      SET lease_id = NULL, worker_id = NULL, leased_until = NULL, updated_at = ?
      WHERE project_id = ? AND linear_issue_id = ? AND (? IS NULL OR lease_id = ?)
    `).run(isoNow(), projectId, linearIssueId, leaseId ?? null, leaseId ?? null);
  }

  releaseExpiredIssueSessionLeases(now = isoNow()): void {
    this.connection.prepare(`
      UPDATE issue_sessions
      SET lease_id = NULL, worker_id = NULL, leased_until = NULL, updated_at = ?
      WHERE leased_until IS NOT NULL AND leased_until <= ?
    `).run(now, now);
  }

  hasActiveIssueSessionLease(projectId: string, linearIssueId: string, leaseId: string, now = isoNow()): boolean {
    const row = this.connection.prepare(`
      SELECT 1
      FROM issue_sessions
      WHERE project_id = ? AND linear_issue_id = ? AND lease_id = ?
        AND leased_until IS NOT NULL
        AND leased_until > ?
      LIMIT 1
    `).get(projectId, linearIssueId, leaseId, now) as Record<string, unknown> | undefined;
    return row !== undefined;
  }

  getActiveIssueSessionLease(projectId: string, linearIssueId: string, now = isoNow()): IssueSessionLease | undefined {
    const row = this.connection.prepare(`
      SELECT lease_id
      FROM issue_sessions
      WHERE project_id = ? AND linear_issue_id = ?
        AND lease_id IS NOT NULL
        AND leased_until IS NOT NULL
        AND leased_until > ?
      LIMIT 1
    `).get(projectId, linearIssueId, now) as Record<string, unknown> | undefined;
    const leaseId = typeof row?.lease_id === "string" ? row.lease_id : undefined;
    if (!leaseId) return undefined;
    return { projectId, linearIssueId, leaseId };
  }

  withIssueSessionLease<T>(projectId: string, linearIssueId: string, leaseId: string, fn: () => T): T | undefined {
    return this.connection.transaction(() => {
      if (!this.hasActiveIssueSessionLease(projectId, linearIssueId, leaseId)) {
        return undefined;
      }
      return fn();
    })();
  }

  upsertIssueWithLease(lease: IssueSessionLease, params: UpsertIssueParams): IssueRecord | undefined {
    return this.withIssueSessionLease(lease.projectId, lease.linearIssueId, lease.leaseId, () => this.issues.upsertIssue(params));
  }

  upsertIssueRespectingActiveLease(projectId: string, linearIssueId: string, params: UpsertIssueParams): IssueRecord | undefined {
    const lease = this.getActiveIssueSessionLease(projectId, linearIssueId);
    if (!lease) {
      return this.issues.upsertIssue(params);
    }
    return this.upsertIssueWithLease(lease, params);
  }

  finishRunWithLease(lease: IssueSessionLease, runId: number, params: {
    status: RunStatus;
    threadId?: string;
    turnId?: string;
    failureReason?: string;
    summaryJson?: string;
    reportJson?: string;
  }): boolean {
    return this.withIssueSessionLease(lease.projectId, lease.linearIssueId, lease.leaseId, () => {
      this.runs.finishRun(runId, params);
      return true;
    }) ?? false;
  }

  finishRunRespectingActiveLease(projectId: string, linearIssueId: string, runId: number, params: {
    status: RunStatus;
    threadId?: string;
    turnId?: string;
    failureReason?: string;
    summaryJson?: string;
    reportJson?: string;
  }): boolean {
    const lease = this.getActiveIssueSessionLease(projectId, linearIssueId);
    if (!lease) {
      this.runs.finishRun(runId, params);
      return true;
    }
    return this.finishRunWithLease(lease, runId, params);
  }

  updateRunThreadWithLease(lease: IssueSessionLease, runId: number, params: { threadId: string; parentThreadId?: string; turnId?: string }): boolean {
    return this.withIssueSessionLease(lease.projectId, lease.linearIssueId, lease.leaseId, () => {
      this.runs.updateRunThread(runId, params);
      return true;
    }) ?? false;
  }

  consumeIssueSessionEventsWithLease(lease: IssueSessionLease, eventIds: number[], runId: number): boolean {
    return this.withIssueSessionLease(lease.projectId, lease.linearIssueId, lease.leaseId, () => {
      this.consumeIssueSessionEvents(lease.projectId, lease.linearIssueId, eventIds, runId);
      return true;
    }) ?? false;
  }

  clearPendingIssueSessionEventsWithLease(lease: IssueSessionLease): boolean {
    return this.withIssueSessionLease(lease.projectId, lease.linearIssueId, lease.leaseId, () => {
      this.clearPendingIssueSessionEvents(lease.projectId, lease.linearIssueId);
      return true;
    }) ?? false;
  }

  clearPendingIssueSessionEventsRespectingActiveLease(projectId: string, linearIssueId: string): boolean {
    const lease = this.getActiveIssueSessionLease(projectId, linearIssueId);
    if (!lease) {
      this.clearPendingIssueSessionEvents(projectId, linearIssueId);
      return true;
    }
    return this.clearPendingIssueSessionEventsWithLease(lease);
  }

  setIssueSessionLastWakeReasonWithLease(lease: IssueSessionLease, lastWakeReason?: string | null): boolean {
    return this.withIssueSessionLease(lease.projectId, lease.linearIssueId, lease.leaseId, () => {
      this.setIssueSessionLastWakeReason(lease.projectId, lease.linearIssueId, lastWakeReason);
      return true;
    }) ?? false;
  }

  setIssueSessionLastWakeReason(projectId: string, linearIssueId: string, lastWakeReason?: string | null): void {
    this.connection.prepare(`
      UPDATE issue_sessions
      SET last_wake_reason = ?, updated_at = ?
      WHERE project_id = ? AND linear_issue_id = ?
    `).run(lastWakeReason ?? null, isoNow(), projectId, linearIssueId);
  }

  releaseIssueSessionLeaseRespectingActiveLease(projectId: string, linearIssueId: string): void {
    const lease = this.getActiveIssueSessionLease(projectId, linearIssueId);
    this.releaseIssueSessionLease(projectId, linearIssueId, lease?.leaseId);
  }
}
