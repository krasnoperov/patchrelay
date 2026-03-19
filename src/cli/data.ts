import { existsSync } from "node:fs";
import pino from "pino";
import { CodexAppServerClient } from "../codex-app-server.ts";
import { PatchRelayDatabase } from "../db.ts";
import { WorktreeManager } from "../worktree-manager.ts";
import { CliOperatorApiClient } from "./operator-client.ts";
import type {
  AppConfig,
  CodexThreadItem,
  CodexThreadSummary,
  StageReport,
  StageRunRecord,
  TrackedIssueRecord,
  WorkspaceRecord,
  WorkflowStage,
} from "../types.ts";
import { resolveWorkflowStage } from "../workflow-policy.ts";
export type {
  CliOperatorDataAccess,
  ConnectResult,
  ConnectStateResult,
  InstallationListResult,
  OperatorFeedResult,
} from "./operator-client.ts";

interface LiveSummary {
  threadId: string;
  threadStatus: string;
  latestTurnId?: string;
  latestTurnStatus?: string;
  latestAssistantMessage?: string;
  latestTimestampSeen?: string;
}

export interface InspectResult {
  issue: TrackedIssueRecord | undefined;
  workspace?: WorkspaceRecord;
  activeStageRun?: StageRunRecord;
  latestStageRun?: StageRunRecord;
  latestReport?: StageReport;
  latestSummary?: Record<string, unknown>;
  live?: LiveSummary;
  statusNote?: string;
}

export interface ReportResult {
  issue: TrackedIssueRecord;
  stages: Array<{
    stageRun: StageRunRecord;
    report?: StageReport;
    summary?: Record<string, unknown>;
  }>;
}

export interface EventsResult {
  issue: TrackedIssueRecord;
  stageRun: StageRunRecord;
  events: Array<{
    id: number;
    stageRunId: number;
    threadId: string;
    turnId?: string;
    method: string;
    eventJson: string;
    createdAt: string;
    parsedEvent?: Record<string, unknown>;
  }>;
}

export interface WorktreeResult {
  issue: TrackedIssueRecord;
  workspace: WorkspaceRecord;
  repoId: string;
}

export interface OpenResult extends WorktreeResult {
  resumeThreadId?: string;
  needsNewSession?: boolean;
}

export interface RetryResult {
  issue: TrackedIssueRecord;
  stage: WorkflowStage;
  reason?: string;
}

export interface ListResultItem {
  issueKey?: string;
  title?: string;
  projectId: string;
  currentLinearState?: string;
  lifecycleStatus: string;
  activeStage?: WorkflowStage;
  latestStage?: WorkflowStage;
  latestStageStatus?: string;
  updatedAt: string;
}

function safeJsonParse(value: string | undefined): Record<string, unknown> | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function summarizeThread(thread: CodexThreadSummary, latestTimestampSeen?: string): LiveSummary {
  const latestTurn = thread.turns.at(-1);
  const latestAssistantMessage = latestTurn?.items
    .filter((item): item is Extract<CodexThreadItem, { type: "agentMessage" }> => item.type === "agentMessage")
    .at(-1)?.text;

  return {
    threadId: thread.id,
    threadStatus: thread.status,
    ...(latestTurn ? { latestTurnId: latestTurn.id, latestTurnStatus: latestTurn.status } : {}),
    ...(latestAssistantMessage ? { latestAssistantMessage } : {}),
    ...(latestTimestampSeen ? { latestTimestampSeen } : {}),
  };
}

function latestEventTimestamp(db: PatchRelayDatabase, stageRunId: number): string | undefined {
  const events = db.listThreadEvents(stageRunId);
  return events.at(-1)?.createdAt;
}

function resolveStageFromState(config: AppConfig, projectId: string, stateName?: string): WorkflowStage | undefined {
  const project = config.projects.find((entry) => entry.id === projectId);
  if (!project) return undefined;
  return resolveWorkflowStage(project, stateName);
}

