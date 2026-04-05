import type { CodexAppServerClient } from "./codex-app-server.ts";
import type { PatchRelayDatabase } from "./db.ts";
import type { IssueSessionRecord } from "./db-types.ts";
import { extractStageSummary, summarizeCurrentThread } from "./run-reporting.ts";
import type { StageReport, RunRecord, TrackedIssueRecord } from "./types.ts";
import { derivePatchRelayWaitingReason } from "./waiting-reason.ts";

interface RunStatusProvider {
  getActiveRunStatus(issueKey: string): Promise<{
    issue: TrackedIssueRecord;
    run: RunRecord;
    liveThread?: ReturnType<typeof summarizeCurrentThread>;
  } | undefined>;
}

interface IssueOverviewResult {
  issue: TrackedIssueRecord;
  session?: IssueSessionRecord | undefined;
  activeRun?: RunRecord | undefined;
  latestRun?: RunRecord | undefined;
  liveThread?: ReturnType<typeof summarizeCurrentThread> | undefined;
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

export class IssueQueryService {
  constructor(
    private readonly db: PatchRelayDatabase,
    private readonly codex: CodexAppServerClient,
    private readonly runStatusProvider: RunStatusProvider,
  ) {}

  async getIssueOverview(issueKey: string): Promise<IssueOverviewResult | undefined> {
    const session = this.db.getIssueSessionByKey(issueKey);
    if (!session) {
      const legacy = this.db.getIssueOverview(issueKey);
      if (!legacy) return undefined;

      const issueRecord = this.db.getIssueByKey(issueKey);
      const activeStatus = await this.runStatusProvider.getActiveRunStatus(issueKey);
      const activeRun = activeStatus?.run ?? legacy.activeRun;
      const latestRun = this.db.getLatestRunForIssue(legacy.issue.projectId, legacy.issue.linearIssueId);
      const runCount = this.db.listRunsForIssue(legacy.issue.projectId, legacy.issue.linearIssueId).length;
      let liveThread;
      if (activeStatus?.liveThread) {
        liveThread = activeStatus.liveThread;
      } else if (activeRun?.threadId) {
        liveThread = await this.codex.readThread(activeRun.threadId, true).then(summarizeCurrentThread).catch(() => undefined);
      }

      return {
        issue: legacy.issue,
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

    const issueRecord = this.db.getIssueByKey(issueKey);
    const blockedBy = this.db.listIssueDependencies(session.projectId, session.linearIssueId);
    const unresolvedBlockedBy = blockedBy.filter((entry) => (
      entry.blockerCurrentLinearStateType !== "completed"
      && entry.blockerCurrentLinearState?.trim().toLowerCase() !== "done"
    ));
    const blockedByKeys = unresolvedBlockedBy.map((entry) => entry.blockerIssueKey ?? entry.blockerLinearIssueId);
    const activeStatus = await this.runStatusProvider.getActiveRunStatus(issueKey);
    const activeRun = activeStatus?.run
      ?? (session.activeRunId !== undefined ? this.db.getRun(session.activeRunId) : undefined);
    const latestRun = this.db.getLatestRunForIssue(session.projectId, session.linearIssueId);
    const runCount = this.db.listRunsForIssue(session.projectId, session.linearIssueId).length;
    let liveThread;
    if (activeStatus?.liveThread) {
      liveThread = activeStatus.liveThread;
    } else if (activeRun?.threadId) {
      liveThread = await this.codex.readThread(activeRun.threadId, true).then(summarizeCurrentThread).catch(() => undefined);
    }

    const waitingReason = session.waitingReason ?? derivePatchRelayWaitingReason({
      ...(activeRun ? { activeRunType: activeRun.runType } : {}),
      blockedByKeys,
      factoryState: issueRecord?.factoryState ?? "delegated",
      pendingRunType: issueRecord?.pendingRunType,
      prNumber: session.prNumber,
      prReviewState: issueRecord?.prReviewState,
      prCheckStatus: issueRecord?.prCheckStatus,
      latestFailureCheckName: issueRecord?.lastGitHubFailureCheckName,
    });
    const issue: TrackedIssueRecord = {
      id: issueRecord?.id ?? session.id,
      projectId: session.projectId,
      linearIssueId: session.linearIssueId,
      ...(session.issueKey ? { issueKey: session.issueKey } : {}),
      ...(issueRecord?.title ? { title: issueRecord.title } : {}),
      ...(issueRecord?.url ? { issueUrl: issueRecord.url } : {}),
      ...(issueRecord?.currentLinearState ? { currentLinearState: issueRecord.currentLinearState } : {}),
      sessionState: session.sessionState,
      factoryState: issueRecord?.factoryState ?? "delegated",
      blockedByCount: unresolvedBlockedBy.length,
      blockedByKeys,
      readyForExecution: (
        (issueRecord?.pendingRunType !== undefined || this.db.hasPendingIssueSessionEvents(session.projectId, session.linearIssueId))
        && activeRun === undefined
        && unresolvedBlockedBy.length === 0
      ),
      ...(issueRecord?.lastGitHubFailureSource ? { latestFailureSource: issueRecord.lastGitHubFailureSource } : {}),
      ...(issueRecord?.lastGitHubFailureHeadSha ? { latestFailureHeadSha: issueRecord.lastGitHubFailureHeadSha } : {}),
      ...(issueRecord?.lastGitHubFailureCheckName ? { latestFailureCheckName: issueRecord.lastGitHubFailureCheckName } : {}),
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
        ...(overview.session?.sessionState ? { sessionState: overview.session.sessionState } : {}),
        factoryState: overview.issue.factoryState,
        ...(overview.session?.prNumber !== undefined ? { prNumber: overview.session.prNumber } : {}),
        ...(issueRecord?.prUrl ? { prUrl: issueRecord.prUrl } : {}),
        ...(issueRecord?.prState ? { prState: issueRecord.prState } : {}),
        ...(issueRecord?.prReviewState ? { prReviewState: issueRecord.prReviewState } : {}),
        ...(issueRecord?.prCheckStatus ? { prCheckStatus: issueRecord.prCheckStatus } : {}),
        ...(issueRecord ? { ciRepairAttempts: issueRecord.ciRepairAttempts, queueRepairAttempts: issueRecord.queueRepairAttempts } : {}),
        ...(overview.issue.waitingReason ? { waitingReason: overview.issue.waitingReason } : {}),
        ...(overview.session?.lastWakeReason ? { lastWakeReason: overview.session.lastWakeReason } : {}),
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
