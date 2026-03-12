import pino from "pino";
import { CodexAppServerClient } from "../codex-app-server.ts";
import { PatchRelayDatabase } from "../db.ts";
import type {
  AppConfig,
  CodexThreadItem,
  CodexThreadSummary,
  IssueControlRecord,
  RunLeaseRecord,
  StageReport,
  StageRunRecord,
  TrackedIssueRecord,
  WorkspaceOwnershipRecord,
  WorkspaceRecord,
  WorkflowStage,
} from "../types.ts";
import { resolveWorkflowStage } from "../workflow-policy.ts";

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

export type ConnectResult =
  | {
      state: string;
      authorizeUrl: string;
      redirectUri: string;
      projectId?: string;
    }
  | {
      completed: true;
      reusedExisting: true;
      projectId: string;
      installation: {
        id: number;
        workspaceName?: string;
        workspaceKey?: string;
        actorName?: string;
        actorId?: string;
      };
    };

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
  const events = db.stageEvents.listThreadEvents(stageRunId);
  return events.at(-1)?.createdAt;
}

function resolveStageFromState(config: AppConfig, projectId: string, stateName?: string): WorkflowStage | undefined {
  const project = config.projects.find((entry) => entry.id === projectId);
  if (!project) {
    return undefined;
  }

  return resolveWorkflowStage(project, stateName);
}

interface LedgerIssueContext {
  issueControl?: IssueControlRecord;
  runLease?: RunLeaseRecord;
  workspaceOwnership?: WorkspaceOwnershipRecord;
  mirroredStageRun?: StageRunRecord;
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
    const issue = this.db.issueWorkflows.getTrackedIssueByKey(issueKey);
    if (!issue) {
      return undefined;
    }

