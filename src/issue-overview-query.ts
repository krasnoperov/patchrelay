import type { CodexAppServerClient } from "./codex-app-server.ts";
import type { CodexThreadSummary } from "./codex-types.ts";
import type { PatchRelayDatabase } from "./db.ts";
import type { IssueSessionRecord } from "./db-types.ts";
import { parseGitHubFailureContext } from "./github-failure-context.ts";
import { isIssueSessionReadyForExecution } from "./issue-session.ts";
import type { StageReport, RunRecord, TrackedIssueRecord } from "./types.ts";
import { deriveIssueStatusNote } from "./status-note.ts";
import { derivePatchRelayWaitingReason } from "./waiting-reason.ts";

export interface RunStatusProvider {
  getActiveRunStatus(issueKey: string): Promise<{
    issue: TrackedIssueRecord;
    run: RunRecord;
    liveThread?: unknown;
  } | undefined>;
}

export interface IssueOverviewRun {
  id: number;
  runType: string;
  status: string;
  startedAt: string;
  endedAt?: string | undefined;
  threadId?: string | undefined;
  report?: StageReport | undefined;
  events?: Array<{
    id: number;
    method: string;
    createdAt: string;
    parsedEvent?: Record<string, unknown> | undefined;
  }> | undefined;
}

export interface IssueOverviewResult {
  issue: TrackedIssueRecord;
  session?: IssueSessionRecord | undefined;
  activeRun?: RunRecord | undefined;
  latestRun?: RunRecord | undefined;
  liveThread?: CodexThreadSummary | undefined;
  runs?: IssueOverviewRun[] | undefined;
  issueContext?: {
    description?: string;
    currentLinearState?: string;
    issueUrl?: string;
    worktreePath?: string;
    branchName?: string;
    prUrl?: string;
    priority?: number;
    estimate?: number;
    ciRepairAttempts: number;
    queueRepairAttempts: number;
    reviewFixAttempts: number;
    latestFailureSource?: string;
    latestFailureHeadSha?: string;
    latestFailureCheckName?: string;
    latestFailureStepName?: string;
    latestFailureSummary?: string;
    runCount: number;
  } | undefined;
}

export function parseStageReport(reportJson: string | undefined, runStatus: string): StageReport | undefined {
  if (!reportJson) return undefined;
  try {
    const parsed = JSON.parse(reportJson) as StageReport;
    return { ...parsed, status: runStatus };
  } catch {
    return undefined;
  }
}

export class IssueOverviewQuery {
  constructor(
    private readonly db: PatchRelayDatabase,
    private readonly codex: CodexAppServerClient,
    private readonly runStatusProvider: RunStatusProvider,
  ) {}

  async getIssueOverview(issueKey: string): Promise<IssueOverviewResult | undefined> {
    const session = this.db.issueSessions.getIssueSessionByKey(issueKey);
    if (!session) {
      return await this.getLegacyIssueOverview(issueKey);
    }
    return await this.getSessionIssueOverview(issueKey, session);
  }

  buildRuns(projectId: string, linearIssueId: string): IssueOverviewRun[] {
    return this.db.runs.listRunsForIssue(projectId, linearIssueId).map((run) => ({
      id: run.id,
      runType: run.runType,
      status: run.status,
      startedAt: run.startedAt,
      ...(run.endedAt ? { endedAt: run.endedAt } : {}),
      ...(run.threadId ? { threadId: run.threadId } : {}),
      ...(() => {
        const report = parseStageReport(run.reportJson, run.status);
        return report ? { report } : {};
      })(),
      ...(() => {
        const events = this.db.runs.listThreadEvents(run.id).flatMap((event) => {
          try {
            const parsed = JSON.parse(event.eventJson) as unknown;
            return [{
              id: event.id,
              method: event.method,
              createdAt: event.createdAt,
              ...(parsed && typeof parsed === "object" && !Array.isArray(parsed)
                ? { parsedEvent: parsed as Record<string, unknown> }
                : {}),
            }];
          } catch {
            return [{
              id: event.id,
              method: event.method,
              createdAt: event.createdAt,
            }];
          }
        });
        return events.length > 0 ? { events } : {};
      })(),
    }));
  }

