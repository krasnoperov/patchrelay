import type { CodexAppServerClient } from "./codex-app-server.ts";
import type { PatchRelayDatabase } from "./db.ts";
import { parseStoredQueueRepairContext } from "./merge-queue-incident.ts";
import { resolveMergeQueueProtocol } from "./merge-queue-protocol.ts";
import { extractStageSummary, summarizeCurrentThread } from "./run-reporting.ts";
import type { AppConfig, StageReport, RunRecord, TrackedIssueRecord } from "./types.ts";
import { safeJsonParse } from "./utils.ts";

interface RunStatusProvider {
  getActiveRunStatus(issueKey: string): Promise<{
    issue: TrackedIssueRecord;
    run: RunRecord;
    liveThread?: ReturnType<typeof summarizeCurrentThread>;
  } | undefined>;
}

export class IssueQueryService {
  constructor(
    private readonly config: AppConfig,
    private readonly db: PatchRelayDatabase,
    private readonly codex: CodexAppServerClient,
    private readonly runStatusProvider: RunStatusProvider,
  ) {}

  async getIssueOverview(issueKey: string) {
    const result = this.db.getIssueOverview(issueKey);
    if (!result) return undefined;

    const issueRecord = this.db.getIssueByKey(issueKey);
    const activeStatus = await this.runStatusProvider.getActiveRunStatus(issueKey);
    const activeRun = activeStatus?.run ?? result.activeRun;
    const latestRun = this.db.getLatestRunForIssue(result.issue.projectId, result.issue.linearIssueId);
    let liveThread;
    if (activeStatus?.liveThread) {
      liveThread = activeStatus.liveThread;
    } else if (activeRun?.threadId) {
      liveThread = await this.codex.readThread(activeRun.threadId, true).then(summarizeCurrentThread).catch(() => undefined);
    }

    return {
      ...result,
      issue: issueRecord ? { ...result.issue, queueProtocol: this.buildQueueProtocol(issueRecord.projectId, issueRecord) } : result.issue,
      ...(activeRun ? { activeRun } : {}),
      ...(latestRun ? { latestRun } : {}),
      ...(liveThread ? { liveThread } : {}),
    };
  }

  async getIssueReport(issueKey: string) {
    const issue = this.db.getTrackedIssueByKey(issueKey);
    if (!issue) return undefined;

    return {
      issue,
      runs: this.db.listRunsForIssue(issue.projectId, issue.linearIssueId).map((run) => ({
        run,
        ...(run.reportJson ? { report: JSON.parse(run.reportJson) as StageReport } : {}),
      })),
    };
  }

  async getRunEvents(issueKey: string, runId: number) {
    const issue = this.db.getTrackedIssueByKey(issueKey);
    if (!issue) return undefined;

    const run = this.db.getRun(runId);
    if (!run || run.projectId !== issue.projectId || run.linearIssueId !== issue.linearIssueId) return undefined;

    return {
      issue,
      run,
      events: this.db.listThreadEvents(runId).map((event) => ({
        ...event,
        parsedEvent: safeJsonParse<Record<string, unknown>>(event.eventJson),
      })),
    };
  }

  async getIssueTimeline(issueKey: string) {
    const issue = this.db.getTrackedIssueByKey(issueKey);
    if (!issue) return undefined;

    const fullIssue = this.db.getIssueByKey(issueKey);
    const runs = this.db.listRunsForIssue(issue.projectId, issue.linearIssueId).map((run) => ({
      id: run.id,
      runType: run.runType,
      status: run.status,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      threadId: run.threadId,
      events: this.db.listThreadEvents(run.id).map((event) => ({
        id: event.id,
        method: event.method,
        createdAt: event.createdAt,
        parsedEvent: safeJsonParse<Record<string, unknown>>(event.eventJson),
      })),
      ...(run.reportJson ? { report: JSON.parse(run.reportJson) as StageReport } : {}),
    }));

    const feedEvents = this.db.operatorFeed.list({ issueKey, limit: 500 });

    let liveThread = undefined;
    const activeRunId = fullIssue?.activeRunId;
    const activeRun = activeRunId !== undefined ? runs.find((r) => r.id === activeRunId) : undefined;
    if (activeRun?.threadId) {
      liveThread = await this.codex.readThread(activeRun.threadId, true).catch(() => undefined);
    }

    return {
      issue: {
        ...issue,
        ...(fullIssue?.description ? { description: fullIssue.description } : {}),
        ...(fullIssue?.branchName ? { branchName: fullIssue.branchName } : {}),
        ...(fullIssue?.worktreePath ? { worktreePath: fullIssue.worktreePath } : {}),
        ...(fullIssue?.prUrl ? { prUrl: fullIssue.prUrl } : {}),
        ...(fullIssue?.priority != null ? { priority: fullIssue.priority } : {}),
        ...(fullIssue?.estimate != null ? { estimate: fullIssue.estimate } : {}),
        ciRepairAttempts: fullIssue?.ciRepairAttempts ?? 0,
        queueRepairAttempts: fullIssue?.queueRepairAttempts ?? 0,
        reviewFixAttempts: fullIssue?.reviewFixAttempts ?? 0,
        ...(fullIssue ? { queueProtocol: this.buildQueueProtocol(fullIssue.projectId, fullIssue) } : {}),
      },
      runs,
      feedEvents,
      liveThread,
      activeRunId,
    };
  }

