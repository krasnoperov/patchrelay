import type {
  EventReceiptRecord,
  IssueControlRecord,
  IssueProjectionRecord,
  IssueLifecycleStatus,
  PipelineRunRecord,
  RunLeaseRecord,
  RunReportRecord,
  StageRunRecord,
  StageRunStatus,
  TrackedIssueRecord,
  WorkflowStage,
  WorkspaceOwnershipRecord,
  WorkspaceRecord,
} from "../types.ts";
import { isoNow, type DatabaseConnection } from "./shared.ts";

export class IssueWorkflowStore {
  constructor(private readonly connection: DatabaseConnection) {}

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
    activeAgentSessionId?: string | null;
    lifecycleStatus: IssueLifecycleStatus;
    lastWebhookAt?: string;
  }): TrackedIssueRecord {
    this.upsertIssueProjection({
      projectId: params.projectId,
      linearIssueId: params.linearIssueId,
      ...(params.issueKey ? { issueKey: params.issueKey } : {}),
      ...(params.title ? { title: params.title } : {}),
      ...(params.issueUrl ? { issueUrl: params.issueUrl } : {}),
      ...(params.currentLinearState ? { currentLinearState: params.currentLinearState } : {}),
      ...(params.lastWebhookAt ? { lastWebhookAt: params.lastWebhookAt } : {}),
    });

    const desiredReceiptId =
      params.desiredWebhookId === undefined
        ? undefined
        : params.desiredWebhookId === null
          ? null
          : this.ensureDesiredReceipt(params.projectId, params.linearIssueId, params.desiredWebhookId);
    this.upsertIssueControl({
      projectId: params.projectId,
      linearIssueId: params.linearIssueId,
      ...(params.desiredStage !== undefined ? { desiredStage: params.desiredStage } : {}),
      ...(desiredReceiptId !== undefined ? { desiredReceiptId } : {}),
      ...(params.activeWorkspaceId !== undefined ? { activeWorkspaceOwnershipId: params.activeWorkspaceId } : {}),
      ...(params.activeStageRunId !== undefined ? { activeRunLeaseId: params.activeStageRunId } : {}),
      ...(params.statusCommentId !== undefined ? { serviceOwnedCommentId: params.statusCommentId } : {}),
      ...(params.activeAgentSessionId !== undefined ? { activeAgentSessionId: params.activeAgentSessionId } : {}),
      lifecycleStatus: params.lifecycleStatus,
    });

    return this.getTrackedIssue(params.projectId, params.linearIssueId)!;
  }

  getTrackedIssue(projectId: string, linearIssueId: string): TrackedIssueRecord | undefined {
    const issueControl = this.getIssueControlRow(projectId, linearIssueId);
    const projection = this.getIssueProjectionRow(projectId, linearIssueId);
    if (!issueControl && !projection) {
      return undefined;
    }

    return this.buildTrackedIssue(issueControl, projection);
  }

  getTrackedIssueByKey(issueKey: string): TrackedIssueRecord | undefined {
    const projection = this.connection
      .prepare("SELECT * FROM issue_projection WHERE issue_key = ? ORDER BY updated_at DESC LIMIT 1")
      .get(issueKey) as Record<string, unknown> | undefined;
    if (!projection) {
      return undefined;
    }
    return this.getTrackedIssue(String(projection.project_id), String(projection.linear_issue_id));
  }

  getTrackedIssueByLinearIssueId(linearIssueId: string): TrackedIssueRecord | undefined {
    const projection = this.connection
      .prepare("SELECT * FROM issue_projection WHERE linear_issue_id = ? ORDER BY updated_at DESC LIMIT 1")
      .get(linearIssueId) as Record<string, unknown> | undefined;
    if (!projection) {
      return undefined;
    }
    return this.getTrackedIssue(String(projection.project_id), linearIssueId);
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
    this.upsertIssueProjection({
      projectId: params.projectId,
      linearIssueId: params.linearIssueId,
      ...(params.issueKey ? { issueKey: params.issueKey } : existing?.issueKey ? { issueKey: existing.issueKey } : {}),
      ...(params.title ? { title: params.title } : existing?.title ? { title: existing.title } : {}),
      ...(params.issueUrl ? { issueUrl: params.issueUrl } : existing?.issueUrl ? { issueUrl: existing.issueUrl } : {}),
      ...(params.currentLinearState
        ? { currentLinearState: params.currentLinearState }
        : existing?.currentLinearState
          ? { currentLinearState: existing.currentLinearState }
          : {}),
      lastWebhookAt: params.lastWebhookAt,
    });

    const existingIssueControl = this.getIssueControlRow(params.projectId, params.linearIssueId);
    const lifecycleStatus =
      existingIssueControl?.active_run_lease_id || params.desiredStage
        ? existing?.lifecycleStatus ?? "queued"
        : existing?.lifecycleStatus ?? "idle";
    const desiredReceiptId =
      params.desiredWebhookId === undefined ? undefined : this.ensureDesiredReceipt(params.projectId, params.linearIssueId, params.desiredWebhookId);
    this.upsertIssueControl({
      projectId: params.projectId,
      linearIssueId: params.linearIssueId,
      ...(params.desiredStage !== undefined ? { desiredStage: params.desiredStage } : {}),
      ...(desiredReceiptId !== undefined ? { desiredReceiptId } : {}),
      lifecycleStatus,
      ...(existing?.statusCommentId ? { serviceOwnedCommentId: existing.statusCommentId } : {}),
      ...(existing?.activeAgentSessionId ? { activeAgentSessionId: existing.activeAgentSessionId } : {}),
      ...(existing?.activeWorkspaceId !== undefined ? { activeWorkspaceOwnershipId: existing.activeWorkspaceId } : {}),
      ...(existingIssueControl?.active_run_lease_id !== undefined && existingIssueControl.active_run_lease_id !== null
        ? { activeRunLeaseId: Number(existingIssueControl.active_run_lease_id) }
        : {}),
    });

    return this.getTrackedIssue(params.projectId, params.linearIssueId)!;
  }

  listIssuesReadyForExecution(): Array<{ projectId: string; linearIssueId: string }> {
    const rows = this.connection
      .prepare("SELECT project_id, linear_issue_id FROM issue_control WHERE desired_stage IS NOT NULL AND active_run_lease_id IS NULL ORDER BY id")
      .all() as Record<string, unknown>[];
    return rows.map((row) => ({
      projectId: String(row.project_id),
      linearIssueId: String(row.linear_issue_id),
    }));
  }

  listActiveStageRuns(): StageRunRecord[] {
    return this.listRunLeaseRows({ status: "running" }).map((row) => this.buildStageRun(row)!);
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
      const issueControlRow = this.getIssueControlRow(params.projectId, params.linearIssueId);
      const issueControl = issueControlRow ? mapIssueControl(issueControlRow) : undefined;
      if (!issue || !issueControl || issueControl.activeRunLeaseId !== undefined || issue.desiredStage !== params.stage || issue.desiredWebhookId !== params.triggerWebhookId) {
        return undefined;
      }

      const workspaceOwnership = this.upsertWorkspaceOwnership({
        projectId: params.projectId,
        linearIssueId: params.linearIssueId,
        branchName: params.branchName,
        worktreePath: params.worktreePath,
        status: "active",
      });

      const runLease = this.insertRunLease({
        issueControlId: issueControl.id,
        projectId: params.projectId,
        linearIssueId: params.linearIssueId,
        workspaceOwnershipId: workspaceOwnership.id,
        stage: params.stage,
        status: "running",
        workflowFile: params.workflowFile,
        promptText: params.promptText,
        triggerReceiptId: issueControl.desiredReceiptId ?? null,
      });

      this.upsertWorkspaceOwnership({
        projectId: params.projectId,
        linearIssueId: params.linearIssueId,
        branchName: params.branchName,
        worktreePath: params.worktreePath,
        status: "active",
        currentRunLeaseId: runLease.id,
      });
      this.upsertIssueControl({
        projectId: params.projectId,
        linearIssueId: params.linearIssueId,
        desiredStage: null,
        desiredReceiptId: null,
        activeWorkspaceOwnershipId: workspaceOwnership.id,
        activeRunLeaseId: runLease.id,
        lifecycleStatus: "running",
        ...(issue.statusCommentId ? { serviceOwnedCommentId: issue.statusCommentId } : {}),
        ...(issue.activeAgentSessionId ? { activeAgentSessionId: issue.activeAgentSessionId } : {}),
      });

      const refreshedIssue = this.getTrackedIssue(params.projectId, params.linearIssueId)!;
      const workspace = this.getWorkspace(workspaceOwnership.id)!;
      const stageRun = this.getStageRun(runLease.id)!;
      const pipeline = this.getPipelineRun(runLease.id)!;
      return { issue: refreshedIssue, workspace, pipeline, stageRun };
    });

    return transaction();
  }

  getWorkspace(id: number): WorkspaceRecord | undefined {
    const row = this.connection.prepare("SELECT * FROM workspace_ownership WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row) {
      return undefined;
    }
    return this.buildWorkspace(mapWorkspaceOwnership(row));
  }

  getActiveWorkspaceForIssue(projectId: string, linearIssueId: string): WorkspaceRecord | undefined {
    const row = this.connection
      .prepare("SELECT * FROM workspace_ownership WHERE project_id = ? AND linear_issue_id = ?")
      .get(projectId, linearIssueId) as Record<string, unknown> | undefined;
    return row ? this.buildWorkspace(mapWorkspaceOwnership(row)) : undefined;
  }

  getPipelineRun(id: number): PipelineRunRecord | undefined {
    const runLease = this.getRunLeaseRowById(id);
    if (!runLease) {
      return undefined;
    }
    const issueControl = this.getIssueControlRow(String(runLease.project_id), String(runLease.linear_issue_id));
    const status = resolvePipelineStatus(runLease.status as RunLeaseRecord["status"], issueControl?.lifecycle_status as IssueLifecycleStatus | undefined);
    return {
      id: Number(runLease.id),
      projectId: String(runLease.project_id),
      linearIssueId: String(runLease.linear_issue_id),
      workspaceId: Number(runLease.workspace_ownership_id),
      status,
      currentStage: runLease.stage as WorkflowStage,
      startedAt: String(runLease.started_at),
      ...(runLease.ended_at === null ? {} : { endedAt: String(runLease.ended_at) }),
    };
  }

  getStageRun(id: number): StageRunRecord | undefined {
    const row = this.getRunLeaseRowById(id);
    return row ? this.buildStageRun(row) : undefined;
  }

  getStageRunByThreadId(threadId: string): StageRunRecord | undefined {
    const row = this.connection
      .prepare("SELECT * FROM run_leases WHERE thread_id = ? ORDER BY id DESC LIMIT 1")
      .get(threadId) as Record<string, unknown> | undefined;
    return row ? this.buildStageRun(row) : undefined;
  }

  listStageRunsForIssue(projectId: string, linearIssueId: string): StageRunRecord[] {
    return this.listRunLeaseRows({ projectId, linearIssueId }).map((row) => this.buildStageRun(row)!);
  }

  updateStageRunThread(params: { stageRunId: number; threadId: string; parentThreadId?: string; turnId?: string }): void {
    this.connection
      .prepare(
        `
        UPDATE run_leases
        SET thread_id = ?,
            parent_thread_id = COALESCE(?, parent_thread_id),
            turn_id = COALESCE(?, turn_id)
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
        INSERT INTO run_reports (run_lease_id, summary_json, report_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(run_lease_id) DO UPDATE SET
          summary_json = excluded.summary_json,
          report_json = excluded.report_json,
          updated_at = excluded.updated_at
        `,
      )
      .run(params.stageRunId, params.summaryJson ?? null, params.reportJson ?? null, now, now);

    this.connection
      .prepare(
        `
        UPDATE run_leases
        SET status = ?,
            thread_id = ?,
            turn_id = COALESCE(?, turn_id),
            ended_at = CASE WHEN ? IN ('completed', 'failed') THEN ? ELSE ended_at END
        WHERE id = ?
        `,
      )
      .run(
        params.status === "failed" ? "failed" : "completed",
        params.threadId,
        params.turnId ?? null,
        params.status === "failed" ? "failed" : "completed",
        now,
        params.stageRunId,
      );

    const workspace = this.getWorkspaceOwnershipRowById(stageRun.workspaceId);
    if (workspace) {
      this.upsertWorkspaceOwnership({
        projectId: stageRun.projectId,
        linearIssueId: stageRun.linearIssueId,
        branchName: String(workspace.branch_name),
        worktreePath: String(workspace.worktree_path),
        status: params.status === "completed" ? "active" : "paused",
        currentRunLeaseId: null,
      });
    }
  }

  setIssueDesiredStage(projectId: string, linearIssueId: string, desiredStage?: WorkflowStage, desiredWebhookId?: string): void {
    const existing = this.getTrackedIssue(projectId, linearIssueId);
    const existingIssueControl = this.getIssueControlRow(projectId, linearIssueId);
    this.upsertIssueControl({
      projectId,
      linearIssueId,
      ...(desiredStage !== undefined ? { desiredStage } : { desiredStage: null }),
      ...(desiredWebhookId !== undefined
        ? { desiredReceiptId: this.ensureDesiredReceipt(projectId, linearIssueId, desiredWebhookId) }
        : desiredStage === undefined
          ? { desiredReceiptId: null }
          : {}),
      lifecycleStatus: desiredStage ? "queued" : existingIssueControl?.active_run_lease_id ? (existing?.lifecycleStatus ?? "idle") : "idle",
      ...(existing?.statusCommentId ? { serviceOwnedCommentId: existing.statusCommentId } : {}),
      ...(existing?.activeAgentSessionId ? { activeAgentSessionId: existing.activeAgentSessionId } : {}),
      ...(existing?.activeWorkspaceId !== undefined ? { activeWorkspaceOwnershipId: existing.activeWorkspaceId } : {}),
      ...(existingIssueControl?.active_run_lease_id !== undefined && existingIssueControl.active_run_lease_id !== null
        ? { activeRunLeaseId: Number(existingIssueControl.active_run_lease_id) }
        : {}),
    });
  }

  setIssueLifecycleStatus(projectId: string, linearIssueId: string, lifecycleStatus: IssueLifecycleStatus): void {
    const existing = this.getTrackedIssue(projectId, linearIssueId);
    const existingIssueControl = this.getIssueControlRow(projectId, linearIssueId);
    this.upsertIssueControl({
      projectId,
      linearIssueId,
      lifecycleStatus,
      ...(existing?.desiredStage ? { desiredStage: existing.desiredStage } : {}),
      ...(existing?.desiredWebhookId ? { desiredReceiptId: this.ensureDesiredReceipt(projectId, linearIssueId, existing.desiredWebhookId) } : {}),
      ...(existing?.activeWorkspaceId !== undefined ? { activeWorkspaceOwnershipId: existing.activeWorkspaceId } : {}),
      ...(existingIssueControl?.active_run_lease_id !== undefined && existingIssueControl.active_run_lease_id !== null
        ? { activeRunLeaseId: Number(existingIssueControl.active_run_lease_id) }
        : {}),
      ...(existing?.statusCommentId ? { serviceOwnedCommentId: existing.statusCommentId } : {}),
      ...(existing?.activeAgentSessionId ? { activeAgentSessionId: existing.activeAgentSessionId } : {}),
    });
  }

  setIssueStatusComment(projectId: string, linearIssueId: string, statusCommentId?: string): void {
    const existing = this.getTrackedIssue(projectId, linearIssueId);
    const existingIssueControl = this.getIssueControlRow(projectId, linearIssueId);
    this.upsertIssueControl({
      projectId,
      linearIssueId,
      lifecycleStatus: existing?.lifecycleStatus ?? "idle",
      ...(existing?.desiredStage ? { desiredStage: existing.desiredStage } : {}),
      ...(existing?.desiredWebhookId ? { desiredReceiptId: this.ensureDesiredReceipt(projectId, linearIssueId, existing.desiredWebhookId) } : {}),
      ...(existing?.activeWorkspaceId !== undefined ? { activeWorkspaceOwnershipId: existing.activeWorkspaceId } : {}),
      ...(existingIssueControl?.active_run_lease_id !== undefined && existingIssueControl.active_run_lease_id !== null
        ? { activeRunLeaseId: Number(existingIssueControl.active_run_lease_id) }
        : {}),
      serviceOwnedCommentId: statusCommentId ?? null,
      ...(existing?.activeAgentSessionId ? { activeAgentSessionId: existing.activeAgentSessionId } : {}),
    });
  }

  setIssueActiveAgentSession(projectId: string, linearIssueId: string, agentSessionId?: string): void {
    const existing = this.getTrackedIssue(projectId, linearIssueId);
    const existingIssueControl = this.getIssueControlRow(projectId, linearIssueId);
    this.upsertIssueControl({
      projectId,
      linearIssueId,
      lifecycleStatus: existing?.lifecycleStatus ?? "idle",
      ...(existing?.desiredStage ? { desiredStage: existing.desiredStage } : {}),
      ...(existing?.desiredWebhookId ? { desiredReceiptId: this.ensureDesiredReceipt(projectId, linearIssueId, existing.desiredWebhookId) } : {}),
      ...(existing?.activeWorkspaceId !== undefined ? { activeWorkspaceOwnershipId: existing.activeWorkspaceId } : {}),
      ...(existingIssueControl?.active_run_lease_id !== undefined && existingIssueControl.active_run_lease_id !== null
        ? { activeRunLeaseId: Number(existingIssueControl.active_run_lease_id) }
        : {}),
      ...(existing?.statusCommentId ? { serviceOwnedCommentId: existing.statusCommentId } : {}),
      activeAgentSessionId: agentSessionId ?? null,
    });
  }

  getLatestStageRunForIssue(projectId: string, linearIssueId: string): StageRunRecord | undefined {
    const row = this.connection
      .prepare("SELECT * FROM run_leases WHERE project_id = ? AND linear_issue_id = ? ORDER BY id DESC LIMIT 1")
      .get(projectId, linearIssueId) as Record<string, unknown> | undefined;
    return row ? this.buildStageRun(row) : undefined;
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

    const issueControl = this.getIssueControlRow(issue.projectId, issue.linearIssueId);
    const activeWorkspaceOwnershipId =
      issueControl?.active_workspace_ownership_id === null || issueControl?.active_workspace_ownership_id === undefined
        ? undefined
        : Number(issueControl.active_workspace_ownership_id);
    const activeRunLeaseId =
      issueControl?.active_run_lease_id === null || issueControl?.active_run_lease_id === undefined
        ? undefined
        : Number(issueControl.active_run_lease_id);
    const workspace = activeWorkspaceOwnershipId ? this.getWorkspace(activeWorkspaceOwnershipId) : this.getActiveWorkspaceForIssue(issue.projectId, issue.linearIssueId);
    const pipeline = activeRunLeaseId ? this.getPipelineRun(activeRunLeaseId) : issue.activePipelineRunId ? this.getPipelineRun(issue.activePipelineRunId) : undefined;
    const activeStageRun =
      activeRunLeaseId === undefined ? undefined : this.getStageRun(activeRunLeaseId);

    return {
      issue,
      ...(workspace ? { workspace } : {}),
      ...(pipeline ? { pipeline } : {}),
      ...(activeStageRun ? { activeStageRun } : {}),
    };
  }

  private upsertIssueProjection(params: {
    projectId: string;
    linearIssueId: string;
    issueKey?: string;
    title?: string;
    issueUrl?: string;
    currentLinearState?: string;
    lastWebhookAt?: string;
  }): void {
    this.connection
      .prepare(
        `
        INSERT INTO issue_projection (
          project_id, linear_issue_id, issue_key, title, issue_url, current_linear_state, last_webhook_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(project_id, linear_issue_id) DO UPDATE SET
          issue_key = COALESCE(excluded.issue_key, issue_projection.issue_key),
          title = COALESCE(excluded.title, issue_projection.title),
          issue_url = COALESCE(excluded.issue_url, issue_projection.issue_url),
          current_linear_state = COALESCE(excluded.current_linear_state, issue_projection.current_linear_state),
          last_webhook_at = COALESCE(excluded.last_webhook_at, issue_projection.last_webhook_at),
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
        params.lastWebhookAt ?? null,
        isoNow(),
      );
  }

  private upsertIssueControl(params: {
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

    return mapIssueControl(
      this.connection
        .prepare("SELECT * FROM issue_control WHERE project_id = ? AND linear_issue_id = ?")
        .get(params.projectId, params.linearIssueId) as Record<string, unknown>,
    );
  }

  private upsertWorkspaceOwnership(params: {
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

    return mapWorkspaceOwnership(
      this.connection
        .prepare("SELECT * FROM workspace_ownership WHERE project_id = ? AND linear_issue_id = ?")
        .get(params.projectId, params.linearIssueId) as Record<string, unknown>,
    );
  }

  private insertRunLease(params: {
    issueControlId: number;
    projectId: string;
    linearIssueId: string;
    workspaceOwnershipId: number;
    stage: WorkflowStage;
    status: Extract<RunLeaseRecord["status"], "queued" | "running" | "paused">;
    workflowFile: string;
    promptText: string;
    triggerReceiptId?: number | null;
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
        params.status,
        params.triggerReceiptId ?? null,
        params.workflowFile,
        params.promptText,
        isoNow(),
      );
    return this.buildRunLease(
      this.connection.prepare("SELECT * FROM run_leases WHERE id = ?").get(Number(result.lastInsertRowid)) as Record<string, unknown>,
    );
  }

  private buildTrackedIssue(
    issueControlRow: Record<string, unknown> | undefined,
    projectionRow: Record<string, unknown> | undefined,
  ): TrackedIssueRecord {
    const issueControl = issueControlRow ? mapIssueControl(issueControlRow) : undefined;
    const projection = projectionRow ? mapIssueProjection(projectionRow) : undefined;
    const projectId = issueControl?.projectId ?? projection?.projectId;
    const linearIssueId = issueControl?.linearIssueId ?? projection?.linearIssueId;
    if (!projectId || !linearIssueId) {
      throw new Error("Cannot synthesize tracked issue without an issue identity");
    }
    const latestRun = this.getLatestRunLeaseForIssue(projectId, linearIssueId);
    const activeRun = issueControl?.activeRunLeaseId ? this.getStageRun(issueControl.activeRunLeaseId) : undefined;

    return {
      id: issueControl?.id ?? projection?.id ?? 0,
      projectId,
      linearIssueId,
      ...(projection?.issueKey ? { issueKey: projection.issueKey } : {}),
      ...(projection?.title ? { title: projection.title } : {}),
      ...(projection?.issueUrl ? { issueUrl: projection.issueUrl } : {}),
      ...(projection?.currentLinearState ? { currentLinearState: projection.currentLinearState } : {}),
      ...(issueControl?.desiredStage ? { desiredStage: issueControl.desiredStage } : {}),
      ...(() => {
        if (!issueControl?.desiredReceiptId) {
          return {};
        }
        const receipt = this.getEventReceiptById(issueControl.desiredReceiptId);
        return receipt?.externalId ? { desiredWebhookId: receipt.externalId } : {};
      })(),
      ...(issueControl?.activeWorkspaceOwnershipId !== undefined ? { activeWorkspaceId: issueControl.activeWorkspaceOwnershipId } : {}),
      ...(latestRun ? { activePipelineRunId: latestRun.id } : {}),
      ...(issueControl?.activeRunLeaseId !== undefined ? { activeStageRunId: issueControl.activeRunLeaseId } : {}),
      ...(activeRun?.threadId ? { latestThreadId: activeRun.threadId } : latestRun?.threadId ? { latestThreadId: latestRun.threadId } : {}),
      ...(issueControl?.serviceOwnedCommentId ? { statusCommentId: issueControl.serviceOwnedCommentId } : {}),
      ...(issueControl?.activeAgentSessionId ? { activeAgentSessionId: issueControl.activeAgentSessionId } : {}),
      lifecycleStatus: issueControl?.lifecycleStatus ?? "idle",
      ...(projection?.lastWebhookAt ? { lastWebhookAt: projection.lastWebhookAt } : {}),
      updatedAt: issueControl?.updatedAt ?? projection?.updatedAt ?? isoNow(),
    };
  }

  private buildWorkspace(workspaceOwnership: WorkspaceOwnershipRecord): WorkspaceRecord {
    const stageRuns = this.listStageRunsForIssue(workspaceOwnership.projectId, workspaceOwnership.linearIssueId);
    const latestStageRun = stageRuns.findLast((stageRun) => stageRun.status !== "running") ?? stageRuns.at(-1);
    return {
      id: workspaceOwnership.id,
      projectId: workspaceOwnership.projectId,
      linearIssueId: workspaceOwnership.linearIssueId,
      branchName: workspaceOwnership.branchName,
      worktreePath: workspaceOwnership.worktreePath,
      status: workspaceOwnership.status === "released" ? "closed" : workspaceOwnership.status,
      ...(latestStageRun ? { lastStage: latestStageRun.stage } : {}),
      ...(latestStageRun?.threadId ? { lastThreadId: latestStageRun.threadId } : {}),
      createdAt: workspaceOwnership.createdAt,
      updatedAt: workspaceOwnership.updatedAt,
    };
  }

  private buildStageRun(runLeaseRow: Record<string, unknown>): StageRunRecord {
    const runLease = this.buildRunLease(runLeaseRow);
    const report = this.getRunReport(runLease.id);
    const triggerWebhookId = runLease.triggerReceiptId ? this.getEventReceiptById(runLease.triggerReceiptId)?.externalId ?? `run-lease:${runLease.id}` : `run-lease:${runLease.id}`;
    return {
      id: runLease.id,
      pipelineRunId: runLease.id,
      projectId: runLease.projectId,
      linearIssueId: runLease.linearIssueId,
      workspaceId: runLease.workspaceOwnershipId,
      stage: runLease.stage,
      status: runLease.status === "failed" ? "failed" : runLease.status === "completed" || runLease.status === "released" || runLease.status === "paused" ? "completed" : "running",
      triggerWebhookId,
      workflowFile: runLease.workflowFile,
      promptText: runLease.promptText,
      ...(runLease.threadId ? { threadId: runLease.threadId } : {}),
      ...(runLease.parentThreadId ? { parentThreadId: runLease.parentThreadId } : {}),
      ...(runLease.turnId ? { turnId: runLease.turnId } : {}),
      ...(report?.summaryJson ? { summaryJson: report.summaryJson } : {}),
      ...(report?.reportJson ? { reportJson: report.reportJson } : {}),
      startedAt: runLease.startedAt,
      ...(runLease.endedAt ? { endedAt: runLease.endedAt } : {}),
    };
  }

  private buildRunLease(row: Record<string, unknown>): RunLeaseRecord {
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

  private getIssueProjectionRow(projectId: string, linearIssueId: string): Record<string, unknown> | undefined {
    return this.connection
      .prepare("SELECT * FROM issue_projection WHERE project_id = ? AND linear_issue_id = ?")
      .get(projectId, linearIssueId) as Record<string, unknown> | undefined;
  }

  private getIssueControlRow(projectId: string, linearIssueId: string): Record<string, unknown> | undefined {
    return this.connection
      .prepare("SELECT * FROM issue_control WHERE project_id = ? AND linear_issue_id = ?")
      .get(projectId, linearIssueId) as Record<string, unknown> | undefined;
  }

  private getWorkspaceOwnershipRowById(id: number): Record<string, unknown> | undefined {
    return this.connection.prepare("SELECT * FROM workspace_ownership WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  }

  private getRunLeaseRowById(id: number): Record<string, unknown> | undefined {
    return this.connection.prepare("SELECT * FROM run_leases WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  }

  private listRunLeaseRows(params?: { projectId?: string; linearIssueId?: string; status?: RunLeaseRecord["status"] }) {
    const clauses: string[] = [];
    const values: Array<string> = [];
    if (params?.projectId) {
      clauses.push("project_id = ?");
      values.push(params.projectId);
    }
    if (params?.linearIssueId) {
      clauses.push("linear_issue_id = ?");
      values.push(params.linearIssueId);
    }
    if (params?.status) {
      clauses.push("status = ?");
      values.push(params.status);
    }
    const sql = `SELECT * FROM run_leases${clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : ""} ORDER BY id`;
    return this.connection.prepare(sql).all(...values) as Record<string, unknown>[];
  }

  private getLatestRunLeaseForIssue(projectId: string, linearIssueId: string): RunLeaseRecord | undefined {
    const row = this.connection
      .prepare("SELECT * FROM run_leases WHERE project_id = ? AND linear_issue_id = ? ORDER BY id DESC LIMIT 1")
      .get(projectId, linearIssueId) as Record<string, unknown> | undefined;
    return row ? this.buildRunLease(row) : undefined;
  }

  private getRunReport(runLeaseId: number): RunReportRecord | undefined {
    const row = this.connection.prepare("SELECT * FROM run_reports WHERE run_lease_id = ?").get(runLeaseId) as Record<string, unknown> | undefined;
    return row ? mapRunReport(row) : undefined;
  }

  private getEventReceiptById(id: number): EventReceiptRecord | undefined {
    const row = this.connection.prepare("SELECT * FROM event_receipts WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? mapEventReceipt(row) : undefined;
  }

  private ensureDesiredReceipt(projectId: string, linearIssueId: string, webhookId: string): number {
    const existing = this.connection
      .prepare("SELECT * FROM event_receipts WHERE external_id = ? ORDER BY id DESC LIMIT 1")
      .get(webhookId) as Record<string, unknown> | undefined;
    if (existing) {
      return Number(existing.id);
    }

    const result = this.connection
      .prepare(
        `
        INSERT INTO event_receipts (
          source, external_id, event_type, received_at, acceptance_status, processing_status, project_id, linear_issue_id
        ) VALUES (?, ?, ?, ?, 'accepted', 'processed', ?, ?)
        `,
      )
      .run("patchrelay-desired-stage", webhookId, "desired_stage", isoNow(), projectId, linearIssueId);
    return Number(result.lastInsertRowid);
  }
}

function resolvePipelineStatus(runStatus: RunLeaseRecord["status"], lifecycleStatus: IssueLifecycleStatus | undefined): PipelineRunRecord["status"] {
  if (lifecycleStatus === "paused") {
    return "paused";
  }
  if (runStatus === "failed" || lifecycleStatus === "failed") {
    return "failed";
  }
  if (runStatus === "completed" || runStatus === "released" || lifecycleStatus === "completed") {
    return "completed";
  }
  return "active";
}

function mapIssueProjection(row: Record<string, unknown>): IssueProjectionRecord {
  return {
    id: Number(row.id),
    projectId: String(row.project_id),
    linearIssueId: String(row.linear_issue_id),
    ...(row.issue_key === null ? {} : { issueKey: String(row.issue_key) }),
    ...(row.title === null ? {} : { title: String(row.title) }),
    ...(row.issue_url === null ? {} : { issueUrl: String(row.issue_url) }),
    ...(row.current_linear_state === null ? {} : { currentLinearState: String(row.current_linear_state) }),
    ...(row.last_webhook_at === null ? {} : { lastWebhookAt: String(row.last_webhook_at) }),
    updatedAt: String(row.updated_at),
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

function mapRunReport(row: Record<string, unknown>): RunReportRecord {
  return {
    runLeaseId: Number(row.run_lease_id),
    ...(row.summary_json === null ? {} : { summaryJson: String(row.summary_json) }),
    ...(row.report_json === null ? {} : { reportJson: String(row.report_json) }),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
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
