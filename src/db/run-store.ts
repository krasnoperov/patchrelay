import type { IssueRecord, RunRecord, RunStatus, ThreadEventRecord } from "../db-types.ts";
import type { CompletionCheckResult } from "../completion-check-types.ts";
import type { RunType } from "../factory-state.ts";
import type { IssueSessionProjectionInvalidator, IssueSessionProjectionOptions } from "../issue-session-projection-invalidator.ts";
import { extractLatestAssistantSummary } from "../issue-session-events.ts";
import { emitTelemetry, noopTelemetry, type PatchRelayTelemetry } from "../telemetry.ts";
import type { IssueStore } from "./issue-store.ts";
import { isoNow, type DatabaseConnection } from "./shared.ts";

export class RunStore {
  constructor(
    private readonly connection: DatabaseConnection,
    private readonly mapRunRow: (row: Record<string, unknown>) => RunRecord,
    private readonly issues: IssueStore,
    private readonly issueSessionProjection: IssueSessionProjectionInvalidator,
    private readonly telemetry: PatchRelayTelemetry = noopTelemetry,
  ) {}

  private projectIssueRun(issue: IssueRecord, options?: IssueSessionProjectionOptions): void {
    this.issueSessionProjection.issueRunChanged(issue, options);
  }

  createRun(params: {
    issueId: number;
    projectId: string;
    linearIssueId: string;
    runType: RunType;
    sourceHeadSha?: string;
    promptText?: string;
  }): RunRecord {
    const now = isoNow();
    const result = this.connection.prepare(`
      INSERT INTO runs (issue_id, project_id, linear_issue_id, run_type, status, source_head_sha, prompt_text, started_at)
      VALUES (?, ?, ?, ?, 'queued', ?, ?, ?)
    `).run(
      params.issueId,
      params.projectId,
      params.linearIssueId,
      params.runType,
      params.sourceHeadSha ?? null,
      params.promptText ?? null,
      now,
    );
    const run = this.getRunById(Number(result.lastInsertRowid))!;
    const issue = this.issues.getIssue(params.projectId, params.linearIssueId);
    if (issue) {
      this.projectIssueRun(issue, { lastRunType: run.runType });
    }
    emitTelemetry(this.telemetry, {
      type: "run.claimed",
      projectId: params.projectId,
      linearIssueId: params.linearIssueId,
      runId: run.id,
      runType: run.runType,
      ...(issue?.issueKey ? { issueKey: issue.issueKey } : {}),
    });
    return run;
  }

