import type { AuthoritativeLedgerStore as AuthoritativeLedgerStoreContract } from "../ledger-ports.ts";
import type { EventReceiptRecord, IssueControlRecord, ObligationRecord, RunLeaseRecord, WorkspaceOwnershipRecord } from "../types.ts";
import type { IssueLifecycleStatus, WorkflowStage } from "../workflow-types.ts";
import { isoNow, type DatabaseConnection } from "./shared.ts";

export class AuthoritativeLedgerStore implements AuthoritativeLedgerStoreContract {
  constructor(private readonly connection: DatabaseConnection) {}

  insertEventReceipt(params: {
    source: string;
    externalId: string;
    eventType: string;
    receivedAt: string;
    acceptanceStatus: EventReceiptRecord["acceptanceStatus"];
    projectId?: string;
    linearIssueId?: string;
    headersJson?: string;
    payloadJson?: string;
  }): { id: number; inserted: boolean } {
    const inserted = this.connection
      .prepare(
        `
        INSERT OR IGNORE INTO event_receipts (
          source, external_id, event_type, received_at, acceptance_status, processing_status,
          project_id, linear_issue_id, headers_json, payload_json
        ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)
        `,
      )
      .run(
        params.source,
        params.externalId,
        params.eventType,
        params.receivedAt,
        params.acceptanceStatus,
        params.projectId ?? null,
        params.linearIssueId ?? null,
        params.headersJson ?? null,
        params.payloadJson ?? null,
      );

    const row = this.connection
      .prepare("SELECT * FROM event_receipts WHERE source = ? AND external_id = ?")
      .get(params.source, params.externalId) as Record<string, unknown> | undefined;
    if (!row) {
      throw new Error(`Failed to load event receipt for ${params.source}:${params.externalId}`);
    }

    if (!inserted.changes) {
      this.connection
        .prepare("UPDATE event_receipts SET acceptance_status = 'duplicate' WHERE id = ? AND acceptance_status = 'accepted'")
        .run(row.id);
    }

    return { id: Number(row.id), inserted: Boolean(inserted.changes) };
  }

  markEventReceiptProcessed(id: number, status: EventReceiptRecord["processingStatus"]): void {
    this.connection.prepare("UPDATE event_receipts SET processing_status = ? WHERE id = ?").run(status, id);
  }

  assignEventReceiptContext(id: number, params: { projectId?: string; linearIssueId?: string }): void {
    this.connection
      .prepare(
        `
        UPDATE event_receipts
        SET project_id = COALESCE(?, project_id),
            linear_issue_id = COALESCE(?, linear_issue_id)
        WHERE id = ?
        `,
      )
      .run(params.projectId ?? null, params.linearIssueId ?? null, id);
  }

