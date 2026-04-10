import type { PatchRelayDatabase } from "./db.ts";
import { extractStageSummary, summarizeCurrentThread } from "./run-reporting.ts";
import { parseStageReport } from "./issue-overview-query.ts";
import type { IssueOverviewQuery } from "./issue-overview-query.ts";

export class PublicAgentSessionStatusQuery {
  constructor(
    private readonly db: PatchRelayDatabase,
    private readonly overviewQuery: IssueOverviewQuery,
  ) {}

  async getStatus(issueKey: string) {
    const overview = await this.overviewQuery.getIssueOverview(issueKey);
    if (!overview) return undefined;

    const issueRecord = this.db.issues.getIssueByKey(issueKey);
    const latestRunReport = parseStageReport(overview.latestRun?.reportJson, overview.latestRun?.status ?? "unknown");
    const runs = (overview.runs ?? this.overviewQuery.buildRuns(overview.issue.projectId, overview.issue.linearIssueId)).map((run) => ({
      run: {
        id: run.id,
        runType: run.runType,
        status: run.status,
        startedAt: run.startedAt,
        ...(run.endedAt ? { endedAt: run.endedAt } : {}),
      },
      ...(run.report ? { report: run.report } : {}),
    }));
    return {
      issue: {
        issueKey: overview.issue.issueKey,
        title: overview.issue.title,
        issueUrl: overview.issue.issueUrl,
        currentLinearState: overview.issue.currentLinearState,
        ...(overview.session?.sessionState ? { sessionState: overview.session.sessionState } : {}),
        factoryState: overview.issue.factoryState,
        ...(overview.session?.prNumber !== undefined ? { prNumber: overview.session.prNumber } : {}),
        ...(issueRecord?.prUrl ? { prUrl: issueRecord.prUrl } : {}),
        ...(issueRecord?.prState ? { prState: issueRecord.prState } : {}),
        ...(issueRecord?.prReviewState ? { prReviewState: issueRecord.prReviewState } : {}),
        ...(issueRecord?.prCheckStatus ? { prCheckStatus: issueRecord.prCheckStatus } : {}),
        ...(issueRecord ? { ciRepairAttempts: issueRecord.ciRepairAttempts, queueRepairAttempts: issueRecord.queueRepairAttempts } : {}),
        ...(overview.issue.waitingReason ? { waitingReason: overview.issue.waitingReason } : {}),
        ...(overview.issue.statusNote ? { statusNote: overview.issue.statusNote } : {}),
        ...(overview.session?.lastWakeReason ? { lastWakeReason: overview.session.lastWakeReason } : {}),
      },
      ...(overview.activeRun ? { activeRun: overview.activeRun } : {}),
      ...(overview.latestRun ? { latestRun: overview.latestRun } : {}),
      ...(overview.liveThread ? { liveThread: summarizeCurrentThread(overview.liveThread) } : {}),
      ...(latestRunReport ? { latestReportSummary: extractStageSummary(latestRunReport) } : {}),
      runs,
      generatedAt: new Date().toISOString(),
    };
  }
}
