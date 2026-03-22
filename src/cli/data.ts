import { existsSync } from "node:fs";
import pino from "pino";
import { CodexAppServerClient } from "../codex-app-server.ts";
import { PatchRelayDatabase } from "../db.ts";
import { WorktreeManager } from "../worktree-manager.ts";
import { CliOperatorApiClient } from "./operator-client.ts";
import type { RunType } from "../factory-state.ts";
import type {
  AppConfig,
  CodexThreadItem,
  CodexThreadSummary,
  StageReport,
  RunRecord,
  TrackedIssueRecord,
} from "../types.ts";
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
  activeRun?: RunRecord | undefined;
  latestRun?: RunRecord | undefined;
  latestReport?: StageReport | undefined;
  latestSummary?: Record<string, unknown> | undefined;
  prNumber?: number | undefined;
  prReviewState?: string | undefined;
  statusNote?: string | undefined;
}

export interface ReportResult {
  issue: TrackedIssueRecord;
  runs: Array<{
    run: RunRecord;
    report?: StageReport;
    summary?: Record<string, unknown>;
  }>;
}

export interface EventsResult {
  issue: TrackedIssueRecord;
  run: RunRecord;
  events: Array<{
    id: number;
    runId: number;
    threadId: string;
    turnId?: string | undefined;
    method: string;
    eventJson: string;
    createdAt: string;
    parsedEvent?: Record<string, unknown>;
  }>;
}

export interface WorktreeResult {
  issue: TrackedIssueRecord;
  branchName: string;
  worktreePath: string;
  repoId: string;
}

export interface OpenResult extends WorktreeResult {
  resumeThreadId?: string;
  needsNewSession?: boolean;
}

export interface RetryResult {
  issue: TrackedIssueRecord;
  runType: string;
  reason?: string;
}

export interface ListResultItem {
  issueKey?: string;
  title?: string;
  projectId: string;
  currentLinearState?: string;
  factoryState: string;
  activeRunType?: string;
  latestRunType?: string;
  latestRunStatus?: string;
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

function latestEventTimestamp(db: PatchRelayDatabase, runId: number): string | undefined {
  const events = db.listThreadEvents(runId);
  return events.at(-1)?.createdAt;
}

// resolveStageFromState removed — factory state replaces workflow stage resolution

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
    const activeRun = dbIssue.activeRunId ? this.db.getRun(dbIssue.activeRunId) : undefined;
    const latestRun = this.db.getLatestRunForIssue(issue.projectId, issue.linearIssueId);
    const latestReport = latestRun?.reportJson ? (JSON.parse(latestRun.reportJson) as StageReport) : undefined;
    const latestSummary = safeJsonParse(latestRun?.summaryJson);

    const statusNote =
      latestReport?.assistantMessages.at(-1) ??
      (typeof latestSummary?.latestAssistantMessage === "string" ? latestSummary.latestAssistantMessage : undefined) ??
      (latestRun?.status === "failed" ? "Latest run failed." : undefined) ??
      undefined;

