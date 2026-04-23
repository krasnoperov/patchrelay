import { existsSync } from "node:fs";
import pino from "pino";
import { CodexAppServerClient } from "../codex-app-server.ts";
import { type CodexSessionSourceRecord, resolveCodexSessionSource } from "../codex-session-source.ts";
import { extractCompletionCheck } from "../completion-check.ts";
import { getThreadTurns } from "../codex-thread-utils.ts";
import { PatchRelayDatabase } from "../db.ts";
import { buildManualRetryAttemptReset, resolveRetryTarget } from "../manual-issue-actions.ts";
import { buildOperatorRetryEvent } from "../operator-retry-event.ts";
import { WorktreeManager } from "../worktree-manager.ts";
import { parseDelegationObservedPayload, parseRunReleasedAuthorityPayload } from "../delegation-audit.ts";
import { CliOperatorApiClient } from "./operator-client.ts";
import type { RunType } from "../factory-state.ts";
import { resolveEffectiveActiveRun } from "../effective-active-run.ts";
import { derivePatchRelayWaitingReason } from "../waiting-reason.ts";
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
  prState?: string | undefined;
  prReviewState?: string | undefined;
  sessionState?: string | undefined;
  waitingReason?: string | undefined;
  statusNote?: string | undefined;
  completionCheckOutcome?: string | undefined;
  completionCheckSummary?: string | undefined;
  completionCheckQuestion?: string | undefined;
  completionCheckWhy?: string | undefined;
  completionCheckRecommendedReply?: string | undefined;
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

export interface PromptResult {
  issueKey: string;
  delivered: boolean;
  queued?: boolean;
}

export interface IssueAuditItem {
  createdAt: string;
  eventType: string;
  summary: string;
  details?: Record<string, unknown> | undefined;
}

export interface IssueAuditResult {
  issue: TrackedIssueRecord;
  events: IssueAuditItem[];
}

export interface CloseResult {
  issue: TrackedIssueRecord;
  factoryState: "done" | "failed";
  reason?: string;
  releasedRunId?: number;
}

export interface IssueSessionHistoryItem {
  sessionSource?: CodexSessionSourceRecord;
  runId: number;
  runType: string;
  status: string;
  threadId?: string;
  turnId?: string;
  parentThreadId?: string;
  summary?: string;
  failureReason?: string;
  eventCount: number;
  eventCountAvailable: boolean;
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

export interface IssueTranscriptSourceResult {
  issue: TrackedIssueRecord;
  runId?: number;
  runType?: string;
  runStatus?: string;
  threadId?: string;
  turnId?: string;
  worktreePath?: string;
  sessionSource?: CodexSessionSourceRecord;
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
  const events = db.runs.listThreadEvents(runId);
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
  const completionCheck = extractCompletionCheck(run);
  if (completionCheck) {
    return completionCheck.outcome === "needs_input"
      ? completionCheck.question ?? completionCheck.summary
      : completionCheck.summary;
  }

  const summary = parseObjectJson(run.summaryJson);
  if (typeof summary?.publicationRecapSummary === "string" && summary.publicationRecapSummary.trim()) {
    return summary.publicationRecapSummary.trim();
  }
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

    const dbIssue = this.db.issues.getIssueByKey(issueKey)!;
    const latestRun = this.db.runs.getLatestRunForIssue(issue.projectId, issue.linearIssueId);
    const activeRun = resolveEffectiveActiveRun({
      activeRun: dbIssue.activeRunId ? this.db.runs.getRunById(dbIssue.activeRunId) : undefined,
      latestRun,
    });
    const latestReport = normalizeStageReport(latestRun?.reportJson, latestRun?.status);
    const latestSummary = safeJsonParse(latestRun?.summaryJson);
    const completionCheck = latestRun ? extractCompletionCheck(latestRun) : undefined;