  async getActiveRunStatus(issueKey: string) {
    return await this.runStatusProvider.getActiveRunStatus(issueKey);
  }

  async getPublicAgentSessionStatus(issueKey: string) {
    const overview = await this.getIssueOverview(issueKey);
    if (!overview) return undefined;

    const issueRecord = this.db.getIssueByKey(issueKey);
    const report = await this.getIssueReport(issueKey);
    const latestRunReport = report?.runs.at(-1)?.report;
    return {
      issue: {
        issueKey: overview.issue.issueKey,
        title: overview.issue.title,
        issueUrl: overview.issue.issueUrl,
        currentLinearState: overview.issue.currentLinearState,
        factoryState: overview.issue.factoryState,
        ...(issueRecord?.prNumber !== undefined ? { prNumber: issueRecord.prNumber } : {}),
        ...(issueRecord?.prUrl ? { prUrl: issueRecord.prUrl } : {}),
        ...(issueRecord?.prState ? { prState: issueRecord.prState } : {}),
        ...(issueRecord?.prReviewState ? { prReviewState: issueRecord.prReviewState } : {}),
        ...(issueRecord?.prCheckStatus ? { prCheckStatus: issueRecord.prCheckStatus } : {}),
        ...(issueRecord ? { ciRepairAttempts: issueRecord.ciRepairAttempts, queueRepairAttempts: issueRecord.queueRepairAttempts } : {}),
        ...(issueRecord ? { queueProtocol: this.buildQueueProtocol(issueRecord.projectId, issueRecord) } : {}),
      },
      ...(overview.activeRun ? { activeRun: overview.activeRun } : {}),
      ...(overview.latestRun ? { latestRun: overview.latestRun } : {}),
      ...(overview.liveThread ? { liveThread: overview.liveThread } : {}),
      ...(latestRunReport ? { latestReportSummary: extractStageSummary(latestRunReport) } : {}),
      feedEvents: this.db.operatorFeed.list({ issueKey, limit: 500 }),
      activeRunId: issueRecord?.activeRunId ?? null,
      runs: report?.runs ?? [],
      generatedAt: new Date().toISOString(),
    };
  }

  private buildQueueProtocol(
    projectId: string,
    issue: {
      prNumber?: number | undefined;
      lastGitHubFailureSource?: string | undefined;
      lastGitHubFailureCheckName?: string | undefined;
      lastGitHubFailureCheckUrl?: string | undefined;
      lastGitHubFailureAt?: string | undefined;
      lastQueueSignalAt?: string | undefined;
      lastQueueIncidentJson?: string | undefined;
    },
  ) {
    const project = this.config.projects.find((entry) => entry.id === projectId);
    const protocol = resolveMergeQueueProtocol(project);
    const queueIncident = issue.lastQueueIncidentJson
      ? parseStoredQueueRepairContext(issue.lastQueueIncidentJson)
      : undefined;
    return {
      repoFullName: protocol.repoFullName,
      baseBranch: protocol.baseBranch,
      admissionLabel: protocol.admissionLabel,
      evictionCheckName: protocol.evictionCheckName,
      prNumber: issue.prNumber ?? null,
      lastFailureSource: issue.lastGitHubFailureSource ?? null,
      lastFailureCheckName: issue.lastGitHubFailureCheckName ?? null,
      lastFailureCheckUrl: issue.lastGitHubFailureCheckUrl ?? null,
      lastFailureAt: issue.lastGitHubFailureAt ?? null,
      lastQueueSignalAt: issue.lastQueueSignalAt ?? null,
      lastIncidentId: queueIncident?.incidentId ?? null,
      lastIncidentUrl: queueIncident?.incidentUrl ?? null,
      lastIncidentFailureClass: queueIncident?.incidentContext?.failureClass ?? null,
      lastIncidentSummary: queueIncident?.incidentSummary ?? null,
    };
  }
}