export type LiveResult = Awaited<ReturnType<CliDataAccess["live"]>> extends infer T ? Exclude<T, undefined> : never;

export class CliDataAccess extends CliOperatorApiClient {
  readonly db: PatchRelayDatabase;
  private codex: CodexAppServerClient | undefined;
  private codexStarted = false;

  constructor(
    readonly config: AppConfig,
    options?: { db?: PatchRelayDatabase; codex?: CodexAppServerClient },
  ) {
    super(config);
    this.db = options?.db ?? new PatchRelayDatabase(config.database.path, config.database.wal);
    this.codex = options?.codex;
  }

  close(): void {
    if (!this.codexStarted) return;
    void this.codex?.stop();
    this.codexStarted = false;
  }

  async inspect(issueKey: string): Promise<InspectResult | undefined> {
    const issue = this.db.getTrackedIssueByKey(issueKey);
    if (!issue) return undefined;

    const dbIssue = this.db.getIssueByKey(issueKey)!;
    const workspace = this.db.issueToWorkspace(dbIssue);
    const activeStageRun = dbIssue.activeRunId ? this.db.getStageRun(dbIssue.activeRunId) : undefined;
    const latestStageRun = this.db.getLatestStageRunForIssue(issue.projectId, issue.linearIssueId);
    const latestReport = latestStageRun?.reportJson ? (JSON.parse(latestStageRun.reportJson) as StageReport) : undefined;
    const latestSummary = safeJsonParse(latestStageRun?.summaryJson);
    const live =
      activeStageRun?.threadId &&
      (await this.readLiveSummary(activeStageRun.threadId, latestEventTimestamp(this.db, activeStageRun.id)).catch(() => undefined));

    const statusNote =
      (live && live.latestAssistantMessage) ??
      latestReport?.assistantMessages.at(-1) ??
      (typeof latestSummary?.latestAssistantMessage === "string" ? latestSummary.latestAssistantMessage : undefined) ??
      (latestStageRun?.status === "failed" ? "Latest stage failed." : undefined) ??
      (issue.desiredStage ? `Queued for ${issue.desiredStage}.` : undefined) ??
      undefined;

    return {
      issue,
      ...(workspace ? { workspace } : {}),
      ...(activeStageRun ? { activeStageRun } : {}),
      ...(latestStageRun ? { latestStageRun } : {}),
      ...(latestReport ? { latestReport } : {}),
      ...(latestSummary ? { latestSummary } : {}),
      ...(live ? { live } : {}),
      ...(statusNote ? { statusNote } : {}),
    };
  }

  async live(issueKey: string): Promise<
    | { issue: TrackedIssueRecord; stageRun: StageRunRecord; live?: LiveSummary }
    | undefined
  > {
    const issue = this.db.getTrackedIssueByKey(issueKey);
    if (!issue) return undefined;

    const dbIssue = this.db.getIssueByKey(issueKey)!;
    const stageRun = dbIssue.activeRunId ? this.db.getStageRun(dbIssue.activeRunId) : undefined;
    if (!stageRun) return undefined;

    const live =
      stageRun.threadId &&
      (await this.readLiveSummary(stageRun.threadId, latestEventTimestamp(this.db, stageRun.id)).catch(() => undefined));

    return { issue, stageRun, ...(live ? { live } : {}) };
  }

  report(issueKey: string, options?: { stage?: WorkflowStage; stageRunId?: number }): ReportResult | undefined {
    const issue = this.db.getTrackedIssueByKey(issueKey);
    if (!issue) return undefined;

    const stages = this.db
      .listStageRunsForIssue(issue.projectId, issue.linearIssueId)
      .filter((stageRun) => {
        if (options?.stageRunId !== undefined && stageRun.id !== options.stageRunId) return false;
        if (options?.stage !== undefined && stageRun.stage !== options.stage) return false;
        return true;
      })
      .reverse()
      .map((stageRun) => ({
        stageRun,
        ...(stageRun.reportJson ? { report: JSON.parse(stageRun.reportJson) as StageReport } : {}),
        ...(safeJsonParse(stageRun.summaryJson) ? { summary: safeJsonParse(stageRun.summaryJson)! } : {}),
      }));

    return { issue, stages };
  }