  getRunById(id: number): RunRecord | undefined {
    const row = this.connection.prepare("SELECT * FROM runs WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? this.mapRunRow(row) : undefined;
  }

  getRunByThreadId(threadId: string): RunRecord | undefined {
    const row = this.connection.prepare("SELECT * FROM runs WHERE thread_id = ?").get(threadId) as Record<string, unknown> | undefined;
    return row ? this.mapRunRow(row) : undefined;
  }

  listRunsForIssue(projectId: string, linearIssueId: string): RunRecord[] {
    const rows = this.connection
      .prepare("SELECT * FROM runs WHERE project_id = ? AND linear_issue_id = ? ORDER BY id")
      .all(projectId, linearIssueId) as Array<Record<string, unknown>>;
    return rows.map(this.mapRunRow);
  }

  getLatestRunForIssue(projectId: string, linearIssueId: string): RunRecord | undefined {
    const row = this.connection
      .prepare("SELECT * FROM runs WHERE project_id = ? AND linear_issue_id = ? ORDER BY id DESC LIMIT 1")
      .get(projectId, linearIssueId) as Record<string, unknown> | undefined;
    return row ? this.mapRunRow(row) : undefined;
  }

  listActiveRuns(): RunRecord[] {
    const rows = this.connection
      .prepare("SELECT * FROM runs WHERE status IN ('queued', 'running')")
      .all() as Array<Record<string, unknown>>;
    return rows.map(this.mapRunRow);
  }

  listRunningRuns(): RunRecord[] {
    const rows = this.connection
      .prepare("SELECT * FROM runs WHERE status IN ('running', 'queued')")
      .all() as Array<Record<string, unknown>>;
    return rows.map(this.mapRunRow);
  }

  updateRunThread(runId: number, params: { threadId: string; parentThreadId?: string; turnId?: string }): void {
    this.connection.prepare(`
      UPDATE runs SET
        thread_id = ?,
        parent_thread_id = COALESCE(?, parent_thread_id),
        turn_id = COALESCE(?, turn_id),
        status = 'running'
      WHERE id = ?
        AND ended_at IS NULL
        AND status IN ('queued', 'running')
    `).run(params.threadId, params.parentThreadId ?? null, params.turnId ?? null, runId);
    const run = this.getRunById(runId);
    if (!run) return;
    const issue = this.issues.getIssue(run.projectId, run.linearIssueId);
    if (issue) {
      this.projectIssueRun(issue);
    }
    emitTelemetry(this.telemetry, {
      type: "run.started",
      projectId: run.projectId,
      linearIssueId: run.linearIssueId,
      runId: run.id,
      runType: run.runType,
      ...(issue?.issueKey ? { issueKey: issue.issueKey } : {}),
    });
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
    const run = this.getRunById(runId);
    if (!run) return;
    const issue = this.issues.getIssue(run.projectId, run.linearIssueId);
    if (issue) {
      this.projectIssueRun(issue, {
        summaryText: extractLatestAssistantSummary(this.getRunById(runId) ?? run),
        lastRunType: run.runType,
      });
    }
    emitTelemetry(this.telemetry, {
      type: params.status === "completed"
        ? "run.completed"
        : params.status === "released"
          ? "run.released"
          : params.status === "superseded"
            ? "run.superseded"
            : "run.failed",
      projectId: run.projectId,
      linearIssueId: run.linearIssueId,
      runId: run.id,
      runType: run.runType,
      ...(issue?.issueKey ? { issueKey: issue.issueKey } : {}),
    });
  }

  // Plan §4.4: flag a still-running run as superseded. We deliberately
  // do NOT change `status` here — the Codex turn must finish naturally
  // so the notification handler can deliver `turn/completed` to the
  // run-finalizer (run-notification-handler ignores any run whose status
  // is not 'running'). The finalizer reads `should_not_publish` and
  // routes to `releaseSupersededRun`, which is where the row finally
  // moves to status='superseded'. Setting status here would orphan the
  // run: notifications would be dropped, the issue's activeRunId would
  // never be cleared, and the lease would stay held.
  markSuperseded(runId: number, params: { reason: string }): void {
    this.connection.prepare(`
      UPDATE runs SET
        should_not_publish = 1,
        failure_reason = COALESCE(failure_reason, ?)
      WHERE id = ?
        AND status IN ('queued', 'running')
    `).run(params.reason, runId);
    const run = this.getRunById(runId);
    if (!run) return;
    const issue = this.issues.getIssue(run.projectId, run.linearIssueId);
    if (issue) {
      this.projectIssueRun(issue, {
        summaryText: params.reason,
        lastRunType: run.runType,
      });
    }
  }

  saveCompletionCheck(runId: number, params: CompletionCheckResult & {
    threadId?: string;
    turnId?: string;
  }): void {
    this.connection.prepare(`
      UPDATE runs SET
        completion_check_thread_id = COALESCE(?, completion_check_thread_id),
        completion_check_turn_id = COALESCE(?, completion_check_turn_id),
        completion_check_outcome = ?,
        completion_check_summary = ?,
        completion_check_question = ?,
        completion_check_why = ?,
        completion_check_recommended_reply = ?,
        completion_checked_at = ?
      WHERE id = ?
    `).run(
      params.threadId ?? null,
      params.turnId ?? null,
      params.outcome,
      params.summary,
      params.question ?? null,
      params.why ?? null,
      params.recommendedReply ?? null,
      isoNow(),
      runId,
    );
  }

  markCompletionCheckStarted(runId: number, params: {
    threadId: string;
    turnId: string;
  }): void {
    this.connection.prepare(`
      UPDATE runs SET
        completion_check_thread_id = ?,
        completion_check_turn_id = ?,
        completion_checked_at = NULL
      WHERE id = ?
    `).run(
      params.threadId,
      params.turnId,
      runId,
    );
    const run = this.getRunById(runId);
    if (!run) return;
    const issue = this.issues.getIssue(run.projectId, run.linearIssueId);
    if (issue) {
      this.projectIssueRun(issue, {
        lastRunType: run.runType,
      });
    }
  }

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
}
