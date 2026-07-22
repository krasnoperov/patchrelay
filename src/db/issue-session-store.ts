import type { IssueRecord, IssueSessionEventRecord, IssueSessionRecord, RunStatus } from "../db-types.ts";
import type { RunType } from "../run-type.ts";
import type { IssueSessionProjectionInvalidator } from "../issue-session-projection-invalidator.ts";
import type { IssueStore, UpsertIssueParams } from "./issue-store.ts";
import type { RunStore } from "./run-store.ts";
import { deriveSessionInputPlan, isActionableIssueSessionEventType, type IssueSessionEventType } from "../issue-session-events.ts";
import { mergeRequestedChangesEventJson, readRequestedChangesCoalesceKey } from "../reactive-workflow-keys.ts";
import type { RunContext } from "../run-context.ts";
import { emitTelemetry, noopTelemetry, type PatchRelayTelemetry } from "../telemetry.ts";
import { isoNow, type DatabaseConnection } from "./shared.ts";

interface IssueSessionLease {
  projectId: string;
  linearIssueId: string;
  leaseId: string;
}

export interface CommitIssueStateParams {
  /** Identifies the writer in conflict telemetry (e.g. "github-webhook-state-projector"). */
  writer: string;
  update: UpsertIssueParams;
  /**
   * Version of the issue row the update was derived from: a number for an
   * existing row, `null` when the writer believes the issue does not exist
   * yet, `undefined` for an unconditional write (update derives from external
   * facts, not from a prior read).
   */
  expectedVersion?: number | null | undefined;
  /** When the caller holds a lease, the write is denied if it is no longer valid. */
  lease?: IssueSessionLease | undefined;
  /**
   * Recompute the update against the fresh row after a version conflict.
   * Return the recomputed params to apply them, or `undefined` to skip the
   * write (the concurrent writer's state is newer truth). Without this
   * callback a conflicted write is applied anyway — current clobber behavior,
   * but now observable via `state.write_conflict` telemetry.
   */
  onConflict?: ((current: IssueRecord) => UpsertIssueParams | undefined) | undefined;
}

export type CommitIssueStateResult =
  | { outcome: "applied"; issue: IssueRecord; conflicted: boolean }
  | { outcome: "conflict_skipped"; issue: IssueRecord | undefined }
  | { outcome: "lease_denied" };

export class IssueSessionStore {
  constructor(
    private readonly connection: DatabaseConnection,
    private readonly mapIssueSessionRow: (row: Record<string, unknown>) => IssueSessionRecord,
    private readonly mapIssueSessionEventRow: (row: Record<string, unknown>) => IssueSessionEventRecord,
    private readonly issues: IssueStore,
    private readonly runs: RunStore,
    private readonly issueSessionProjection: IssueSessionProjectionInvalidator,
    private readonly telemetry: PatchRelayTelemetry = noopTelemetry,
  ) {}

  getIssueSession(projectId: string, linearIssueId: string): IssueSessionRecord | undefined {
    this.issueSessionProjection.assertNotMidBatch?.("getIssueSession");
    const row = this.connection
      .prepare(`
        SELECT
          s.*,
          t.active_thread_id AS projected_active_thread_id,
          t.thread_generation AS projected_thread_generation,
          l.lease_id AS active_lease_id,
          l.worker_id AS active_worker_id,
          l.leased_until AS active_leased_until
        FROM issue_sessions s
        LEFT JOIN issue_session_threads t
          ON t.project_id = s.project_id
         AND t.linear_issue_id = s.linear_issue_id
        LEFT JOIN issue_session_leases l
          ON l.project_id = s.project_id
         AND l.linear_issue_id = s.linear_issue_id
        WHERE s.project_id = ? AND s.linear_issue_id = ?
      `)
      .get(projectId, linearIssueId) as Record<string, unknown> | undefined;
    return row ? this.mapIssueSessionRow(row) : undefined;
  }