  events(issueKey: string, options?: { stageRunId?: number; method?: string; afterId?: number }): EventsResult | undefined {
    const issue = this.db.getTrackedIssueByKey(issueKey);
    if (!issue) return undefined;

    const dbIssue = this.db.getIssueByKey(issueKey)!;
    const stageRun =
      (options?.stageRunId !== undefined ? this.db.getStageRun(options.stageRunId) : undefined) ??
      (dbIssue.activeRunId ? this.db.getStageRun(dbIssue.activeRunId) : undefined) ??
      this.db.getLatestStageRunForIssue(issue.projectId, issue.linearIssueId);
    if (!stageRun || stageRun.projectId !== issue.projectId || stageRun.linearIssueId !== issue.linearIssueId) return undefined;

    const events = this.db
      .listThreadEvents(stageRun.id)
      .filter((event) => (options?.method ? event.method === options.method : true))
      .filter((event) => (options?.afterId !== undefined ? event.id > options.afterId : true))
      .map((event) => ({
        ...event,
        ...(safeJsonParse(event.eventJson) ? { parsedEvent: safeJsonParse(event.eventJson)! } : {}),
      }));

    return { issue, stageRun, events };
  }

  worktree(issueKey: string): WorktreeResult | undefined {
    const issue = this.db.getTrackedIssueByKey(issueKey);
    if (!issue) return undefined;

    const dbIssue = this.db.getIssueByKey(issueKey)!;
    const workspace = this.db.issueToWorkspace(dbIssue);
    if (!workspace) return undefined;

    return { issue, workspace, repoId: issue.projectId };
  }

  open(issueKey: string): OpenResult | undefined {
    const worktree = this.worktree(issueKey);
    if (!worktree) return undefined;

    const dbIssue = this.db.getIssueByKey(issueKey)!;
    const resumeThreadId = dbIssue.threadId ?? undefined;
    return {
      ...worktree,
      ...(resumeThreadId ? { resumeThreadId } : {}),
    };
  }

  async resolveOpen(
    issueKey: string,
    options?: { ensureWorktree?: boolean; createThreadIfMissing?: boolean },
  ): Promise<OpenResult | undefined> {
    const worktree = this.worktree(issueKey);
    if (!worktree) return undefined;

    if (options?.ensureWorktree) {
      await this.ensureOpenWorktree(worktree);
    }

    const dbIssue = this.db.getIssueByKey(issueKey)!;
    const existingThreadId = dbIssue.threadId;
    if (existingThreadId && (await this.canReadThread(existingThreadId))) {
      return { ...worktree, resumeThreadId: existingThreadId };
    }

    if (!options?.createThreadIfMissing) {
      return { ...worktree, needsNewSession: true };
    }

    const codex = await this.getCodex();
    const thread = await codex.startThread({ cwd: worktree.workspace.worktreePath });
    this.db.upsertIssue({
      projectId: worktree.issue.projectId,
      linearIssueId: worktree.issue.linearIssueId,
      threadId: thread.id,
    });
    return { ...worktree, resumeThreadId: thread.id };
  }

  async prepareOpen(issueKey: string): Promise<OpenResult | undefined> {
    return await this.resolveOpen(issueKey, { ensureWorktree: true, createThreadIfMissing: true });
  }

