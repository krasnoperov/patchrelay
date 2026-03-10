import pino from "pino";
import { CodexAppServerClient } from "../codex-app-server.js";
import { PatchRelayDatabase } from "../db.js";
import type { AppConfig, CodexThreadItem, CodexThreadSummary, StageReport, StageRunRecord, WorkflowStage } from "../types.js";
import { resolveWorkflowStage } from "../workflow-policy.js";

interface LiveSummary {
  threadId: string;
  threadStatus: string;
  latestTurnId?: string;
  latestTurnStatus?: string;
  latestAssistantMessage?: string;
  latestTimestampSeen?: string;
}

export interface InspectResult {
  issue: ReturnType<PatchRelayDatabase["getTrackedIssueByKey"]>;
  workspace?: ReturnType<PatchRelayDatabase["getActiveWorkspaceForIssue"]>;
  activeStageRun?: StageRunRecord;
  latestStageRun?: StageRunRecord;
  latestReport?: StageReport;
  latestSummary?: Record<string, unknown>;
  live?: LiveSummary;
  statusNote?: string;
}

export interface ReportResult {
  issue: NonNullable<ReturnType<PatchRelayDatabase["getTrackedIssueByKey"]>>;
  stages: Array<{
    stageRun: StageRunRecord;
    report?: StageReport;
    summary?: Record<string, unknown>;
  }>;
}

export interface EventsResult {
  issue: NonNullable<ReturnType<PatchRelayDatabase["getTrackedIssueByKey"]>>;
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
  issue: NonNullable<ReturnType<PatchRelayDatabase["getTrackedIssueByKey"]>>;
  workspace: NonNullable<ReturnType<PatchRelayDatabase["getActiveWorkspaceForIssue"]>>;
  repoId: string;
}

export interface OpenResult extends WorktreeResult {
  resumeThreadId?: string;
}

export interface RetryResult {
  issue: NonNullable<ReturnType<PatchRelayDatabase["getTrackedIssueByKey"]>>;
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

export interface InstallationListResult {
  installations: Array<{
    installation: {
      id: number;
      workspaceName?: string;
      workspaceKey?: string;
      actorName?: string;
      actorId?: string;
      expiresAt?: string;
    };
    linkedProjects: string[];
  }>;
}

export interface ConnectResult {
  state: string;
  authorizeUrl: string;
  redirectUri: string;
  projectId?: string;
}

export interface ConnectStateResult {
  state: string;
  status: "pending" | "completed" | "failed";
  projectId?: string;
  installation?: {
    id: number;
    workspaceName?: string;
    workspaceKey?: string;
    actorName?: string;
    actorId?: string;
  };
  errorMessage?: string;
}

export interface WebhookInstructionsResult {
  projectId: string;
  installationId?: number;
  webhookUrl: string;
  webhookPath: string;
  sharedSecretConfigured: boolean;
}

function safeJsonParse(value: string | undefined): Record<string, unknown> | undefined {
  if (!value) {
    return undefined;
  }

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
  if (!project) {
    return undefined;
  }

  return resolveWorkflowStage(project, stateName);
}

export class CliDataAccess {
  readonly db: PatchRelayDatabase;
  private codex: CodexAppServerClient | undefined;
  private codexStarted = false;

  constructor(
    readonly config: AppConfig,
    options?: { db?: PatchRelayDatabase; codex?: CodexAppServerClient },
  ) {
    this.db = options?.db ?? new PatchRelayDatabase(config.database.path, config.database.wal);
    this.codex = options?.codex;
  }

  close(): void {
    if (!this.codexStarted) {
      return;
    }

    void this.codex?.stop();
    this.codexStarted = false;
  }