  getIssueSessionByKey(issueKey: string): IssueSessionRecord | undefined {
    const row = this.connection.prepare(`
      SELECT
        s.*,
        t.active_thread_id AS projected_active_thread_id,
        t.thread_generation AS projected_thread_generation,
        l.lease_id AS active_lease_id,
        l.worker_id AS active_worker_id,
        l.leased_until AS active_leased_until
      FROM issue_sessions s
      LEFT JOIN issue_session_threads t
        ON t.project_id = s.project_id
       AND t.linear_issue_id = s.linear_issue_id
      LEFT JOIN issue_session_leases l
        ON l.project_id = s.project_id
       AND l.linear_issue_id = s.linear_issue_id
      WHERE s.issue_key = ?
    `).get(issueKey) as Record<string, unknown> | undefined;
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
      if (existing) {
        this.issueSessionProjection.issueSessionEventsChanged(params.projectId, params.linearIssueId);
        return this.mapIssueSessionEventRow(existing);
      }
    }
    const coalesced = this.coalescePendingRequestedChangesEvent(params);
    if (coalesced) {
      this.issueSessionProjection.issueSessionEventsChanged(params.projectId, params.linearIssueId);
      return coalesced;
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
    const event = this.getIssueSessionEvent(Number(result.lastInsertRowid))!;
    this.issueSessionProjection.issueSessionEventsChanged(params.projectId, params.linearIssueId);
    return event;
  }

  private coalescePendingRequestedChangesEvent(params: {
    projectId: string;
    linearIssueId: string;
    eventType: IssueSessionEventType;
    eventJson?: string | undefined;
    dedupeKey?: string | undefined;
  }): IssueSessionEventRecord | undefined {
    if (params.eventType !== "review_changes_requested") return undefined;
    const coalesceKey = readRequestedChangesCoalesceKey(params.eventJson);
    if (!coalesceKey) return undefined;
    const existing = this.listIssueSessionEvents(params.projectId, params.linearIssueId, { pendingOnly: true })
      .filter((event) => event.eventType === "review_changes_requested")
      .find((event) => readRequestedChangesCoalesceKey(event.eventJson) === coalesceKey);
    if (!existing) return undefined;

    const mergedJson = mergeRequestedChangesEventJson(existing.eventJson, params.eventJson);
    if (mergedJson !== existing.eventJson) {
      this.connection.prepare(`
        UPDATE issue_session_events
        SET event_json = ?
        WHERE id = ? AND processed_at IS NULL
      `).run(mergedJson ?? null, existing.id);
    }
    return this.getIssueSessionEvent(existing.id) ?? existing;
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
    this.issueSessionProjection.issueSessionEventsChanged(projectId, linearIssueId);
    const issue = this.issues.getIssue(projectId, linearIssueId);
    emitTelemetry(this.telemetry, {
      type: "dispatch.consumed",
      projectId,
      linearIssueId,
      ...(issue?.issueKey ? { issueKey: issue.issueKey } : {}),
      eventIds,
      runId,
    });
  }

  dismissIssueSessionEvents(projectId: string, linearIssueId: string, eventIds: number[]): void {
    if (eventIds.length === 0) return;
    const placeholders = eventIds.map(() => "?").join(", ");
    this.connection.prepare(`
      UPDATE issue_session_events
      SET processed_at = ?, consumed_by_run_id = NULL
      WHERE project_id = ? AND linear_issue_id = ? AND id IN (${placeholders}) AND processed_at IS NULL
    `).run(isoNow(), projectId, linearIssueId, ...eventIds);
    this.issueSessionProjection.issueSessionEventsChanged(projectId, linearIssueId);
    const issue = this.issues.getIssue(projectId, linearIssueId);
    emitTelemetry(this.telemetry, {
      type: "dispatch.dismissed",
      projectId,
      linearIssueId,
      ...(issue?.issueKey ? { issueKey: issue.issueKey } : {}),
      eventIds,
      reason: "dismissed",
    });
  }

