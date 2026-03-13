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
  IssueControlRecord,
  RunLeaseRecord,
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

    const resumeThreadId = this.getStoredOpenThreadId(worktree);
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
    if (!worktree) {
      return undefined;
    }

    if (options?.ensureWorktree) {
      await this.ensureOpenWorktree(worktree);
    }

    const existingThreadId = await this.resolveStoredOpenThreadId(worktree);
    if (existingThreadId) {
      return {
        ...worktree,
        resumeThreadId: existingThreadId,
      };
    }

    if (!options?.createThreadIfMissing) {
      return {
        ...worktree,
        needsNewSession: true,
      };
    }

    const codex = await this.getCodex();
    const thread = await codex.startThread({
      cwd: worktree.workspace.worktreePath,
    });
    this.db.issueSessions.upsertIssueSession({
      projectId: worktree.issue.projectId,
      linearIssueId: worktree.issue.linearIssueId,
      workspaceOwnershipId: worktree.workspace.id,
      threadId: thread.id,
      source: "operator_open",
      ...(worktree.issue.activeAgentSessionId ? { linkedAgentSessionId: worktree.issue.activeAgentSessionId } : {}),
    });
    this.db.issueSessions.touchIssueSession(thread.id);

    return {
      ...worktree,
      resumeThreadId: thread.id,
    };
  }

  async prepareOpen(issueKey: string): Promise<OpenResult | undefined> {
    return await this.resolveOpen(issueKey, {
      ensureWorktree: true,
      createThreadIfMissing: true,
    });
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
    this.db.workflowCoordinator.setIssueDesiredStage(issue.projectId, issue.linearIssueId, stage, {
      desiredReceiptId: receipt.id,
      lifecycleStatus: "queued",
    });
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
          : ledger?.runLease
            ? { latestStage: ledger.runLease.stage }
            : {}),
        ...(row.latest_stage_status !== null
          ? { latestStageStatus: String(row.latest_stage_status) }
          : ledger?.runLease
            ? {
                latestStageStatus:
                  ledger.runLease.status === "failed"
                    ? "failed"
                    : ledger.runLease.status === "completed" || ledger.runLease.status === "released" || ledger.runLease.status === "paused"
                      ? "completed"
                      : "running",
              }
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

    return {
      ...(issueControl ? { issueControl } : {}),
      ...(runLease ? { runLease } : {}),
    };
  }

  private getActiveStageRunForIssue(issue: TrackedIssueRecord, ledger?: LedgerIssueContext): StageRunRecord | undefined {
    const context = ledger ?? this.getLedgerIssueContext(issue.projectId, issue.linearIssueId);
    const activeStageRun = context.issueControl?.activeRunLeaseId
      ? this.db.issueWorkflows.getStageRun(context.issueControl.activeRunLeaseId)
      : undefined;

    if (!activeStageRun) {
      return undefined;
    }

    return activeStageRun.projectId === issue.projectId && activeStageRun.linearIssueId === issue.linearIssueId
      ? activeStageRun
      : undefined;
  }

  private getWorkspaceForIssue(issue: TrackedIssueRecord, ledger?: LedgerIssueContext): WorkspaceRecord | undefined {
    const context = ledger ?? this.getLedgerIssueContext(issue.projectId, issue.linearIssueId);
    if (context.issueControl?.activeWorkspaceOwnershipId !== undefined) {
      const activeWorkspace = this.db.issueWorkflows.getWorkspace(context.issueControl.activeWorkspaceOwnershipId);
      if (activeWorkspace) {
        return activeWorkspace;
      }
    }

    return this.db.issueWorkflows.getActiveWorkspaceForIssue(issue.projectId, issue.linearIssueId);
  }

  private getStoredOpenThreadId(worktree: WorktreeResult): string | undefined {
    return this.listOpenCandidateThreadIds(worktree).at(0);
  }

  private async resolveStoredOpenThreadId(worktree: WorktreeResult): Promise<string | undefined> {
    for (const threadId of this.listOpenCandidateThreadIds(worktree)) {
      if (!(await this.canReadThread(threadId))) {
        continue;
      }

      this.recordOpenThreadForIssue(worktree, threadId);
      return threadId;
    }

    return undefined;
  }

  private listOpenCandidateThreadIds(worktree: WorktreeResult): string[] {
    const ledger = this.getLedgerIssueContext(worktree.issue.projectId, worktree.issue.linearIssueId);
    const sessions = this.db.issueSessions.listIssueSessionsForIssue(worktree.issue.projectId, worktree.issue.linearIssueId);
    const candidates = [
      ledger.issueControl?.activeRunLeaseId ? ledger.runLease?.threadId : undefined,
      ...sessions.map((session) => session.threadId),
      worktree.workspace.lastThreadId,
      worktree.issue.latestThreadId,
      ledger.runLease?.threadId,
    ];

    const seen = new Set<string>();
    const ordered: string[] = [];
    for (const candidate of candidates) {
      if (!candidate || seen.has(candidate)) {
        continue;
      }
      seen.add(candidate);
      ordered.push(candidate);
    }
    return ordered;
  }

  private recordOpenThreadForIssue(worktree: WorktreeResult, threadId: string): void {
    const existing = this.db.issueSessions.getIssueSessionByThreadId(threadId);
    if (existing) {
      this.db.issueSessions.touchIssueSession(threadId);
      return;
    }

    const runLease = this.db.runLeases.getRunLeaseByThreadId(threadId);
    this.db.issueSessions.upsertIssueSession({
      projectId: worktree.issue.projectId,
      linearIssueId: worktree.issue.linearIssueId,
      workspaceOwnershipId: runLease?.workspaceOwnershipId ?? worktree.workspace.id,
      threadId,
      source: runLease ? "stage_run" : "operator_open",
      ...(runLease?.id !== undefined ? { runLeaseId: runLease.id } : {}),
      ...(runLease?.parentThreadId ? { parentThreadId: runLease.parentThreadId } : {}),
      ...(worktree.issue.activeAgentSessionId ? { linkedAgentSessionId: worktree.issue.activeAgentSessionId } : {}),
    });
    this.db.issueSessions.touchIssueSession(threadId);
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
    if (existsSync(worktree.workspace.worktreePath)) {
      return;
    }

    const project = this.config.projects.find((entry) => entry.id === worktree.repoId);
    if (!project) {
      throw new Error(`Project not found for ${worktree.repoId}`);
    }

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