  async inspect(issueKey: string): Promise<InspectResult | undefined> {
    const issue = this.db.getTrackedIssueByKey(issueKey);
    if (!issue) {
      return undefined;
    }

    const workspace = this.db.getActiveWorkspaceForIssue(issue.projectId, issue.linearIssueId);
    const activeStageRun = issue.activeStageRunId ? this.db.getStageRun(issue.activeStageRunId) : undefined;
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
    | {
        issue: NonNullable<ReturnType<PatchRelayDatabase["getTrackedIssueByKey"]>>;
        stageRun: StageRunRecord;
        live?: LiveSummary;
      }
    | undefined
  > {
    const issue = this.db.getTrackedIssueByKey(issueKey);
    if (!issue?.activeStageRunId) {
      return undefined;
    }

    const stageRun = this.db.getStageRun(issue.activeStageRunId);
    if (!stageRun) {
      return undefined;
    }

    const live =
      stageRun.threadId &&
      (await this.readLiveSummary(stageRun.threadId, latestEventTimestamp(this.db, stageRun.id)).catch(() => undefined));

    return {
      issue,
      stageRun,
      ...(live ? { live } : {}),
    };
  }

  report(issueKey: string, options?: { stage?: WorkflowStage; stageRunId?: number }): ReportResult | undefined {
    const issue = this.db.getTrackedIssueByKey(issueKey);
    if (!issue) {
      return undefined;
    }

    const stages = this.db
      .listStageRunsForIssue(issue.projectId, issue.linearIssueId)
      .filter((stageRun) => {
        if (options?.stageRunId !== undefined && stageRun.id !== options.stageRunId) {
          return false;
        }
        if (options?.stage !== undefined && stageRun.stage !== options.stage) {
          return false;
        }
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
    if (!issue) {
      return undefined;
    }

    const stageRun =
      (options?.stageRunId !== undefined ? this.db.getStageRun(options.stageRunId) : undefined) ??
      (issue.activeStageRunId ? this.db.getStageRun(issue.activeStageRunId) : undefined) ??
      this.db.getLatestStageRunForIssue(issue.projectId, issue.linearIssueId);
    if (!stageRun || stageRun.projectId !== issue.projectId || stageRun.linearIssueId !== issue.linearIssueId) {
      return undefined;
    }

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
    if (!issue) {
      return undefined;
    }

    const workspace = this.db.getActiveWorkspaceForIssue(issue.projectId, issue.linearIssueId);
    if (!workspace) {
      return undefined;
    }

    return {
      issue,
      workspace,
      repoId: issue.projectId,
    };
  }

  open(issueKey: string): OpenResult | undefined {
    const worktree = this.worktree(issueKey);
    if (!worktree) {
      return undefined;
    }

    const resumeThreadId = worktree.issue.latestThreadId ?? worktree.workspace.lastThreadId;
    return {
      ...worktree,
      ...(resumeThreadId ? { resumeThreadId } : {}),
    };
  }

  retry(issueKey: string, options?: { stage?: WorkflowStage; reason?: string }): RetryResult | undefined {
    const issue = this.db.getTrackedIssueByKey(issueKey);
    if (!issue) {
      return undefined;
    }
    if (issue.activeStageRunId) {
      throw new Error(`Issue ${issueKey} already has an active stage run.`);
    }

    const stage = options?.stage ?? resolveStageFromState(this.config, issue.projectId, issue.currentLinearState);
    if (!stage) {
      throw new Error(`Unable to infer a stage for ${issueKey}; pass --stage.`);
    }

    this.db.setIssueDesiredStage(issue.projectId, issue.linearIssueId, stage, `cli-retry-${Date.now()}`);
    const updated = this.db.getTrackedIssue(issue.projectId, issue.linearIssueId)!;
    return {
      issue: updated,
      stage,
      ...(options?.reason ? { reason: options.reason } : {}),
    };
  }

  list(options?: { active?: boolean; failed?: boolean; project?: string }): ListResultItem[] {
    const conditions: string[] = [];
    const values: Array<string> = [];

    if (options?.project) {
      conditions.push("ti.project_id = ?");
      values.push(options.project);
    }
    if (options?.active) {
      conditions.push("ti.active_stage_run_id IS NOT NULL");
    }
    if (options?.failed) {
      conditions.push("latest_stage.status = 'failed'");
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const rows = this.db.connection
      .prepare(
        `
        SELECT
          ti.issue_key,
          ti.title,
          ti.project_id,
          ti.current_linear_state,
          ti.lifecycle_status,
          ti.updated_at,
          active_stage.stage AS active_stage,
          latest_stage.stage AS latest_stage,
          latest_stage.status AS latest_stage_status
        FROM tracked_issues ti
        LEFT JOIN stage_runs active_stage ON active_stage.id = ti.active_stage_run_id
        LEFT JOIN stage_runs latest_stage ON latest_stage.id = (
          SELECT sr.id
          FROM stage_runs sr
          WHERE sr.project_id = ti.project_id AND sr.linear_issue_id = ti.linear_issue_id
          ORDER BY sr.id DESC
          LIMIT 1
        )
        ${whereClause}
        ORDER BY ti.updated_at DESC, ti.issue_key ASC
        `,
      )
      .all(...values) as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      ...(row.issue_key === null ? {} : { issueKey: String(row.issue_key) }),
      ...(row.title === null ? {} : { title: String(row.title) }),
      projectId: String(row.project_id),
      ...(row.current_linear_state === null ? {} : { currentLinearState: String(row.current_linear_state) }),
      lifecycleStatus: String(row.lifecycle_status),
      ...(row.active_stage === null ? {} : { activeStage: row.active_stage as WorkflowStage }),
      ...(row.latest_stage === null ? {} : { latestStage: row.latest_stage as WorkflowStage }),
      ...(row.latest_stage_status === null ? {} : { latestStageStatus: String(row.latest_stage_status) }),
      updatedAt: String(row.updated_at),
    }));
  }

  async connect(projectId?: string): Promise<ConnectResult> {
    if (!this.config.linear.oauth) {
      throw new Error("Linear OAuth is not configured.");
    }

    return await this.requestJson<ConnectResult>("/api/oauth/linear/start", {
      ...(projectId ? { projectId } : {}),
    });
  }

  async connectStatus(state: string): Promise<ConnectStateResult> {
    if (!state) {
      throw new Error("OAuth state is required.");
    }

    return await this.requestJson<ConnectStateResult>(`/api/oauth/linear/state/${encodeURIComponent(state)}`);
  }

  async listInstallations(): Promise<InstallationListResult> {
    return await this.requestJson<InstallationListResult>("/api/installations");
  }

  async linkInstallation(projectId: string, installationId: number): Promise<{ projectId: string; installationId?: number }> {
    const result = await this.requestJson<{ link: { projectId: string; installationId: number } }>(
      `/api/projects/${encodeURIComponent(projectId)}/installation`,
      undefined,
      {
        method: "POST",
        body: {
          installationId,
        },
      },
    );
    return result.link;
  }

  async unlinkInstallation(projectId: string): Promise<{ projectId: string; installationId?: number }> {
    await this.requestJson<{ ok: true }>(
      `/api/projects/${encodeURIComponent(projectId)}/installation`,
      undefined,
      {
        method: "DELETE",
      },
    );
    return { projectId };
  }

  async webhookInstructions(projectId: string): Promise<WebhookInstructionsResult> {
    const project = this.config.projects.find((entry) => entry.id === projectId);
    if (!project) {
      throw new Error(`Unknown project: ${projectId}`);
    }

    const baseUrl = this.getServiceBaseUrl();
    const installation = (await this.listInstallations()).installations.find((entry) => entry.linkedProjects.includes(projectId))?.installation;
    return {
      projectId,
      ...(installation?.id ? { installationId: installation.id } : {}),
      webhookUrl: new URL(this.config.ingress.linearWebhookPath, baseUrl).toString(),
      webhookPath: this.config.ingress.linearWebhookPath,
      sharedSecretConfigured: this.config.linear.webhookSecret.length > 0,
    };
  }

  private getServiceBaseUrl(): string {
    const redirectUri = this.config.linear.oauth?.redirectUri;
    if (redirectUri) {
      const url = new URL(redirectUri);
      url.pathname = "/";
      url.search = "";
      url.hash = "";
      return url.toString();
    }

    return `http://${this.config.server.bind}:${this.config.server.port}/`;
  }

  private async requestJson<T>(
    pathname: string,
    query?: Record<string, string | undefined>,
    init?: { method?: "GET" | "POST" | "DELETE"; body?: unknown },
  ): Promise<T> {
    const url = new URL(pathname, this.getServiceBaseUrl());
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value) {
        url.searchParams.set(key, value);
      }
    }

    const response = await fetch(url, {
      method: init?.method ?? "GET",
      headers: {
        accept: "application/json",
        ...(init?.body !== undefined ? { "content-type": "application/json" } : {}),
        ...(this.config.operatorApi.bearerToken ? { authorization: `Bearer ${this.config.operatorApi.bearerToken}` } : {}),
      },
      ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
    const body = await response.text();
    if (!response.ok) {
      const message = this.readErrorMessage(body);
      throw new Error(message ?? `Request failed: ${response.status}`);
    }

    const parsed = JSON.parse(body) as { ok?: boolean } & T;
    if (parsed.ok === false) {
      throw new Error(this.readErrorMessage(body) ?? "Request failed.");
    }
    return parsed;
  }

  private readErrorMessage(body: string): string | undefined {
    try {
      const parsed = JSON.parse(body) as { message?: string; reason?: string };
      return parsed.message ?? parsed.reason;
    } catch {
      return undefined;
    }
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
