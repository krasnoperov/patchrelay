import type {
  IssueLifecycleStatus,
  PipelineRunRecord,
  PipelineStatus,
  StageRunRecord,
  StageRunStatus,
  TrackedIssueRecord,
  WorkflowStage,
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
    pendingLaunchInput?: string | null;
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
          active_agent_session_id, pending_launch_input,
          lifecycle_status, last_webhook_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
          active_agent_session_id = COALESCE(excluded.active_agent_session_id, tracked_issues.active_agent_session_id),
          pending_launch_input = COALESCE(excluded.pending_launch_input, tracked_issues.pending_launch_input),
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
        params.activeAgentSessionId ?? null,
        params.pendingLaunchInput ?? null,
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
    return row ? mapTrackedIssue(row) : undefined;
  }

  getTrackedIssueByKey(issueKey: string): TrackedIssueRecord | undefined {
    const row = this.connection
      .prepare("SELECT * FROM tracked_issues WHERE issue_key = ? ORDER BY updated_at DESC LIMIT 1")
      .get(issueKey) as Record<string, unknown> | undefined;
    return row ? mapTrackedIssue(row) : undefined;
  }

  getTrackedIssueByLinearIssueId(linearIssueId: string): TrackedIssueRecord | undefined {
    const row = this.connection
      .prepare("SELECT * FROM tracked_issues WHERE linear_issue_id = ? ORDER BY updated_at DESC LIMIT 1")
      .get(linearIssueId) as Record<string, unknown> | undefined;
    return row ? mapTrackedIssue(row) : undefined;
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
      activeAgentSessionId: existing?.activeAgentSessionId ?? null,
      pendingLaunchInput: existing?.pendingLaunchInput ?? null,
      lifecycleStatus,
      lastWebhookAt: params.lastWebhookAt,
    });
  }

  listIssuesReadyForExecution(): TrackedIssueRecord[] {
    const rows = this.connection
      .prepare("SELECT * FROM tracked_issues WHERE desired_stage IS NOT NULL AND active_stage_run_id IS NULL")
      .all() as Record<string, unknown>[];
    return rows.map((row) => mapTrackedIssue(row));
  }

  listActiveStageRuns(): StageRunRecord[] {
    const rows = this.connection.prepare("SELECT * FROM stage_runs WHERE status = 'running'").all() as Record<string, unknown>[];
    return rows.map((row) => mapStageRun(row));
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
    return row ? mapWorkspace(row) : undefined;
  }

  getActiveWorkspaceForIssue(projectId: string, linearIssueId: string): WorkspaceRecord | undefined {
    const row = this.connection
      .prepare("SELECT * FROM workspaces WHERE project_id = ? AND linear_issue_id = ? ORDER BY id DESC LIMIT 1")
      .get(projectId, linearIssueId) as Record<string, unknown> | undefined;
    return row ? mapWorkspace(row) : undefined;
  }

  getPipelineRun(id: number): PipelineRunRecord | undefined {
    const row = this.connection.prepare("SELECT * FROM pipeline_runs WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? mapPipelineRun(row) : undefined;
  }

  getActivePipelineForIssue(projectId: string, linearIssueId: string): PipelineRunRecord | undefined {
    const row = this.connection
      .prepare("SELECT * FROM pipeline_runs WHERE project_id = ? AND linear_issue_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1")
      .get(projectId, linearIssueId) as Record<string, unknown> | undefined;
    return row ? mapPipelineRun(row) : undefined;
  }

  getStageRun(id: number): StageRunRecord | undefined {
    const row = this.connection.prepare("SELECT * FROM stage_runs WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? mapStageRun(row) : undefined;
  }

  getStageRunByThreadId(threadId: string): StageRunRecord | undefined {
    const row = this.connection
      .prepare("SELECT * FROM stage_runs WHERE thread_id = ? ORDER BY id DESC LIMIT 1")
      .get(threadId) as Record<string, unknown> | undefined;
    return row ? mapStageRun(row) : undefined;
  }

  listStageRunsForIssue(projectId: string, linearIssueId: string): StageRunRecord[] {
    const rows = this.connection
      .prepare("SELECT * FROM stage_runs WHERE project_id = ? AND linear_issue_id = ? ORDER BY id")
      .all(projectId, linearIssueId) as Record<string, unknown>[];
    return rows.map((row) => mapStageRun(row));
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

  setIssueActiveAgentSession(projectId: string, linearIssueId: string, agentSessionId?: string): void {
    this.connection
      .prepare(
        `
        UPDATE tracked_issues
        SET active_agent_session_id = ?, updated_at = ?
        WHERE project_id = ? AND linear_issue_id = ?
        `,
      )
      .run(agentSessionId ?? null, isoNow(), projectId, linearIssueId);
  }

  setIssuePendingLaunchInput(projectId: string, linearIssueId: string, body?: string): void {
    this.connection
      .prepare(
        `
        UPDATE tracked_issues
        SET pending_launch_input = ?, updated_at = ?
        WHERE project_id = ? AND linear_issue_id = ?
        `,
      )
      .run(body ?? null, isoNow(), projectId, linearIssueId);
  }

  consumeIssuePendingLaunchInput(projectId: string, linearIssueId: string): string | undefined {
    const issue = this.getTrackedIssue(projectId, linearIssueId);
    const body = issue?.pendingLaunchInput;
    if (!body) {
      return undefined;
    }

    this.setIssuePendingLaunchInput(projectId, linearIssueId, undefined);
    return body;
  }

  getLatestStageRunForIssue(projectId: string, linearIssueId: string): StageRunRecord | undefined {
    const row = this.connection
      .prepare("SELECT * FROM stage_runs WHERE project_id = ? AND linear_issue_id = ? ORDER BY id DESC LIMIT 1")
      .get(projectId, linearIssueId) as Record<string, unknown> | undefined;
    return row ? mapStageRun(row) : undefined;
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
}

function mapTrackedIssue(row: Record<string, unknown>): TrackedIssueRecord {
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
    ...(row.active_agent_session_id === null ? {} : { activeAgentSessionId: String(row.active_agent_session_id) }),
    ...(row.pending_launch_input === null ? {} : { pendingLaunchInput: String(row.pending_launch_input) }),
    lifecycleStatus: row.lifecycle_status as IssueLifecycleStatus,
    ...(row.last_webhook_at === null ? {} : { lastWebhookAt: String(row.last_webhook_at) }),
    updatedAt: String(row.updated_at),
  };
}

function mapWorkspace(row: Record<string, unknown>): WorkspaceRecord {
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

function mapPipelineRun(row: Record<string, unknown>): PipelineRunRecord {
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

function mapStageRun(row: Record<string, unknown>): StageRunRecord {
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
