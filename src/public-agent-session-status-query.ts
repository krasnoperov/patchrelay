import type { PatchRelayDatabase } from "./db.ts";
import { extractStageSummary, summarizeCurrentThread } from "./run-reporting.ts";
import { parseStageReport } from "./issue-overview-query.ts";
import type { IssueOverviewQuery } from "./issue-overview-query.ts";
import { isIssueDownstreamOrDoneProjection } from "./issue-execution-state.ts";

export class PublicAgentSessionStatusQuery {
  constructor(
    private readonly db: PatchRelayDatabase,
    private readonly overviewQuery: IssueOverviewQuery,
  ) {}

  async getStatus(issueKey: string) {
    const overview = await this.overviewQuery.getIssueOverview(issueKey);
    if (!overview) return undefined;

    const issueRecord = this.db.issues.getIssueByKey(issueKey);
    const latestRunReport = parseStageReport(
      overview.latestRun?.summaryJson,
      overview.latestRun?.status ?? "unknown",
      overview.latestRun?.runType,
    );
    const latestRunNoLongerCurrent =
      isIssueDownstreamOrDoneProjection(overview.issue)
      && (overview.latestRun?.status === "failed" || overview.latestRun?.status === "superseded");
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
        phase: overview.issue.phase,
        ...(overview.session?.prNumber !== undefined ? { prNumber: overview.session.prNumber } : {}),
        ...(issueRecord?.prUrl ? { prUrl: issueRecord.prUrl } : {}),
        ...(issueRecord?.prState ? { prState: issueRecord.prState } : {}),
        ...(issueRecord?.prReviewState ? { prReviewState: issueRecord.prReviewState } : {}),
        ...(issueRecord?.prCheckStatus ? { prCheckStatus: issueRecord.prCheckStatus } : {}),
        ...(issueRecord ? { ciRepairAttempts: issueRecord.ciRepairAttempts, queueRepairAttempts: issueRecord.queueRepairAttempts } : {}),
        ...(overview.issue.waitingReason ? { waitingReason: overview.issue.waitingReason } : {}),
        ...(overview.issue.statusNote ? { statusNote: overview.issue.statusNote } : {}),
        ...(overview.session?.lastWorkflowReason ? { lastWorkflowReason: overview.session.lastWorkflowReason } : {}),
      },
      ...(overview.activeRun ? { activeRun: overview.activeRun } : {}),
      ...(overview.latestRun && !latestRunNoLongerCurrent ? { latestRun: overview.latestRun } : {}),
      ...(overview.liveThread ? { liveThread: summarizeCurrentThread(overview.liveThread) } : {}),
      ...(overview.liveThreadError ? { codexError: overview.liveThreadError } : {}),
      ...(() => {
        const observedRun = overview.activeRun ?? overview.latestRun;
        if (!observedRun?.lastCodexActivityAt) return {};
        return {
          activity: {
            at: observedRun.lastCodexActivityAt,
            ...(observedRun.lastCodexActivityKind ? { kind: observedRun.lastCodexActivityKind } : {}),
            ...(observedRun.lastCodexActivitySummary ? { summary: observedRun.lastCodexActivitySummary } : {}),
          },
        };
      })(),
      ...(latestRunReport && !latestRunNoLongerCurrent ? { latestReportSummary: extractStageSummary(latestRunReport) } : {}),
      runs,
      generatedAt: new Date().toISOString(),
    };
  }
}