    return {
      issue,
      ...(activeRun ? { activeRun } : {}),
      ...(!activeRun && latestRun ? { latestRun } : {}),
      ...(latestReport ? { latestReport } : {}),
      ...(latestSummary ? { latestSummary } : {}),
      ...(dbIssue.prNumber ? { prNumber: dbIssue.prNumber } : {}),
      ...(dbIssue.prReviewState ? { prReviewState: dbIssue.prReviewState } : {}),
      ...(statusNote ? { statusNote } : {}),
    };
  }

  async live(issueKey: string): Promise<
    | { issue: TrackedIssueRecord; run: RunRecord; live?: LiveSummary }
    | undefined
  > {
    const issue = this.db.getTrackedIssueByKey(issueKey);
    if (!issue) return undefined;

    const dbIssue = this.db.getIssueByKey(issueKey)!;
    const run = dbIssue.activeRunId ? this.db.getRun(dbIssue.activeRunId) : undefined;
    if (!run) return undefined;

    const live =
      run.threadId &&
      (await this.readLiveSummary(run.threadId, latestEventTimestamp(this.db, run.id)).catch(() => undefined));

    return { issue, run, ...(live ? { live } : {}) };
  }

  report(issueKey: string, options?: { runType?: string; runId?: number }): ReportResult | undefined {
    const issue = this.db.getTrackedIssueByKey(issueKey);
    if (!issue) return undefined;

    const runs = this.db
      .listRunsForIssue(issue.projectId, issue.linearIssueId)
      .filter((run) => {
        if (options?.runId !== undefined && run.id !== options.runId) return false;
        if (options?.runType !== undefined && run.runType !== options.runType) return false;
        return true;
      })
      .reverse()
      .map((run) => ({
        run,
        ...(run.reportJson ? { report: JSON.parse(run.reportJson) as StageReport } : {}),
        ...(safeJsonParse(run.summaryJson) ? { summary: safeJsonParse(run.summaryJson)! } : {}),
      }));

    return { issue, runs };
  }

  events(issueKey: string, options?: { runId?: number; method?: string; afterId?: number }): EventsResult | undefined {
    const issue = this.db.getTrackedIssueByKey(issueKey);
    if (!issue) return undefined;

    const dbIssue = this.db.getIssueByKey(issueKey)!;
    const run =
      (options?.runId !== undefined ? this.db.getRun(options.runId) : undefined) ??
      (dbIssue.activeRunId ? this.db.getRun(dbIssue.activeRunId) : undefined) ??
      this.db.getLatestRunForIssue(issue.projectId, issue.linearIssueId);
    if (!run || run.projectId !== issue.projectId || run.linearIssueId !== issue.linearIssueId) return undefined;

    const events = this.db
      .listThreadEvents(run.id)
      .filter((event) => (options?.method ? event.method === options.method : true))
      .filter((event) => (options?.afterId !== undefined ? event.id > options.afterId : true))
      .map((event) => ({
        ...event,
        ...(safeJsonParse(event.eventJson) ? { parsedEvent: safeJsonParse(event.eventJson)! } : {}),
      }));

    return { issue, run, events };
  }

  worktree(issueKey: string): WorktreeResult | undefined {
    const issue = this.db.getTrackedIssueByKey(issueKey);
    if (!issue) return undefined;

    const dbIssue = this.db.getIssueByKey(issueKey)!;
    if (!dbIssue.branchName || !dbIssue.worktreePath) return undefined;

    return { issue, branchName: dbIssue.branchName, worktreePath: dbIssue.worktreePath, repoId: issue.projectId };
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
    const thread = await codex.startThread({ cwd: worktree.worktreePath });
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

  retry(issueKey: string, options?: { runType?: string; reason?: string }): RetryResult | undefined {
    const issue = this.db.getTrackedIssueByKey(issueKey);
    if (!issue) return undefined;

    const dbIssue = this.db.getIssueByKey(issueKey)!;
    if (dbIssue.activeRunId !== undefined) {
      throw new Error(`Issue ${issueKey} already has an active run.`);
    }

    const runType = (options?.runType ?? "implementation") as RunType;

    this.db.upsertIssue({
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      pendingRunType: runType,
      factoryState: "delegated",
    });
    const updated = this.db.getTrackedIssue(issue.projectId, issue.linearIssueId)!;
    return { issue: updated, runType, ...(options?.reason ? { reason: options.reason } : {}) };
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
          i.factory_state,
          i.updated_at,
          active_run.run_type AS active_run_type,
          latest_run.run_type AS latest_run_type,
          latest_run.status AS latest_run_status
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

    const items: ListResultItem[] = rows.map((row) => ({
      ...(row.issue_key !== null ? { issueKey: String(row.issue_key) } : {}),
      ...(row.title !== null ? { title: String(row.title) } : {}),
      projectId: String(row.project_id),
      ...(row.current_linear_state !== null ? { currentLinearState: String(row.current_linear_state) } : {}),
      factoryState: String(row.factory_state ?? "delegated"),
      ...(row.active_run_type !== null ? { activeRunType: String(row.active_run_type) } : {}),
      ...(row.latest_run_type !== null ? { latestRunType: String(row.latest_run_type) } : {}),
      ...(row.latest_run_status !== null ? { latestRunStatus: String(row.latest_run_status) } : {}),
      updatedAt: String(row.updated_at),
    }));

    return items.filter((item) => {
      if (options?.active && !item.activeRunType) return false;
      if (options?.failed && item.latestRunStatus !== "failed") return false;
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
    if (existsSync(worktree.worktreePath)) return;
    const project = this.config.projects.find((entry) => entry.id === worktree.repoId);
    if (!project) throw new Error(`Project not found for ${worktree.repoId}`);
    const worktreeManager = new WorktreeManager(this.config);
    await worktreeManager.ensureIssueWorktree(
      project.repoPath,
      project.worktreeRoot,
      worktree.worktreePath,
      worktree.branchName,
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