    const ledger = this.getLedgerIssueContext(issue.projectId, issue.linearIssueId);
    const workspace = this.getWorkspaceForIssue(issue, ledger);
    const activeStageRun = this.getActiveStageRunForIssue(issue, ledger);
    const latestStageRun = this.db.issueWorkflows.getLatestStageRunForIssue(issue.projectId, issue.linearIssueId);
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
        issue: TrackedIssueRecord;
        stageRun: StageRunRecord;
        live?: LiveSummary;
      }
    | undefined
  > {
    const issue = this.db.issueWorkflows.getTrackedIssueByKey(issueKey);
    if (!issue) {
      return undefined;
    }

    const stageRun = this.getActiveStageRunForIssue(issue);
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
    const issue = this.db.issueWorkflows.getTrackedIssueByKey(issueKey);
    if (!issue) {
      return undefined;
    }

    const stages = this.db
      .issueWorkflows.listStageRunsForIssue(issue.projectId, issue.linearIssueId)
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
    const issue = this.db.issueWorkflows.getTrackedIssueByKey(issueKey);
    if (!issue) {
      return undefined;
    }

    const stageRun =
      (options?.stageRunId !== undefined ? this.db.issueWorkflows.getStageRun(options.stageRunId) : undefined) ??
      this.getActiveStageRunForIssue(issue) ??
      this.db.issueWorkflows.getLatestStageRunForIssue(issue.projectId, issue.linearIssueId);
    if (!stageRun || stageRun.projectId !== issue.projectId || stageRun.linearIssueId !== issue.linearIssueId) {
      return undefined;
    }

    const events = this.db
      .stageEvents.listThreadEvents(stageRun.id)
      .filter((event) => (options?.method ? event.method === options.method : true))
      .filter((event) => (options?.afterId !== undefined ? event.id > options.afterId : true))
      .map((event) => ({
        ...event,
        ...(safeJsonParse(event.eventJson) ? { parsedEvent: safeJsonParse(event.eventJson)! } : {}),
      }));

    return { issue, stageRun, events };
  }

  worktree(issueKey: string): WorktreeResult | undefined {
    const issue = this.db.issueWorkflows.getTrackedIssueByKey(issueKey);
    if (!issue) {
      return undefined;
    }

    const workspace = this.getWorkspaceForIssue(issue);
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

    const ledger = this.getLedgerIssueContext(worktree.issue.projectId, worktree.issue.linearIssueId);
    const resumeThreadId =
      (ledger.issueControl?.activeRunLeaseId ? ledger.runLease?.threadId : undefined) ??
      worktree.workspace.lastThreadId ??
      worktree.issue.latestThreadId ??
      ledger.runLease?.threadId;
    return {
      ...worktree,
      ...(resumeThreadId ? { resumeThreadId } : {}),
    };
  }

  retry(issueKey: string, options?: { stage?: WorkflowStage; reason?: string }): RetryResult | undefined {
    const issue = this.db.issueWorkflows.getTrackedIssueByKey(issueKey);
    if (!issue) {
      return undefined;
    }
    const ledger = this.getLedgerIssueContext(issue.projectId, issue.linearIssueId);
    if (ledger.issueControl?.activeRunLeaseId !== undefined) {
      throw new Error(`Issue ${issueKey} already has an active stage run.`);
    }

    const stage = options?.stage ?? resolveStageFromState(this.config, issue.projectId, issue.currentLinearState);
    if (!stage) {
      throw new Error(`Unable to infer a stage for ${issueKey}; pass --stage.`);
    }

    const webhookId = `cli-retry-${Date.now()}`;
    const receipt = this.db.eventReceipts.insertEventReceipt({
      source: "linear-webhook",
      externalId: webhookId,
      eventType: "cli-retry",
      receivedAt: new Date().toISOString(),
      acceptanceStatus: "accepted",
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
    });
    this.db.issueControl.upsertIssueControl({
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      desiredStage: stage,
      desiredReceiptId: receipt.id,
      lifecycleStatus: "queued",
    });
    this.db.issueWorkflows.setIssueDesiredStage(issue.projectId, issue.linearIssueId, stage, webhookId);
    const updated = this.db.issueWorkflows.getTrackedIssue(issue.projectId, issue.linearIssueId)!;
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
      conditions.push("ai.project_id = ?");
      values.push(options.project);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const rows = this.db.connection
      .prepare(
        `
        WITH all_issues AS (
          SELECT project_id, linear_issue_id FROM issue_projection
          UNION
          SELECT project_id, linear_issue_id FROM issue_control
        )
        SELECT
          ai.project_id,
          ai.linear_issue_id,
          ip.issue_key,
          ip.title,
          ip.current_linear_state,
          COALESCE(ic.lifecycle_status, 'idle') AS lifecycle_status,
          COALESCE(ic.updated_at, ip.updated_at) AS updated_at,
          active_run.stage AS active_stage,
          latest_run.stage AS latest_stage,
          latest_run.status AS latest_stage_status
        FROM all_issues ai
        LEFT JOIN issue_projection ip
          ON ip.project_id = ai.project_id AND ip.linear_issue_id = ai.linear_issue_id
        LEFT JOIN issue_control ic
          ON ic.project_id = ai.project_id AND ic.linear_issue_id = ai.linear_issue_id
        LEFT JOIN run_leases active_run
          ON active_run.id = ic.active_run_lease_id
        LEFT JOIN run_leases latest_run ON latest_run.id = (
          SELECT rl.id
          FROM run_leases rl
          WHERE rl.project_id = ai.project_id AND rl.linear_issue_id = ai.linear_issue_id
          ORDER BY rl.id DESC
          LIMIT 1
        )
        ${whereClause}
        ORDER BY COALESCE(ic.updated_at, ip.updated_at) DESC, ip.issue_key ASC, ai.linear_issue_id ASC
        `,
      )
      .all(...values) as Array<Record<string, unknown>>;

    const items = rows.map((row) => {
      const projectId = String(row.project_id);
      const linearIssueId = String(row.linear_issue_id);
      const issueKey = row.issue_key === null ? undefined : String(row.issue_key);
      const issue = this.db.issueWorkflows.getTrackedIssue(projectId, linearIssueId);
      const ledger = issue ? this.getLedgerIssueContext(issue.projectId, issue.linearIssueId) : undefined;

      return {
        ...(issueKey ? { issueKey } : {}),
        ...(row.title === null ? {} : { title: String(row.title) }),
        projectId,
        ...(row.current_linear_state === null ? {} : { currentLinearState: String(row.current_linear_state) }),
        lifecycleStatus: String(row.lifecycle_status),
        ...(ledger?.runLease
          ? { activeStage: ledger.runLease.stage }
          : row.active_stage !== null
            ? { activeStage: row.active_stage as WorkflowStage }
            : {}),
        ...(row.latest_stage !== null
          ? { latestStage: row.latest_stage as WorkflowStage }
          : ledger?.mirroredStageRun
            ? { latestStage: ledger.mirroredStageRun.stage }
            : {}),
        ...(row.latest_stage_status !== null
          ? { latestStageStatus: String(row.latest_stage_status) }
          : ledger?.mirroredStageRun
            ? { latestStageStatus: ledger.mirroredStageRun.status }
            : {}),
        updatedAt: String(row.updated_at),
      };
    });

    return items.filter((item) => {
      if (options?.active && !item.activeStage) {
        return false;
      }
      if (options?.failed && item.latestStageStatus !== "failed") {
        return false;
      }
      return true;
    });
  }

  private getLedgerIssueContext(projectId: string, linearIssueId: string): LedgerIssueContext {
    const issueControl = this.db.issueControl.getIssueControl(projectId, linearIssueId);
    const runLease = issueControl?.activeRunLeaseId ? this.db.runLeases.getRunLease(issueControl.activeRunLeaseId) : undefined;
    const workspaceOwnership = issueControl?.activeWorkspaceOwnershipId
      ? this.db.workspaceOwnership.getWorkspaceOwnership(issueControl.activeWorkspaceOwnershipId)
      : undefined;
    const mirroredStageRun = issueControl?.activeRunLeaseId ? this.db.issueWorkflows.getStageRun(issueControl.activeRunLeaseId) : undefined;

    return {
      ...(issueControl ? { issueControl } : {}),
      ...(runLease ? { runLease } : {}),
      ...(workspaceOwnership ? { workspaceOwnership } : {}),
      ...(mirroredStageRun ? { mirroredStageRun } : {}),
    };
  }

  private getActiveStageRunForIssue(issue: TrackedIssueRecord, ledger?: LedgerIssueContext): StageRunRecord | undefined {
    const context = ledger ?? this.getLedgerIssueContext(issue.projectId, issue.linearIssueId);
    const activeStageRun = context.mirroredStageRun ?? this.synthesizeStageRunFromLease(context);

    if (!activeStageRun) {
      return undefined;
    }

    return activeStageRun.projectId === issue.projectId && activeStageRun.linearIssueId === issue.linearIssueId
      ? activeStageRun
      : undefined;
  }

  private synthesizeStageRunFromLease(ledger: LedgerIssueContext): StageRunRecord | undefined {
    if (!ledger.runLease) {
      return undefined;
    }

    return {
      id: -ledger.runLease.id,
      pipelineRunId: 0,
      projectId: ledger.runLease.projectId,
      linearIssueId: ledger.runLease.linearIssueId,
      workspaceId: 0,
      stage: ledger.runLease.stage,
      status:
        ledger.runLease.status === "failed"
          ? "failed"
          : ledger.runLease.status === "completed" || ledger.runLease.status === "released" || ledger.runLease.status === "paused"
            ? "completed"
            : "running",
      triggerWebhookId: "ledger-active-run",
      workflowFile: ledger.runLease.workflowFile,
      promptText: ledger.runLease.promptText,
      ...(ledger.runLease.threadId ? { threadId: ledger.runLease.threadId } : {}),
      ...(ledger.runLease.parentThreadId ? { parentThreadId: ledger.runLease.parentThreadId } : {}),
      ...(ledger.runLease.turnId ? { turnId: ledger.runLease.turnId } : {}),
      startedAt: ledger.runLease.startedAt,
      ...(ledger.runLease.endedAt ? { endedAt: ledger.runLease.endedAt } : {}),
    };
  }

  private getWorkspaceForIssue(issue: TrackedIssueRecord, ledger?: LedgerIssueContext): WorkspaceRecord | undefined {
    const context = ledger ?? this.getLedgerIssueContext(issue.projectId, issue.linearIssueId);
    if (!context.issueControl?.activeRunLeaseId) {
      const activeWorkspace = this.db.issueWorkflows.getActiveWorkspaceForIssue(issue.projectId, issue.linearIssueId);
      if (activeWorkspace) {
        return activeWorkspace;
      }
    }

    const workspaceOwnership = context.workspaceOwnership;
    if (!workspaceOwnership) {
      return this.db.issueWorkflows.getActiveWorkspaceForIssue(issue.projectId, issue.linearIssueId);
    }

    return {
      id: workspaceOwnership.id,
      projectId: workspaceOwnership.projectId,
      linearIssueId: workspaceOwnership.linearIssueId,
      branchName: workspaceOwnership.branchName,
      worktreePath: workspaceOwnership.worktreePath,
      status:
        workspaceOwnership.status === "released"
          ? "closed"
          : workspaceOwnership.status === "paused"
            ? "paused"
            : "active",
      ...(context.runLease?.threadId ? { lastThreadId: context.runLease.threadId } : {}),
      createdAt: workspaceOwnership.createdAt,
      updatedAt: workspaceOwnership.updatedAt,
    };
  }

  async connect(projectId?: string): Promise<ConnectResult> {
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

  private getOperatorBaseUrl(): string {
    const host = this.normalizeLocalHost(this.config.server.bind);
    return `http://${host}:${this.config.server.port}/`;
  }

  private normalizeLocalHost(bind: string): string {
    if (bind === "0.0.0.0") {
      return "127.0.0.1";
    }
    if (bind === "::") {
      return "[::1]";
    }
    if (bind.includes(":") && !bind.startsWith("[")) {
      return `[${bind}]`;
    }
    return bind;
  }

  private async requestJson<T>(
    pathname: string,
    query?: Record<string, string | undefined>,
    init?: { method?: "GET" | "POST" | "DELETE"; body?: unknown },
  ): Promise<T> {
    const url = new URL(pathname, this.getOperatorBaseUrl());
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