  clearPendingIssueSessionEvents(projectId: string, linearIssueId: string): void {
    const eventIds = this.listIssueSessionEvents(projectId, linearIssueId, { pendingOnly: true }).map((event) => event.id);
    this.connection.prepare(`
      UPDATE issue_session_events
      SET processed_at = ?, consumed_by_run_id = NULL
      WHERE project_id = ? AND linear_issue_id = ? AND processed_at IS NULL
    `).run(isoNow(), projectId, linearIssueId);
    this.issueSessionProjection.issueSessionEventsChanged(projectId, linearIssueId);
    const issue = this.issues.getIssue(projectId, linearIssueId);
    emitTelemetry(this.telemetry, {
      type: "dispatch.dismissed",
      projectId,
      linearIssueId,
      ...(issue?.issueKey ? { issueKey: issue.issueKey } : {}),
      eventIds,
      reason: "cleared_pending",
    });
  }

  hasPendingIssueSessionEvents(projectId: string, linearIssueId: string): boolean {
    return this.listIssueSessionEvents(projectId, linearIssueId, { pendingOnly: true })
      .some((event) => isActionableIssueSessionEventType(event.eventType));
  }

  peekPendingSessionInputPlanForDiagnostics(projectId: string, linearIssueId: string): {
    eventIds: number[];
    runType: RunType;
    context: RunContext;
    workflowReason?: string | undefined;
    resumeThread: boolean;
  } | undefined {
    const issue = this.issues.getIssue(projectId, linearIssueId);
    if (!issue) return undefined;
    const events = this.listIssueSessionEvents(projectId, linearIssueId, { pendingOnly: true });
    const plan = deriveSessionInputPlan(issue, events);
    if (plan?.runType) {
      return {
        eventIds: plan.eventIds,
        runType: plan.runType,
        context: plan.context,
        ...(plan.workflowReason ? { workflowReason: plan.workflowReason } : {}),
        resumeThread: plan.resumeThread,
      };
    }
    return undefined;
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
      INSERT INTO issue_session_leases (
        project_id, linear_issue_id, lease_id, worker_id, leased_until, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id, linear_issue_id) DO UPDATE SET
        lease_id = excluded.lease_id,
        worker_id = excluded.worker_id,
        leased_until = excluded.leased_until,
        updated_at = excluded.updated_at
      WHERE issue_session_leases.leased_until <= ?
         OR issue_session_leases.lease_id = ?
    `).run(
      params.projectId,
      params.linearIssueId,
      params.leaseId,
      params.workerId,
      params.leasedUntil,
      now,
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
      INSERT INTO issue_session_leases (
        project_id, linear_issue_id, lease_id, worker_id, leased_until, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id, linear_issue_id) DO UPDATE SET
        lease_id = excluded.lease_id,
        worker_id = excluded.worker_id,
        leased_until = excluded.leased_until,
        updated_at = excluded.updated_at
    `).run(
      params.projectId,
      params.linearIssueId,
      params.leaseId,
      params.workerId,
      params.leasedUntil,
      now,
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
      UPDATE issue_session_leases
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
      DELETE FROM issue_session_leases
      WHERE project_id = ? AND linear_issue_id = ? AND (? IS NULL OR lease_id = ?)
    `).run(projectId, linearIssueId, leaseId ?? null, leaseId ?? null);
  }

  releaseExpiredIssueSessionLeases(now = isoNow()): void {
    this.connection.prepare(`
      DELETE FROM issue_session_leases
      WHERE leased_until <= ?
    `).run(now);
  }

  hasActiveIssueSessionLease(projectId: string, linearIssueId: string, leaseId: string, now = isoNow()): boolean {
    const row = this.connection.prepare(`
      SELECT 1
      FROM issue_session_leases
      WHERE project_id = ? AND linear_issue_id = ? AND lease_id = ?
        AND leased_until > ?
      LIMIT 1
    `).get(projectId, linearIssueId, leaseId, now) as Record<string, unknown> | undefined;
    return row !== undefined;
  }

  getActiveIssueSessionLease(projectId: string, linearIssueId: string, now = isoNow()): IssueSessionLease | undefined {
    const row = this.connection.prepare(`
      SELECT lease_id
      FROM issue_session_leases
      WHERE project_id = ? AND linear_issue_id = ?
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

  /**
   * The single door for issue-state writes (core simplification plan, phase
   * A): one transaction wrapping lease validity, an optimistic version check
   * against the row the update was derived from, and the write itself. A
   * version mismatch means another writer landed between the caller's read
   * and this commit — emitted as `state.write_conflict` telemetry and either
   * recomputed via `onConflict`, skipped, or applied anyway (see params).
   */
  commitIssueState(params: CommitIssueStateParams): CommitIssueStateResult {
    return this.connection.transaction((): CommitIssueStateResult => {
      const { projectId, linearIssueId } = params.update;
      if (params.lease && !this.hasActiveIssueSessionLease(projectId, linearIssueId, params.lease.leaseId)) {
        return { outcome: "lease_denied" };
      }
      const current = this.issues.getIssue(projectId, linearIssueId);
      const actualVersion = current?.version ?? null;
      if (params.expectedVersion === undefined || actualVersion === params.expectedVersion) {
        return { outcome: "applied", issue: this.issues.upsertIssue(params.update), conflicted: false };
      }

      const emitConflict = (resolution: "recomputed" | "skipped" | "applied_anyway") => {
        emitTelemetry(this.telemetry, {
          type: "state.write_conflict",
          projectId,
          linearIssueId,
          ...(current?.issueKey ? { issueKey: current.issueKey } : {}),
          writer: params.writer,
          expectedVersion: params.expectedVersion ?? null,
          actualVersion,
          resolution,
        });
      };

      if (params.onConflict && current) {
        const recomputed = params.onConflict(current);
        if (!recomputed) {
          emitConflict("skipped");
          return { outcome: "conflict_skipped", issue: current };
        }
        emitConflict("recomputed");
        return { outcome: "applied", issue: this.issues.upsertIssue(recomputed), conflicted: true };
      }

      emitConflict("applied_anyway");
      return { outcome: "applied", issue: this.issues.upsertIssue(params.update), conflicted: true };
    })();
  }

  finishRunWithLease(lease: IssueSessionLease, runId: number, params: {
    status: RunStatus;
    threadId?: string;
    turnId?: string;
    failureReason?: string;
    summaryJson?: string;
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

  dismissIssueSessionEventsWithLease(lease: IssueSessionLease, eventIds: number[]): boolean {
    return this.withIssueSessionLease(lease.projectId, lease.linearIssueId, lease.leaseId, () => {
      this.dismissIssueSessionEvents(lease.projectId, lease.linearIssueId, eventIds);
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

  setIssueSessionLastWorkflowReasonWithLease(lease: IssueSessionLease, lastWorkflowReason?: string | null): boolean {
    return this.withIssueSessionLease(lease.projectId, lease.linearIssueId, lease.leaseId, () => {
      this.setIssueSessionLastWorkflowReason(lease.projectId, lease.linearIssueId, lastWorkflowReason);
      return true;
    }) ?? false;
  }

  setIssueSessionLastWorkflowReason(projectId: string, linearIssueId: string, lastWorkflowReason?: string | null): void {
    this.connection.prepare(`
      UPDATE issue_sessions
      SET last_workflow_reason = ?, updated_at = ?
      WHERE project_id = ? AND linear_issue_id = ?
    `).run(lastWorkflowReason ?? null, isoNow(), projectId, linearIssueId);
  }

  releaseIssueSessionLeaseRespectingActiveLease(projectId: string, linearIssueId: string): void {
    const lease = this.getActiveIssueSessionLease(projectId, linearIssueId);
    this.releaseIssueSessionLease(projectId, linearIssueId, lease?.leaseId);
  }

  /**
   * Raw rows for the tracked-issue read model: one row per issue session joined
   * to its issue, active/latest run, pending session-event count, and blocker
   * rollup. Row shaping into the read model lives in the query layer; this owns
   * only the SQL so schema knowledge stays in the persistence layer.
   */
  listTrackedIssueRows(): Array<Record<string, unknown>> {
    return this.connection
      .prepare(
        `SELECT
          s.project_id, s.linear_issue_id, s.issue_key, i.title,
          i.current_linear_state, i.current_linear_state_type, i.delegated_to_patchrelay,
          i.workflow_outcome, i.input_request_kind, i.pr_is_draft, i.last_github_failure_source, i.deploy_started_at,
          s.session_state, s.waiting_reason, s.summary_text, s.display_updated_at,
          i.orchestration_settle_until,
          i.pr_number, i.pr_state, i.pr_head_sha, i.pr_review_state, i.pr_check_status, i.last_blocking_review_head_sha,
          i.last_github_ci_snapshot_json,
          i.last_github_failure_source,
          i.last_github_failure_head_sha,
          i.last_github_failure_check_name,
          i.last_github_failure_context_json,
          active_run.run_type AS active_run_type,
          active_run.status AS active_run_status,
          active_run.completion_check_thread_id AS active_completion_check_thread_id,
          active_run.completion_check_outcome AS active_completion_check_outcome,
          latest_run.run_type AS latest_run_type,
          latest_run.status AS latest_run_status,
          latest_run.summary_json AS latest_run_summary_json,
          latest_run.completion_check_thread_id AS latest_run_completion_check_thread_id,
          latest_run.completion_check_outcome AS latest_run_completion_check_outcome,
          latest_run.completion_check_summary AS latest_run_completion_check_summary,
          latest_run.completion_check_question AS latest_run_completion_check_question,
          latest_run.completion_check_why AS latest_run_completion_check_why,
          latest_run.completion_check_recommended_reply AS latest_run_completion_check_recommended_reply,
          (
            SELECT COUNT(*)
            FROM issue_session_events e
            WHERE e.project_id = s.project_id
              AND e.linear_issue_id = s.linear_issue_id
              AND e.processed_at IS NULL
          ) AS pending_session_event_count,
          (
            SELECT COUNT(*)
            FROM issue_dependencies d
            LEFT JOIN issues blockers
              ON blockers.project_id = d.project_id
             AND blockers.linear_issue_id = d.blocker_linear_issue_id
            WHERE d.project_id = s.project_id
              AND d.linear_issue_id = s.linear_issue_id
              AND (
                COALESCE(blockers.current_linear_state_type, d.blocker_current_linear_state_type, '') != 'completed'
                AND LOWER(TRIM(COALESCE(blockers.current_linear_state, d.blocker_current_linear_state, ''))) != 'done'
              )
          ) AS blocked_by_count,
          (
            SELECT json_group_array(COALESCE(blockers.issue_key, d.blocker_issue_key, d.blocker_linear_issue_id))
            FROM issue_dependencies d
            LEFT JOIN issues blockers
              ON blockers.project_id = d.project_id
             AND blockers.linear_issue_id = d.blocker_linear_issue_id
            WHERE d.project_id = s.project_id
              AND d.linear_issue_id = s.linear_issue_id
              AND (
                COALESCE(blockers.current_linear_state_type, d.blocker_current_linear_state_type, '') != 'completed'
                AND LOWER(TRIM(COALESCE(blockers.current_linear_state, d.blocker_current_linear_state, ''))) != 'done'
              )
          ) AS blocked_by_keys_json
        FROM issue_sessions s
        LEFT JOIN issues i
          ON i.project_id = s.project_id
         AND i.linear_issue_id = s.linear_issue_id
        LEFT JOIN runs active_run ON active_run.id = COALESCE(s.active_run_id, i.active_run_id)
        LEFT JOIN runs latest_run ON latest_run.id = (
          SELECT r.id FROM runs r
          WHERE r.project_id = s.project_id AND r.linear_issue_id = s.linear_issue_id
          ORDER BY r.id DESC LIMIT 1
        )
        ORDER BY s.display_updated_at DESC, s.issue_key ASC`,
      )
      .all() as Array<Record<string, unknown>>;
  }
}