  private async getLegacyIssueOverview(issueKey: string): Promise<IssueOverviewResult | undefined> {
    const legacy = this.db.getIssueOverview(issueKey);
    if (!legacy) return undefined;

    const issueRecord = this.db.issues.getIssueByKey(issueKey);
    const activeStatus = await this.runStatusProvider.getActiveRunStatus(issueKey);
    const activeRun = activeStatus?.run ?? legacy.activeRun;
    const latestRun = this.db.runs.getLatestRunForIssue(legacy.issue.projectId, legacy.issue.linearIssueId);
    const latestEvent = this.db.issueSessions.listIssueSessionEvents(legacy.issue.projectId, legacy.issue.linearIssueId, { limit: 1 }).at(-1);
    const runs = this.buildRuns(legacy.issue.projectId, legacy.issue.linearIssueId);
    const runCount = runs.length;
    const liveThread = await this.readLiveThread(activeRun);
    const statusNote = issueRecord
      ? deriveIssueStatusNote({
          issue: issueRecord,
          latestRun,
          latestEvent,
          failureSummary: legacy.issue.latestFailureSummary,
          blockedByKeys: legacy.issue.blockedByKeys,
          waitingReason: legacy.issue.waitingReason,
        })
      : legacy.issue.statusNote;

    return {
      issue: {
        ...legacy.issue,
        ...(statusNote ? { statusNote } : {}),
      },
      ...(activeRun ? { activeRun } : {}),
      ...(latestRun ? { latestRun } : {}),
      ...(liveThread ? { liveThread } : {}),
      ...(runs.length > 0 ? { runs } : {}),
      ...(issueRecord
        ? {
            issueContext: {
              ...(issueRecord.description ? { description: issueRecord.description } : {}),
              ...(issueRecord.currentLinearState ? { currentLinearState: issueRecord.currentLinearState } : {}),
              ...(issueRecord.url ? { issueUrl: issueRecord.url } : {}),
              ...(issueRecord.worktreePath ? { worktreePath: issueRecord.worktreePath } : {}),
              ...(issueRecord.branchName ? { branchName: issueRecord.branchName } : {}),
              ...(issueRecord.prUrl ? { prUrl: issueRecord.prUrl } : {}),
              ...(issueRecord.priority != null ? { priority: issueRecord.priority } : {}),
              ...(issueRecord.estimate != null ? { estimate: issueRecord.estimate } : {}),
              ciRepairAttempts: issueRecord.ciRepairAttempts,
              queueRepairAttempts: issueRecord.queueRepairAttempts,
              reviewFixAttempts: issueRecord.reviewFixAttempts,
              ...(legacy.issue.latestFailureSource ? { latestFailureSource: legacy.issue.latestFailureSource } : {}),
              ...(legacy.issue.latestFailureHeadSha ? { latestFailureHeadSha: legacy.issue.latestFailureHeadSha } : {}),
              ...(legacy.issue.latestFailureCheckName ? { latestFailureCheckName: legacy.issue.latestFailureCheckName } : {}),
              ...(legacy.issue.latestFailureStepName ? { latestFailureStepName: legacy.issue.latestFailureStepName } : {}),
              ...(legacy.issue.latestFailureSummary ? { latestFailureSummary: legacy.issue.latestFailureSummary } : {}),
              runCount,
            },
          }
        : {}),
    };
  }