    const statusNote =
      (completionCheck?.outcome === "needs_input" ? completionCheck.question : completionCheck?.summary) ??
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
      ...(dbIssue.prState ? { prState: dbIssue.prState } : {}),
      ...(dbIssue.prReviewState ? { prReviewState: dbIssue.prReviewState } : {}),
      ...(((dbIssue as { sessionState?: string }).sessionState) ? { sessionState: (dbIssue as { sessionState?: string }).sessionState } : {}),
      ...(((dbIssue as { waitingReason?: string }).waitingReason) ? { waitingReason: (dbIssue as { waitingReason?: string }).waitingReason } : {}),
      ...(statusNote ? { statusNote } : {}),
      ...(completionCheck?.outcome ? { completionCheckOutcome: completionCheck.outcome } : {}),
      ...(completionCheck?.summary ? { completionCheckSummary: completionCheck.summary } : {}),
      ...(completionCheck?.question ? { completionCheckQuestion: completionCheck.question } : {}),
      ...(completionCheck?.why ? { completionCheckWhy: completionCheck.why } : {}),
      ...(completionCheck?.recommendedReply ? { completionCheckRecommendedReply: completionCheck.recommendedReply } : {}),
    };
  }

  async live(issueKey: string): Promise<
    | { issue: TrackedIssueRecord; run: RunRecord; live?: LiveSummary }
    | undefined
  > {
    const issue = this.db.getTrackedIssueByKey(issueKey);
    if (!issue) return undefined;

    const dbIssue = this.db.issues.getIssueByKey(issueKey)!;
    const run = resolveEffectiveActiveRun({
      activeRun: dbIssue.activeRunId ? this.db.runs.getRunById(dbIssue.activeRunId) : undefined,
      latestRun: this.db.runs.getLatestRunForIssue(issue.projectId, issue.linearIssueId),
    });
    if (!run) return undefined;

    const live =
      run.threadId &&
      (await this.readLiveSummary(run.threadId, latestEventTimestamp(this.db, run.id)).catch(() => undefined));

    return { issue, run, ...(live ? { live } : {}) };
  }

  worktree(issueKey: string): WorktreeResult | undefined {
    const issue = this.db.getTrackedIssueByKey(issueKey);
    if (!issue) return undefined;

    const dbIssue = this.db.issues.getIssueByKey(issueKey)!;
    if (!dbIssue.branchName || !dbIssue.worktreePath) return undefined;

    return { issue, branchName: dbIssue.branchName, worktreePath: dbIssue.worktreePath, repoId: issue.projectId };
  }

  open(issueKey: string): OpenResult | undefined {
    const worktree = this.worktree(issueKey);
    if (!worktree) return undefined;

    const dbIssue = this.db.issues.getIssueByKey(issueKey)!;
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

    const dbIssue = this.db.issues.getIssueByKey(issueKey)!;
    const existingThreadId = dbIssue.threadId;
    if (existingThreadId && (await this.canReadThread(existingThreadId))) {
      return { ...worktree, resumeThreadId: existingThreadId };
    }

    if (!options?.createThreadIfMissing) {
      return { ...worktree, needsNewSession: true };
    }

    const codex = await this.getCodex();
    const thread = await codex.startThread({ cwd: worktree.worktreePath });
    this.db.issues.upsertIssue({
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

    const dbIssue = this.db.issues.getIssueByKey(issueKey)!;
    const issueSession = this.db.issueSessions.getIssueSession(issue.projectId, issue.linearIssueId);
    if (dbIssue.activeRunId !== undefined) {
      throw new Error(`Issue ${issueKey} already has an active run.`);
    }

    const runType = (options?.runType
      ?? resolveRetryTarget({
        prNumber: dbIssue.prNumber,
        prState: dbIssue.prState,
        prReviewState: dbIssue.prReviewState,
        prCheckStatus: dbIssue.prCheckStatus,
        pendingRunType: dbIssue.pendingRunType,
        lastRunType: issueSession?.lastRunType,
        lastGitHubFailureSource: issue.latestFailureSource,
      }).runType) as RunType;

    const factoryState = runType === "queue_repair"
      ? "repairing_queue"
      : runType === "ci_repair"
        ? "repairing_ci"
        : runType === "review_fix" || runType === "branch_upkeep"
          ? "changes_requested"
          : "delegated";

    this.appendRetryWake(dbIssue, runType);
    this.db.issues.upsertIssue({
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      pendingRunType: null,
      pendingRunContextJson: null,
      factoryState,
      ...buildManualRetryAttemptReset(runType),
    });
    const updated = this.db.getTrackedIssue(issue.projectId, issue.linearIssueId)!;
    return { issue: updated, runType, ...(options?.reason ? { reason: options.reason } : {}) };
  }

  closeIssue(issueKey: string, options?: { failed?: boolean; reason?: string }): CloseResult | undefined {
    const issue = this.db.getTrackedIssueByKey(issueKey);
    if (!issue) return undefined;

    const dbIssue = this.db.issues.getIssueByKey(issueKey)!;
    const terminalState = options?.failed ? "failed" : "done";
    const run = dbIssue.activeRunId ? this.db.runs.getRunById(dbIssue.activeRunId) : undefined;

    this.db.issueSessions.appendIssueSessionEventRespectingActiveLease(issue.projectId, issue.linearIssueId, {
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      eventType: "operator_closed",
      eventJson: JSON.stringify({
        terminalState,
        ...(options?.reason ? { reason: options.reason } : {}),
      }),
      dedupeKey: `operator_closed:${issue.linearIssueId}:${terminalState}:${dbIssue.activeRunId ?? "no-run"}`,
    });
    this.db.issueSessions.clearPendingIssueSessionEventsRespectingActiveLease(issue.projectId, issue.linearIssueId);
    if (run) {
      this.db.issueSessions.finishRunRespectingActiveLease(issue.projectId, issue.linearIssueId, run.id, {
        status: "released",
        failureReason: options?.reason
          ? `Operator closed issue as ${terminalState}: ${options.reason}`
          : `Operator closed issue as ${terminalState}`,
      });
    }
    this.db.issueSessions.upsertIssueRespectingActiveLease(issue.projectId, issue.linearIssueId, {
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      delegatedToPatchRelay: false,
      factoryState: terminalState as never,
      activeRunId: null,
      pendingRunType: null,
      pendingRunContextJson: null,
    });
    this.db.issueSessions.releaseIssueSessionLeaseRespectingActiveLease(issue.projectId, issue.linearIssueId);

    const updated = this.db.getTrackedIssue(issue.projectId, issue.linearIssueId)!;
    return {
      issue: updated,
      factoryState: terminalState,
      ...(options?.reason ? { reason: options.reason } : {}),
      ...(run ? { releasedRunId: run.id } : {}),
    };
  }

  audit(issueKey: string): IssueAuditResult | undefined {
    const issue = this.db.getTrackedIssueByKey(issueKey);
    if (!issue) return undefined;

    const events = this.db.issueSessions
      .listIssueSessionEvents(issue.projectId, issue.linearIssueId)
      .flatMap((event): IssueAuditItem[] => {
        const delegationObserved = parseDelegationObservedPayload(event);
        if (delegationObserved) {
          return [{
            createdAt: event.createdAt,
            eventType: event.eventType,
            summary: [
              delegationObserved.source,
              `observed=${delegationObserved.observedDelegatedToPatchRelay ? "delegated" : "undelegated"}`,
              `applied=${delegationObserved.appliedDelegatedToPatchRelay ? "delegated" : "undelegated"}`,
              `hydration=${delegationObserved.hydration}`,
              delegationObserved.reason ? `reason=${delegationObserved.reason}` : undefined,
            ].filter(Boolean).join(" "),
            details: delegationObserved as unknown as Record<string, unknown>,
          }];
        }

        const authorityRelease = parseRunReleasedAuthorityPayload(event);
        if (authorityRelease) {
          return [{
            createdAt: event.createdAt,
            eventType: event.eventType,
            summary: `released run #${authorityRelease.runId} (${authorityRelease.runType}) via ${authorityRelease.source}: ${authorityRelease.reason}`,
            details: authorityRelease as unknown as Record<string, unknown>,
          }];
        }

        if (event.eventType === "delegated" || event.eventType === "undelegated") {
          return [{
            createdAt: event.createdAt,
            eventType: event.eventType,
            summary: event.eventType === "delegated"
              ? "PatchRelay accepted delegation"
              : "PatchRelay recorded undelegation",
          }];
        }

        return [];
      });

    return { issue, events };
  }

  transcriptSource(issueKey: string, runId?: number): IssueTranscriptSourceResult | undefined {
    const issue = this.db.getTrackedIssueByKey(issueKey);
    if (!issue) return undefined;

    const dbIssue = this.db.issues.getIssueByKey(issueKey)!;
    const runs = this.db.runs.listRunsForIssue(issue.projectId, issue.linearIssueId);
    const selectedRun = runId !== undefined
      ? runs.find((run) => run.id === runId)
      : runs.slice().reverse().find((run) => run.threadId);
    const threadId = selectedRun?.threadId ?? dbIssue.threadId;

    return {
      issue,
      ...(selectedRun ? { runId: selectedRun.id, runType: selectedRun.runType, runStatus: selectedRun.status } : {}),
      ...(threadId ? { threadId } : {}),
      ...(selectedRun?.turnId ? { turnId: selectedRun.turnId } : {}),
      ...(dbIssue.worktreePath ? { worktreePath: dbIssue.worktreePath } : {}),
      ...(threadId ? { sessionSource: resolveCodexSessionSource(threadId) } : {}),
    };
  }

  sessions(issueKey: string): IssueSessionHistoryResult | undefined {
    const issue = this.db.getTrackedIssueByKey(issueKey);
    if (!issue) return undefined;

    const dbIssue = this.db.issues.getIssueByKey(issueKey)!;
    const runs = this.db.runs.listRunsForIssue(issue.projectId, issue.linearIssueId);
    const sessions = runs
      .slice()
      .reverse()
      .map((run) => {
        const summary = summarizeRun(run);
        const eventCount = this.db.runs.listThreadEvents(run.id).length;
        const sessionSource = run.threadId ? resolveCodexSessionSource(run.threadId) : undefined;
        return {
          runId: run.id,
          runType: run.runType,
          status: run.status,
          ...(run.threadId ? { threadId: run.threadId } : {}),
          ...(run.turnId ? { turnId: run.turnId } : {}),
          ...(run.parentThreadId ? { parentThreadId: run.parentThreadId } : {}),
          ...(summary ? { summary } : {}),
          ...(run.failureReason ? { failureReason: run.failureReason } : {}),
          ...(sessionSource ? { sessionSource } : {}),
          eventCount,
          eventCountAvailable: this.config.runner.codex.persistExtendedHistory || eventCount > 0,
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
    this.db.issueSessions.appendIssueSessionEventRespectingActiveLease(issue.projectId, issue.linearIssueId, {
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      ...buildOperatorRetryEvent(issue, runType),
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

    const items: ListResultItem[] = rows.map((row) => {
      const detachedActiveRun = row.active_run_type === null
        && (row.latest_run_status === "queued" || row.latest_run_status === "running");
      const activeRunType = row.active_run_type !== null
        ? String(row.active_run_type)
        : detachedActiveRun && row.latest_run_type !== null
          ? String(row.latest_run_type)
          : undefined;
      const waitingReason = detachedActiveRun
        ? derivePatchRelayWaitingReason({
            activeRunId: 1,
            factoryState: String(row.factory_state ?? "delegated"),
          })
        : row.waiting_reason !== null
          ? String(row.waiting_reason)
          : undefined;
      return {
        ...(row.issue_key !== null ? { issueKey: String(row.issue_key) } : {}),
        ...(row.title !== null ? { title: String(row.title) } : {}),
        projectId: String(row.project_id),
        ...(row.current_linear_state !== null ? { currentLinearState: String(row.current_linear_state) } : {}),
        ...(row.session_state !== null ? { sessionState: detachedActiveRun ? "running" : String(row.session_state) } : {}),
        factoryState: String(row.factory_state ?? "delegated"),
        ...(waitingReason ? { waitingReason } : {}),
        ...(activeRunType ? { activeRunType } : {}),
        ...(row.latest_run_type !== null ? { latestRunType: String(row.latest_run_type) } : {}),
        ...(row.latest_run_status !== null ? { latestRunStatus: String(row.latest_run_status) } : {}),
        updatedAt: String(row.updated_at),
      };
    });

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
