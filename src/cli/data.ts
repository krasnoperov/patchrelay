import { existsSync } from "node:fs";
import pino from "pino";
import { CodexAppServerClient } from "../codex-app-server.ts";
import { getThreadTurns } from "../codex-thread-utils.ts";
import { PatchRelayDatabase } from "../db.ts";
import { WorktreeManager } from "../worktree-manager.ts";
import { CliOperatorApiClient } from "./operator-client.ts";
import type { RunType } from "../factory-state.ts";
import type {
  AppConfig,
  CodexThreadItem,
  CodexThreadSummary,
  IssueRecord,
  StageReport,
  RunRecord,
  TrackedIssueRecord,
} from "../types.ts";
export type {
  CliOperatorDataAccess,
  ConnectResult,
  ConnectStateResult,
  InstallationListResult,
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
  sessionState?: string | undefined;
  waitingReason?: string | undefined;
  statusNote?: string | undefined;
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

export interface IssueSessionHistoryItem {
  runId: number;
  runType: string;
  status: string;
  threadId?: string;
  turnId?: string;
  parentThreadId?: string;
  summary?: string;
  failureReason?: string;
  eventCount: number;
  startedAt: string;
  endedAt?: string;
  isCurrentThread: boolean;
}

export interface IssueSessionHistoryResult {
  issue: TrackedIssueRecord;
  worktreePath?: string;
  currentThreadId?: string;
  sessions: IssueSessionHistoryItem[];
}

export interface ListResultItem {
  issueKey?: string;
  title?: string;
  projectId: string;
  currentLinearState?: string;
  sessionState?: string;
  factoryState: string;
  activeRunType?: string;
  latestRunType?: string;
  latestRunStatus?: string;
  waitingReason?: string;
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

function normalizeStageReport(reportJson: string | undefined, runStatus: string | undefined): StageReport | undefined {
  if (!reportJson) return undefined;
  try {
    const parsed = JSON.parse(reportJson) as StageReport;
    return { ...parsed, status: runStatus ?? parsed.status };
  } catch {
    return undefined;
  }
}

function summarizeThread(thread: CodexThreadSummary, latestTimestampSeen?: string): LiveSummary {
  const turns = getThreadTurns(thread);
  const latestTurn = turns.at(-1);
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

function parseObjectJson(value: string | undefined): Record<string, unknown> | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function summarizeRun(run: RunRecord): string | undefined {
  const summary = parseObjectJson(run.summaryJson);
  if (typeof summary?.latestAssistantMessage === "string" && summary.latestAssistantMessage.trim()) {
    return summary.latestAssistantMessage.trim();
  }

  const report = parseObjectJson(run.reportJson);
  const assistantMessages = report?.assistantMessages;
  if (Array.isArray(assistantMessages)) {
    for (let index = assistantMessages.length - 1; index >= 0; index -= 1) {
      const value = assistantMessages[index];
      if (typeof value === "string" && value.trim()) {
        return value.trim();
      }
    }
  }

  return run.failureReason?.trim() || undefined;
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
    const latestReport = normalizeStageReport(latestRun?.reportJson, latestRun?.status);
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
      ...(((dbIssue as { sessionState?: string }).sessionState) ? { sessionState: (dbIssue as { sessionState?: string }).sessionState } : {}),
      ...(((dbIssue as { waitingReason?: string }).waitingReason) ? { waitingReason: (dbIssue as { waitingReason?: string }).waitingReason } : {}),
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

    const runType = (options?.runType
      ?? (issue.latestFailureSource === "queue_eviction" || issue.factoryState === "repairing_queue"
        ? "queue_repair"
        : dbIssue.prCheckStatus === "failed" || dbIssue.prCheckStatus === "failure" || issue.latestFailureSource === "branch_ci" || issue.factoryState === "repairing_ci"
          ? "ci_repair"
          : dbIssue.prReviewState === "changes_requested" || issue.factoryState === "changes_requested"
            ? "review_fix"
            : "implementation")) as RunType;

    const factoryState = runType === "queue_repair"
      ? "repairing_queue"
      : runType === "ci_repair"
        ? "repairing_ci"
        : runType === "review_fix"
          ? "changes_requested"
          : "delegated";

    this.appendRetryWake(dbIssue, runType);
    this.db.upsertIssue({
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      pendingRunType: null,
      pendingRunContextJson: null,
      factoryState,
    });
    const updated = this.db.getTrackedIssue(issue.projectId, issue.linearIssueId)!;
    return { issue: updated, runType, ...(options?.reason ? { reason: options.reason } : {}) };
  }

  sessions(issueKey: string): IssueSessionHistoryResult | undefined {
    const issue = this.db.getTrackedIssueByKey(issueKey);
    if (!issue) return undefined;

    const dbIssue = this.db.getIssueByKey(issueKey)!;
    const runs = this.db.listRunsForIssue(issue.projectId, issue.linearIssueId);
    const sessions = runs
      .slice()
      .reverse()
      .map((run) => {
        const summary = summarizeRun(run);
        return {
          runId: run.id,
          runType: run.runType,
          status: run.status,
          ...(run.threadId ? { threadId: run.threadId } : {}),
          ...(run.turnId ? { turnId: run.turnId } : {}),
          ...(run.parentThreadId ? { parentThreadId: run.parentThreadId } : {}),
          ...(summary ? { summary } : {}),
          ...(run.failureReason ? { failureReason: run.failureReason } : {}),
          eventCount: this.db.listThreadEvents(run.id).length,
          startedAt: run.startedAt,
          ...(run.endedAt ? { endedAt: run.endedAt } : {}),
          isCurrentThread: run.threadId !== undefined && run.threadId === dbIssue.threadId,
        };
      });

    return {
      issue,
      ...(dbIssue.worktreePath ? { worktreePath: dbIssue.worktreePath } : {}),
      ...(dbIssue.threadId ? { currentThreadId: dbIssue.threadId } : {}),
      sessions,
    };
  }

  private appendRetryWake(issue: IssueRecord, runType: RunType): void {
    if (runType === "queue_repair") {
      const queueIncident = parseObjectJson(issue.lastQueueIncidentJson);
      const failureContext = parseObjectJson(issue.lastGitHubFailureContextJson);
      this.db.appendIssueSessionEventRespectingActiveLease(issue.projectId, issue.linearIssueId, {
        projectId: issue.projectId,
        linearIssueId: issue.linearIssueId,
        eventType: "merge_steward_incident",
        eventJson: JSON.stringify({
          ...(queueIncident ?? {}),
          ...(failureContext ?? {}),
          source: "operator_retry",
        }),
        dedupeKey: `operator_retry:queue_repair:${issue.linearIssueId}:${issue.prHeadSha ?? issue.lastGitHubFailureHeadSha ?? "unknown-sha"}`,
      });
      return;
    }

    if (runType === "ci_repair") {
      const failureContext = parseObjectJson(issue.lastGitHubFailureContextJson);
      this.db.appendIssueSessionEventRespectingActiveLease(issue.projectId, issue.linearIssueId, {
        projectId: issue.projectId,
        linearIssueId: issue.linearIssueId,
        eventType: "settled_red_ci",
        eventJson: JSON.stringify({
          ...(failureContext ?? {}),
          source: "operator_retry",
        }),
        dedupeKey: `operator_retry:ci_repair:${issue.linearIssueId}:${issue.lastGitHubFailureSignature ?? issue.prHeadSha ?? "unknown-sha"}`,
      });
      return;
    }

    if (runType === "review_fix") {
      this.db.appendIssueSessionEventRespectingActiveLease(issue.projectId, issue.linearIssueId, {
        projectId: issue.projectId,
        linearIssueId: issue.linearIssueId,
        eventType: "review_changes_requested",
        eventJson: JSON.stringify({
          reviewBody: "Operator requested retry of review-fix work.",
          source: "operator_retry",
        }),
        dedupeKey: `operator_retry:review_fix:${issue.linearIssueId}:${issue.prHeadSha ?? "unknown-sha"}`,
      });
      return;
    }

    this.db.appendIssueSessionEventRespectingActiveLease(issue.projectId, issue.linearIssueId, {
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      eventType: "delegated",
      eventJson: JSON.stringify({
        promptContext: "Operator requested retry of PatchRelay work.",
        source: "operator_retry",
      }),
      dedupeKey: `operator_retry:implementation:${issue.linearIssueId}`,
    });
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
          s.session_state,
          s.waiting_reason,
          active_run.run_type AS active_run_type,
          latest_run.run_type AS latest_run_type,
          latest_run.status AS latest_run_status
        FROM issues i
        LEFT JOIN issue_sessions s
          ON s.project_id = i.project_id
         AND s.linear_issue_id = i.linear_issue_id
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
      ...(row.session_state !== null ? { sessionState: String(row.session_state) } : {}),
      factoryState: String(row.factory_state ?? "delegated"),
      ...(row.waiting_reason !== null ? { waitingReason: String(row.waiting_reason) } : {}),
      ...(row.active_run_type !== null ? { activeRunType: String(row.active_run_type) } : {}),
      ...(row.latest_run_type !== null ? { latestRunType: String(row.latest_run_type) } : {}),
      ...(row.latest_run_status !== null ? { latestRunStatus: String(row.latest_run_status) } : {}),
      updatedAt: String(row.updated_at),
    }));

    return items.filter((item) => {
      if (options?.active && !item.activeRunType) return false;
      if (options?.failed && item.factoryState !== "failed" && item.factoryState !== "escalated") return false;
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