  private async getSessionIssueOverview(
    issueKey: string,
    session: IssueSessionRecord,
  ): Promise<IssueOverviewResult> {
    const issueRecord = this.db.issues.getIssueByKey(issueKey);
    const blockedBy = this.db.issues.listIssueDependencies(session.projectId, session.linearIssueId);
    const unresolvedBlockedBy = blockedBy.filter((entry) => (
      entry.blockerCurrentLinearStateType !== "completed"
      && entry.blockerCurrentLinearState?.trim().toLowerCase() !== "done"
    ));
    const blockedByKeys = unresolvedBlockedBy.map((entry) => entry.blockerIssueKey ?? entry.blockerLinearIssueId);
    const activeStatus = await this.runStatusProvider.getActiveRunStatus(issueKey);
    const activeRun = activeStatus?.run
      ?? (session.activeRunId !== undefined ? this.db.runs.getRunById(session.activeRunId) : undefined);
    const latestRun = this.db.runs.getLatestRunForIssue(session.projectId, session.linearIssueId);
    const latestEvent = this.db.issueSessions.listIssueSessionEvents(session.projectId, session.linearIssueId, { limit: 1 }).at(-1);
    const runs = this.buildRuns(session.projectId, session.linearIssueId);
    const runCount = runs.length;
    const liveThread = await this.readLiveThread(activeRun);
    const failureContext = parseGitHubFailureContext(issueRecord?.lastGitHubFailureContextJson);

    const waitingReason = session.waitingReason ?? derivePatchRelayWaitingReason({
      delegatedToPatchRelay: issueRecord?.delegatedToPatchRelay,
      ...(activeRun ? { activeRunType: activeRun.runType } : {}),
      blockedByKeys,
      factoryState: issueRecord?.factoryState ?? "delegated",
      pendingRunType: issueRecord?.pendingRunType,
      prNumber: session.prNumber,
      prState: issueRecord?.prState,
      prHeadSha: issueRecord?.prHeadSha ?? session.prHeadSha,
      prReviewState: issueRecord?.prReviewState,
      prCheckStatus: issueRecord?.prCheckStatus,
      lastBlockingReviewHeadSha: issueRecord?.lastBlockingReviewHeadSha,
      latestFailureCheckName: issueRecord?.lastGitHubFailureCheckName,
    });
    const issue: TrackedIssueRecord = {
      id: issueRecord?.id ?? session.id,
      projectId: session.projectId,
      linearIssueId: session.linearIssueId,
      delegatedToPatchRelay: issueRecord?.delegatedToPatchRelay ?? true,
      ...(session.issueKey ? { issueKey: session.issueKey } : {}),
      ...(issueRecord?.title ? { title: issueRecord.title } : {}),
      ...(issueRecord?.url ? { issueUrl: issueRecord.url } : {}),
      ...(issueRecord?.currentLinearState ? { currentLinearState: issueRecord.currentLinearState } : {}),
      sessionState: session.sessionState,
      factoryState: issueRecord?.factoryState ?? "delegated",
      blockedByCount: unresolvedBlockedBy.length,
      blockedByKeys,
      readyForExecution: isIssueSessionReadyForExecution({
        sessionState: session.sessionState,
        factoryState: issueRecord?.factoryState ?? "delegated",
        delegatedToPatchRelay: issueRecord?.delegatedToPatchRelay,
        ...(activeRun ? { activeRunId: activeRun.id } : {}),
        blockedByCount: unresolvedBlockedBy.length,
        hasPendingWake: this.db.issueSessions.peekIssueSessionWake(session.projectId, session.linearIssueId) !== undefined,
        hasLegacyPendingRun: issueRecord?.pendingRunType !== undefined,
        ...(session.prNumber !== undefined ? { prNumber: session.prNumber } : {}),
        ...(issueRecord?.prState ? { prState: issueRecord.prState } : {}),
        ...(issueRecord?.prReviewState ? { prReviewState: issueRecord.prReviewState } : {}),
        ...(issueRecord?.prCheckStatus ? { prCheckStatus: issueRecord.prCheckStatus } : {}),
        ...(issueRecord?.lastGitHubFailureSource ? { latestFailureSource: issueRecord.lastGitHubFailureSource } : {}),
      }),
      ...(issueRecord?.lastGitHubFailureSource ? { latestFailureSource: issueRecord.lastGitHubFailureSource } : {}),
      ...(issueRecord?.lastGitHubFailureHeadSha ? { latestFailureHeadSha: issueRecord.lastGitHubFailureHeadSha } : {}),
      ...(issueRecord?.lastGitHubFailureCheckName ? { latestFailureCheckName: issueRecord.lastGitHubFailureCheckName } : {}),
      ...(() => {
        const statusNote = issueRecord
          ? deriveIssueStatusNote({
              issue: issueRecord,
              sessionSummary: session.summaryText,
              latestRun,
              latestEvent,
              failureSummary: failureContext?.summary,
              blockedByKeys,
              waitingReason,
            })
          : undefined;
        return statusNote ? { statusNote } : {};
      })(),
      ...(waitingReason ? { waitingReason } : {}),
      ...(activeRun ? { activeRunId: activeRun.id } : {}),
      ...(issueRecord?.agentSessionId ? { activeAgentSessionId: issueRecord.agentSessionId } : {}),
      updatedAt: session.updatedAt,
    };

    return {
      issue,
      session,
      ...(activeRun ? { activeRun } : {}),
      ...(latestRun ? { latestRun } : {}),
      ...(liveThread ? { liveThread } : {}),
      ...(runs.length > 0 ? { runs } : {}),
      issueContext: {
        ...(issueRecord?.description ? { description: issueRecord.description } : {}),
        ...(issueRecord?.currentLinearState ? { currentLinearState: issueRecord.currentLinearState } : {}),
        ...(issueRecord?.url ? { issueUrl: issueRecord.url } : {}),
        ...(session.worktreePath ? { worktreePath: session.worktreePath } : {}),
        ...(session.branchName ? { branchName: session.branchName } : {}),
        ...(issueRecord?.prUrl ? { prUrl: issueRecord.prUrl } : {}),
        ...(issueRecord?.priority != null ? { priority: issueRecord.priority } : {}),
        ...(issueRecord?.estimate != null ? { estimate: issueRecord.estimate } : {}),
        ciRepairAttempts: issueRecord?.ciRepairAttempts ?? session.ciRepairAttempts,
        queueRepairAttempts: issueRecord?.queueRepairAttempts ?? session.queueRepairAttempts,
        reviewFixAttempts: issueRecord?.reviewFixAttempts ?? session.reviewFixAttempts,
        ...(issue.latestFailureSource ? { latestFailureSource: issue.latestFailureSource } : {}),
        ...(issue.latestFailureHeadSha ? { latestFailureHeadSha: issue.latestFailureHeadSha } : {}),
        ...(issue.latestFailureCheckName ? { latestFailureCheckName: issue.latestFailureCheckName } : {}),
        ...(issue.latestFailureStepName ? { latestFailureStepName: issue.latestFailureStepName } : {}),
        ...(issue.latestFailureSummary ? { latestFailureSummary: issue.latestFailureSummary } : {}),
        runCount,
      },
    };
  }

  private async readLiveThread(run?: RunRecord | undefined): Promise<CodexThreadSummary | undefined> {
    if (!run?.threadId) return undefined;
    return await this.codex.readThread(run.threadId, true).catch(() => undefined);
  }
}