  getEventReceipt(id: number): EventReceiptRecord | undefined {
    const row = this.connection.prepare("SELECT * FROM event_receipts WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? mapEventReceipt(row) : undefined;
  }

  getEventReceiptBySourceExternalId(source: string, externalId: string): EventReceiptRecord | undefined {
    const row = this.connection
      .prepare("SELECT * FROM event_receipts WHERE source = ? AND external_id = ?")
      .get(source, externalId) as Record<string, unknown> | undefined;
    return row ? mapEventReceipt(row) : undefined;
  }

  upsertIssueControl(params: {
    projectId: string;
    linearIssueId: string;
    desiredStage?: WorkflowStage | null;
    desiredReceiptId?: number | null;
    activeWorkspaceOwnershipId?: number | null;
    activeRunLeaseId?: number | null;
    serviceOwnedCommentId?: string | null;
    activeAgentSessionId?: string | null;
    lifecycleStatus: IssueLifecycleStatus;
  }): IssueControlRecord {
    const now = isoNow();
    this.connection
      .prepare(
        `
        INSERT INTO issue_control (
          project_id, linear_issue_id, desired_stage, desired_receipt_id, active_workspace_ownership_id,
          active_run_lease_id, service_owned_comment_id, active_agent_session_id, lifecycle_status, updated_at
        ) VALUES (
          @projectId, @linearIssueId, @desiredStage, @desiredReceiptId, @activeWorkspaceOwnershipId,
          @activeRunLeaseId, @serviceOwnedCommentId, @activeAgentSessionId, @lifecycleStatus, @updatedAt
        )
        ON CONFLICT(project_id, linear_issue_id) DO UPDATE SET
          desired_stage = CASE WHEN @setDesiredStage = 1 THEN @desiredStage ELSE issue_control.desired_stage END,
          desired_receipt_id = CASE WHEN @setDesiredReceiptId = 1 THEN @desiredReceiptId ELSE issue_control.desired_receipt_id END,
          active_workspace_ownership_id = CASE WHEN @setActiveWorkspaceOwnershipId = 1 THEN @activeWorkspaceOwnershipId ELSE issue_control.active_workspace_ownership_id END,
          active_run_lease_id = CASE WHEN @setActiveRunLeaseId = 1 THEN @activeRunLeaseId ELSE issue_control.active_run_lease_id END,
          service_owned_comment_id = CASE WHEN @setServiceOwnedCommentId = 1 THEN @serviceOwnedCommentId ELSE issue_control.service_owned_comment_id END,
          active_agent_session_id = CASE WHEN @setActiveAgentSessionId = 1 THEN @activeAgentSessionId ELSE issue_control.active_agent_session_id END,
          lifecycle_status = @lifecycleStatus,
          updated_at = @updatedAt
        `,
      )
      .run({
        projectId: params.projectId,
        linearIssueId: params.linearIssueId,
        desiredStage: params.desiredStage ?? null,
        desiredReceiptId: params.desiredReceiptId ?? null,
        activeWorkspaceOwnershipId: params.activeWorkspaceOwnershipId ?? null,
        activeRunLeaseId: params.activeRunLeaseId ?? null,
        serviceOwnedCommentId: params.serviceOwnedCommentId ?? null,
        activeAgentSessionId: params.activeAgentSessionId ?? null,
        lifecycleStatus: params.lifecycleStatus,
        updatedAt: now,
        setDesiredStage: Number("desiredStage" in params),
        setDesiredReceiptId: Number("desiredReceiptId" in params),
        setActiveWorkspaceOwnershipId: Number("activeWorkspaceOwnershipId" in params),
        setActiveRunLeaseId: Number("activeRunLeaseId" in params),
        setServiceOwnedCommentId: Number("serviceOwnedCommentId" in params),
        setActiveAgentSessionId: Number("activeAgentSessionId" in params),
      });

    return this.getIssueControl(params.projectId, params.linearIssueId)!;
  }

  getIssueControl(projectId: string, linearIssueId: string): IssueControlRecord | undefined {
    const row = this.connection
      .prepare("SELECT * FROM issue_control WHERE project_id = ? AND linear_issue_id = ?")
      .get(projectId, linearIssueId) as Record<string, unknown> | undefined;
    return row ? mapIssueControl(row) : undefined;
  }

  listIssueControlsReadyForLaunch(): IssueControlRecord[] {
    const rows = this.connection
      .prepare("SELECT * FROM issue_control WHERE desired_stage IS NOT NULL AND active_run_lease_id IS NULL ORDER BY id")
      .all() as Record<string, unknown>[];
    return rows.map((row) => mapIssueControl(row));
  }

  upsertWorkspaceOwnership(params: {
    projectId: string;
    linearIssueId: string;
    branchName: string;
    worktreePath: string;
    status: WorkspaceOwnershipRecord["status"];
    currentRunLeaseId?: number | null;
  }): WorkspaceOwnershipRecord {
    const now = isoNow();
    this.connection
      .prepare(
        `
        INSERT INTO workspace_ownership (
          project_id, linear_issue_id, branch_name, worktree_path, status, current_run_lease_id, created_at, updated_at
        ) VALUES (@projectId, @linearIssueId, @branchName, @worktreePath, @status, @currentRunLeaseId, @createdAt, @updatedAt)
        ON CONFLICT(project_id, linear_issue_id) DO UPDATE SET
          branch_name = @branchName,
          worktree_path = @worktreePath,
          status = @status,
          current_run_lease_id = CASE WHEN @setCurrentRunLeaseId = 1 THEN @currentRunLeaseId ELSE workspace_ownership.current_run_lease_id END,
          updated_at = @updatedAt
        `,
      )
      .run({
        projectId: params.projectId,
        linearIssueId: params.linearIssueId,
        branchName: params.branchName,
        worktreePath: params.worktreePath,
        status: params.status,
        currentRunLeaseId: params.currentRunLeaseId ?? null,
        createdAt: now,
        updatedAt: now,
        setCurrentRunLeaseId: Number("currentRunLeaseId" in params),
      });

    return this.getWorkspaceOwnershipForIssue(params.projectId, params.linearIssueId)!;
  }

  getWorkspaceOwnership(id: number): WorkspaceOwnershipRecord | undefined {
    const row = this.connection
      .prepare("SELECT * FROM workspace_ownership WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    return row ? mapWorkspaceOwnership(row) : undefined;
  }

  getWorkspaceOwnershipForIssue(projectId: string, linearIssueId: string): WorkspaceOwnershipRecord | undefined {
    const row = this.connection
      .prepare("SELECT * FROM workspace_ownership WHERE project_id = ? AND linear_issue_id = ?")
      .get(projectId, linearIssueId) as Record<string, unknown> | undefined;
    return row ? mapWorkspaceOwnership(row) : undefined;
  }

  createRunLease(params: {
    issueControlId: number;
    projectId: string;
    linearIssueId: string;
    workspaceOwnershipId: number;
    stage: WorkflowStage;
    workflowFile: string;
    promptText: string;
    triggerReceiptId?: number | null;
    status?: Extract<RunLeaseRecord["status"], "queued" | "running" | "paused">;
  }): RunLeaseRecord {
    const result = this.connection
      .prepare(
        `
        INSERT INTO run_leases (
          issue_control_id, project_id, linear_issue_id, workspace_ownership_id, stage, status, trigger_receipt_id, workflow_file, prompt_text, started_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        params.issueControlId,
        params.projectId,
        params.linearIssueId,
        params.workspaceOwnershipId,
        params.stage,
        params.status ?? "queued",
        params.triggerReceiptId ?? null,
        params.workflowFile ?? "",
        params.promptText ?? "",
        isoNow(),
      );
    return this.getRunLease(Number(result.lastInsertRowid))!;
  }

  getRunLease(id: number): RunLeaseRecord | undefined {
    const row = this.connection.prepare("SELECT * FROM run_leases WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? mapRunLease(row) : undefined;
  }

  getRunLeaseByThreadId(threadId: string): RunLeaseRecord | undefined {
    const row = this.connection
      .prepare("SELECT * FROM run_leases WHERE thread_id = ? ORDER BY id DESC LIMIT 1")
      .get(threadId) as Record<string, unknown> | undefined;
    return row ? mapRunLease(row) : undefined;
  }

  listActiveRunLeases(): RunLeaseRecord[] {
    const rows = this.connection
      .prepare("SELECT * FROM run_leases WHERE status IN ('queued', 'running', 'paused') ORDER BY id")
      .all() as Record<string, unknown>[];
    return rows.map((row) => mapRunLease(row));
  }

  listRunLeasesForIssue(projectId: string, linearIssueId: string): RunLeaseRecord[] {
    const rows = this.connection
      .prepare("SELECT * FROM run_leases WHERE project_id = ? AND linear_issue_id = ? ORDER BY id")
      .all(projectId, linearIssueId) as Record<string, unknown>[];
    return rows.map((row) => mapRunLease(row));
  }

  updateRunLeaseThread(params: {
    runLeaseId: number;
    threadId?: string | null;
    parentThreadId?: string | null;
    turnId?: string | null;
  }): void {
    this.connection
      .prepare(
        `
        UPDATE run_leases
        SET thread_id = CASE WHEN @setThreadId = 1 THEN @threadId ELSE thread_id END,
            parent_thread_id = CASE WHEN @setParentThreadId = 1 THEN @parentThreadId ELSE parent_thread_id END,
            turn_id = CASE WHEN @setTurnId = 1 THEN @turnId ELSE turn_id END
        WHERE id = @runLeaseId
        `,
      )
      .run({
        runLeaseId: params.runLeaseId,
        threadId: params.threadId ?? null,
        parentThreadId: params.parentThreadId ?? null,
        turnId: params.turnId ?? null,
        setThreadId: Number("threadId" in params),
        setParentThreadId: Number("parentThreadId" in params),
        setTurnId: Number("turnId" in params),
      });
  }

  finishRunLease(params: {
    runLeaseId: number;
    status: Extract<RunLeaseRecord["status"], "paused" | "completed" | "failed" | "released">;
    threadId?: string | null;
    turnId?: string | null;
    failureReason?: string | null;
  }): void {
    const now = isoNow();
    this.connection
      .prepare(
        `
        UPDATE run_leases
        SET status = @status,
            thread_id = CASE WHEN @setThreadId = 1 THEN @threadId ELSE thread_id END,
            turn_id = CASE WHEN @setTurnId = 1 THEN @turnId ELSE turn_id END,
            failure_reason = CASE WHEN @setFailureReason = 1 THEN @failureReason ELSE failure_reason END,
            ended_at = CASE WHEN @status IN ('completed', 'failed', 'released') THEN @endedAt ELSE ended_at END
        WHERE id = @runLeaseId
        `,
      )
      .run({
        runLeaseId: params.runLeaseId,
        status: params.status,
        threadId: params.threadId ?? null,
        turnId: params.turnId ?? null,
        failureReason: params.failureReason ?? null,
        endedAt: now,
        setThreadId: Number("threadId" in params),
        setTurnId: Number("turnId" in params),
        setFailureReason: Number("failureReason" in params),
      });
  }

  enqueueObligation(params: {
    projectId: string;
    linearIssueId: string;
    kind: string;
    source: string;
    payloadJson: string;
    runLeaseId?: number | null;
    threadId?: string | null;
    turnId?: string | null;
    dedupeKey?: string | null;
  }): ObligationRecord {
    const now = isoNow();
    const result = this.connection
      .prepare(
        `
        INSERT OR IGNORE INTO obligations (
          project_id, linear_issue_id, kind, status, source, payload_json, run_lease_id, thread_id, turn_id, dedupe_key, created_at, updated_at
        ) VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        params.projectId,
        params.linearIssueId,
        params.kind,
        params.source,
        params.payloadJson,
        params.runLeaseId ?? null,
        params.threadId ?? null,
        params.turnId ?? null,
        params.dedupeKey ?? null,
        now,
        now,
      );

    if (result.changes) {
      return this.getObligation(Number(result.lastInsertRowid))!;
    }

    if (params.dedupeKey) {
      const existing =
        params.runLeaseId === undefined || params.runLeaseId === null
          ? undefined
          : this.getObligationByDedupeKey({
              runLeaseId: params.runLeaseId,
              kind: params.kind,
              dedupeKey: params.dedupeKey,
            });
      if (existing) {
        return existing;
      }
    }

    throw new Error(`Failed to persist obligation for ${params.projectId}:${params.linearIssueId}:${params.kind}`);
  }

  listPendingObligations(params?: { runLeaseId?: number; kind?: string }): ObligationRecord[] {
    const clauses = ["status IN ('pending', 'in_progress', 'failed')"];
    const values: Array<number | string> = [];
    if (params?.runLeaseId !== undefined) {
      clauses.push("run_lease_id = ?");
      values.push(params.runLeaseId);
    }
    if (params?.kind) {
      clauses.push("kind = ?");
      values.push(params.kind);
    }

    const rows = this.connection
      .prepare(`SELECT * FROM obligations WHERE ${clauses.join(" AND ")} ORDER BY id`)
      .all(...values) as Record<string, unknown>[];
    return rows.map((row) => mapObligation(row));
  }

  updateObligationPayloadJson(id: number, payloadJson: string): void {
    this.connection
      .prepare(
        `
        UPDATE obligations
        SET payload_json = ?,
            updated_at = ?
        WHERE id = ?
        `,
      )
      .run(payloadJson, isoNow(), id);
  }

  updateObligationRouting(id: number, params: { runLeaseId?: number | null; threadId?: string | null; turnId?: string | null }): void {
    this.connection
      .prepare(
        `
        UPDATE obligations
        SET run_lease_id = CASE WHEN @setRunLeaseId = 1 THEN @runLeaseId ELSE run_lease_id END,
            thread_id = CASE WHEN @setThreadId = 1 THEN @threadId ELSE thread_id END,
            turn_id = CASE WHEN @setTurnId = 1 THEN @turnId ELSE turn_id END,
            updated_at = @updatedAt
        WHERE id = @id
        `,
      )
      .run({
        id,
        runLeaseId: params.runLeaseId ?? null,
        threadId: params.threadId ?? null,
        turnId: params.turnId ?? null,
        updatedAt: isoNow(),
        setRunLeaseId: Number("runLeaseId" in params),
        setThreadId: Number("threadId" in params),
        setTurnId: Number("turnId" in params),
      });
  }

  markObligationStatus(id: number, status: ObligationRecord["status"], lastError?: string | null): void {
    const now = isoNow();
    this.connection
      .prepare(
        `
        UPDATE obligations
        SET status = @status,
            last_error = CASE WHEN @setLastError = 1 THEN @lastError ELSE last_error END,
            updated_at = @updatedAt,
            completed_at = CASE WHEN @status = 'completed' THEN @completedAt ELSE completed_at END
        WHERE id = @id
        `,
      )
      .run({
        id,
        status,
        lastError: lastError ?? null,
        updatedAt: now,
        completedAt: now,
        setLastError: Number(lastError !== undefined),
      });
  }

  private getObligation(id: number): ObligationRecord | undefined {
    const row = this.connection.prepare("SELECT * FROM obligations WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? mapObligation(row) : undefined;
  }

  getObligationByDedupeKey(params: { runLeaseId: number; kind: string; dedupeKey: string }): ObligationRecord | undefined {
    const row = this.connection
      .prepare(
        `
        SELECT * FROM obligations
        WHERE run_lease_id IS ?
          AND kind = ?
          AND dedupe_key = ?
        ORDER BY id DESC
        LIMIT 1
        `,
      )
      .get(params.runLeaseId, params.kind, params.dedupeKey) as Record<string, unknown> | undefined;
    return row ? mapObligation(row) : undefined;
  }
}

function mapEventReceipt(row: Record<string, unknown>): EventReceiptRecord {
  return {
    id: Number(row.id),
    source: String(row.source),
    externalId: String(row.external_id),
    eventType: String(row.event_type),
    receivedAt: String(row.received_at),
    acceptanceStatus: row.acceptance_status as EventReceiptRecord["acceptanceStatus"],
    processingStatus: row.processing_status as EventReceiptRecord["processingStatus"],
    ...(row.project_id === null ? {} : { projectId: String(row.project_id) }),
    ...(row.linear_issue_id === null ? {} : { linearIssueId: String(row.linear_issue_id) }),
    ...(row.headers_json === null ? {} : { headersJson: String(row.headers_json) }),
    ...(row.payload_json === null ? {} : { payloadJson: String(row.payload_json) }),
  };
}

function mapIssueControl(row: Record<string, unknown>): IssueControlRecord {
  return {
    id: Number(row.id),
    projectId: String(row.project_id),
    linearIssueId: String(row.linear_issue_id),
    ...(row.desired_stage === null ? {} : { desiredStage: row.desired_stage as WorkflowStage }),
    ...(row.desired_receipt_id === null ? {} : { desiredReceiptId: Number(row.desired_receipt_id) }),
    ...(row.active_run_lease_id === null ? {} : { activeRunLeaseId: Number(row.active_run_lease_id) }),
    ...(row.active_workspace_ownership_id === null ? {} : { activeWorkspaceOwnershipId: Number(row.active_workspace_ownership_id) }),
    ...(row.service_owned_comment_id === null ? {} : { serviceOwnedCommentId: String(row.service_owned_comment_id) }),
    ...(row.active_agent_session_id === null ? {} : { activeAgentSessionId: String(row.active_agent_session_id) }),
    lifecycleStatus: row.lifecycle_status as IssueLifecycleStatus,
    updatedAt: String(row.updated_at),
  };
}

function mapWorkspaceOwnership(row: Record<string, unknown>): WorkspaceOwnershipRecord {
  return {
    id: Number(row.id),
    projectId: String(row.project_id),
    linearIssueId: String(row.linear_issue_id),
    branchName: String(row.branch_name),
    worktreePath: String(row.worktree_path),
    status: row.status as WorkspaceOwnershipRecord["status"],
    ...(row.current_run_lease_id === null ? {} : { currentRunLeaseId: Number(row.current_run_lease_id) }),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapRunLease(row: Record<string, unknown>): RunLeaseRecord {
  return {
    id: Number(row.id),
    issueControlId: Number(row.issue_control_id),
    projectId: String(row.project_id),
    linearIssueId: String(row.linear_issue_id),
    workspaceOwnershipId: Number(row.workspace_ownership_id),
    stage: row.stage as WorkflowStage,
    status: row.status as RunLeaseRecord["status"],
    ...(row.trigger_receipt_id === null ? {} : { triggerReceiptId: Number(row.trigger_receipt_id) }),
    workflowFile: String(row.workflow_file ?? ""),
    promptText: String(row.prompt_text ?? ""),
    ...(row.thread_id === null ? {} : { threadId: String(row.thread_id) }),
    ...(row.parent_thread_id === null ? {} : { parentThreadId: String(row.parent_thread_id) }),
    ...(row.turn_id === null ? {} : { turnId: String(row.turn_id) }),
    startedAt: String(row.started_at),
    ...(row.ended_at === null ? {} : { endedAt: String(row.ended_at) }),
    ...(row.failure_reason === null ? {} : { failureReason: String(row.failure_reason) }),
  };
}

function mapObligation(row: Record<string, unknown>): ObligationRecord {
  return {
    id: Number(row.id),
    projectId: String(row.project_id),
    linearIssueId: String(row.linear_issue_id),
    kind: String(row.kind),
    status: row.status as ObligationRecord["status"],
    source: String(row.source),
    payloadJson: String(row.payload_json),
    ...(row.run_lease_id === null ? {} : { runLeaseId: Number(row.run_lease_id) }),
    ...(row.thread_id === null ? {} : { threadId: String(row.thread_id) }),
    ...(row.turn_id === null ? {} : { turnId: String(row.turn_id) }),
    ...(row.dedupe_key === null ? {} : { dedupeKey: String(row.dedupe_key) }),
    ...(row.last_error === null ? {} : { lastError: String(row.last_error) }),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    ...(row.completed_at === null ? {} : { completedAt: String(row.completed_at) }),
  };
}
