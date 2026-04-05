import type { CodexAppServerClient } from "./codex-app-server.ts";
import type { PatchRelayDatabase } from "./db.ts";
import { extractStageSummary, summarizeCurrentThread } from "./run-reporting.ts";
import type { StageReport, RunRecord, TrackedIssueRecord } from "./types.ts";

interface RunStatusProvider {
  getActiveRunStatus(issueKey: string): Promise<{
    issue: TrackedIssueRecord;
    run: RunRecord;
    liveThread?: ReturnType<typeof summarizeCurrentThread>;
  } | undefined>;
}

export class IssueQueryService {
  constructor(
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
    const runCount = this.db.listRunsForIssue(result.issue.projectId, result.issue.linearIssueId).length;
    let liveThread;
    if (activeStatus?.liveThread) {
      liveThread = activeStatus.liveThread;
    } else if (activeRun?.threadId) {
      liveThread = await this.codex.readThread(activeRun.threadId, true).then(summarizeCurrentThread).catch(() => undefined);
    }

    return {
      ...result,
      issue: result.issue,
      ...(activeRun ? { activeRun } : {}),
      ...(latestRun ? { latestRun } : {}),
      ...(liveThread ? { liveThread } : {}),
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
              ...(result.issue.latestFailureSource ? { latestFailureSource: result.issue.latestFailureSource } : {}),
              ...(result.issue.latestFailureHeadSha ? { latestFailureHeadSha: result.issue.latestFailureHeadSha } : {}),
              ...(result.issue.latestFailureCheckName ? { latestFailureCheckName: result.issue.latestFailureCheckName } : {}),
              ...(result.issue.latestFailureStepName ? { latestFailureStepName: result.issue.latestFailureStepName } : {}),
              ...(result.issue.latestFailureSummary ? { latestFailureSummary: result.issue.latestFailureSummary } : {}),
              runCount,
            },
          }
        : {}),
    };
  }

  async getActiveRunStatus(issueKey: string) {
    return await this.runStatusProvider.getActiveRunStatus(issueKey);
  }

  async getPublicAgentSessionStatus(issueKey: string) {
    const overview = await this.getIssueOverview(issueKey);
    if (!overview) return undefined;

    const issueRecord = this.db.getIssueByKey(issueKey);
    const latestRunReport = overview.latestRun?.reportJson
      ? (JSON.parse(overview.latestRun.reportJson) as StageReport)
      : undefined;
    const runs = this.db.listRunsForIssue(overview.issue.projectId, overview.issue.linearIssueId).map((run) => ({
      run,
      ...(run.reportJson ? { report: JSON.parse(run.reportJson) as StageReport } : {}),
    }));
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
        ...(overview.issue.waitingReason ? { waitingReason: overview.issue.waitingReason } : {}),
      },
      ...(overview.activeRun ? { activeRun: overview.activeRun } : {}),
      ...(overview.latestRun ? { latestRun: overview.latestRun } : {}),
      ...(overview.liveThread ? { liveThread: overview.liveThread } : {}),
      ...(latestRunReport ? { latestReportSummary: extractStageSummary(latestRunReport) } : {}),
      runs,
      generatedAt: new Date().toISOString(),
    };
  }
}