  retry(issueKey: string, options?: { stage?: WorkflowStage; reason?: string }): RetryResult | undefined {
    const issue = this.db.getTrackedIssueByKey(issueKey);
    if (!issue) return undefined;

    const dbIssue = this.db.getIssueByKey(issueKey)!;
    if (dbIssue.activeRunId !== undefined) {
      throw new Error(`Issue ${issueKey} already has an active stage run.`);
    }

    const stage = options?.stage ?? resolveStageFromState(this.config, issue.projectId, issue.currentLinearState);
    if (!stage) {
      throw new Error(`Unable to infer a stage for ${issueKey}; pass --stage.`);
    }

    this.db.upsertIssue({
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      desiredStage: stage,
      lifecycleStatus: "queued",
    });
    const updated = this.db.getTrackedIssue(issue.projectId, issue.linearIssueId)!;
    return { issue: updated, stage, ...(options?.reason ? { reason: options.reason } : {}) };
  }

  list(options?: { active?: boolean; failed?: boolean; project?: string }): ListResultItem[] {
    const conditions: string[] = [];
    const values: Array<string> = [];

    if (options?.project) {
      conditions.push("i.project_id = ?");
      values.push(options.project);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const rows = this.db.connection
      .prepare(
        `
        SELECT
          i.project_id,
          i.linear_issue_id,
          i.issue_key,
          i.title,
          i.current_linear_state,
          i.lifecycle_status,
          i.updated_at,
          active_run.stage AS active_stage,
          latest_run.stage AS latest_stage,
          latest_run.status AS latest_stage_status
        FROM issues i
        LEFT JOIN runs active_run ON active_run.id = i.active_run_id
        LEFT JOIN runs latest_run ON latest_run.id = (
          SELECT r.id FROM runs r
          WHERE r.project_id = i.project_id AND r.linear_issue_id = i.linear_issue_id
          ORDER BY r.id DESC LIMIT 1
        )
        ${whereClause}
        ORDER BY i.updated_at DESC, i.issue_key ASC
        `,
      )
      .all(...values) as Array<Record<string, unknown>>;

    const items = rows.map((row) => ({
      ...(row.issue_key !== null ? { issueKey: String(row.issue_key) } : {}),
      ...(row.title !== null ? { title: String(row.title) } : {}),
      projectId: String(row.project_id),
      ...(row.current_linear_state !== null ? { currentLinearState: String(row.current_linear_state) } : {}),
      lifecycleStatus: String(row.lifecycle_status),
      ...(row.active_stage !== null ? { activeStage: row.active_stage as WorkflowStage } : {}),
      ...(row.latest_stage !== null ? { latestStage: row.latest_stage as WorkflowStage } : {}),
      ...(row.latest_stage_status !== null ? { latestStageStatus: String(row.latest_stage_status) } : {}),
      updatedAt: String(row.updated_at),
    }));

    return items.filter((item) => {
      if (options?.active && !item.activeStage) return false;
      if (options?.failed && item.latestStageStatus !== "failed") return false;
      return true;
    });
  }

  private async canReadThread(threadId: string): Promise<boolean> {
    try {
      const codex = await this.getCodex();
      await codex.readThread(threadId, false);
      return true;
    } catch {
      return false;
    }
  }

  private async ensureOpenWorktree(worktree: WorktreeResult): Promise<void> {
    if (existsSync(worktree.workspace.worktreePath)) return;
    const project = this.config.projects.find((entry) => entry.id === worktree.repoId);
    if (!project) throw new Error(`Project not found for ${worktree.repoId}`);
    const worktreeManager = new WorktreeManager(this.config);
    await worktreeManager.ensureIssueWorktree(
      project.repoPath,
      project.worktreeRoot,
      worktree.workspace.worktreePath,
      worktree.workspace.branchName,
    );
  }

  private async readLiveSummary(threadId: string, latestTimestampSeen?: string): Promise<LiveSummary> {
    const codex = await this.getCodex();
    const thread = await codex.readThread(threadId, true);
    return summarizeThread(thread, latestTimestampSeen);
  }

  private async getCodex(): Promise<CodexAppServerClient> {
    if (!this.codex) {
      this.codex = new CodexAppServerClient(this.config.runner.codex, pino({ enabled: false }));
    }
    if (!this.codexStarted) {
      await this.codex.start();
      this.codexStarted = true;
    }
    return this.codex;
  }
}
