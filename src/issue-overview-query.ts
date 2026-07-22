import type { CodexAppServerClient } from "./codex-app-server.ts";
import type { CodexThreadSummary } from "./codex-types.ts";
import type { PatchRelayDatabase } from "./db.ts";
import type { IssueSessionRecord } from "./db-types.ts";
import { peekRunnableWorkflowTaskRunType } from "./pending-workflow-task.ts";
import { parseGitHubFailureContext } from "./github-failure-context.ts";
import type { StageReport, RunRecord, TrackedIssueRecord } from "./types.ts";
import { deriveIssueStatusNote } from "./status-note.ts";
import { derivePatchRelayWaitingReason } from "./waiting-reason.ts";
import { deriveIssueExecutionState, isIssueExecutionReadyForExecution } from "./issue-execution-state.ts";
import { deriveIssuePhase } from "./issue-phase.ts";

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
}

export interface IssueOverviewResult {
  issue: TrackedIssueRecord;
  session?: IssueSessionRecord | undefined;
  activeRun?: RunRecord | undefined;
  latestRun?: RunRecord | undefined;
  liveThread?: CodexThreadSummary | undefined;
  liveThreadError?: string | undefined;
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

export function parseStageReport(summaryJson: string | undefined, runStatus: string, runType = "unknown"): StageReport | undefined {
  if (!summaryJson) return undefined;
  try {
    const parsed = JSON.parse(summaryJson) as Record<string, unknown>;
    return {
      runType,
      status: runStatus,
      ...(typeof parsed.latestAssistantMessage === "string" ? { latestAssistantMessage: parsed.latestAssistantMessage } : {}),
      ...(typeof parsed.latestPlan === "string" ? { latestPlan: parsed.latestPlan } : {}),
      commandCount: typeof parsed.commandCount === "number" ? parsed.commandCount : 0,
      fileChangeCount: typeof parsed.fileChangeCount === "number" ? parsed.fileChangeCount : 0,
      toolCallCount: typeof parsed.toolCallCount === "number" ? parsed.toolCallCount : 0,
    };
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
      return await this.getIssueOverviewWithoutSession(issueKey);
    }
    return await this.getSessionIssueOverview(issueKey, session);
  }

  private async getIssueOverviewWithoutSession(issueKey: string): Promise<IssueOverviewResult | undefined> {
    const record = this.db.issues.getIssueByKey(issueKey);
    if (!record) return undefined;
    const issue = this.db.issueToTrackedIssue(record);
    const activeStatus = await this.runStatusProvider.getActiveRunStatus(issueKey);
    const activeRun = activeStatus?.run
      ?? (record.activeRunId !== undefined ? this.db.runs.getRunById(record.activeRunId) : undefined);
    const latestRun = this.db.runs.getLatestRunForIssue(record.projectId, record.linearIssueId);
    const runs = this.buildRuns(record.projectId, record.linearIssueId);
    const live = await this.readLiveThread(activeRun);
    return {
      issue,
      ...(activeRun ? { activeRun } : {}),
      ...(latestRun ? { latestRun } : {}),
      ...(live.thread ? { liveThread: live.thread } : {}),
      ...(live.error ? { liveThreadError: live.error } : {}),
      ...(runs.length > 0 ? { runs } : {}),
      issueContext: {
        ...(record.description ? { description: record.description } : {}),
        ...(record.currentLinearState ? { currentLinearState: record.currentLinearState } : {}),
        ...(record.url ? { issueUrl: record.url } : {}),
        ...(record.worktreePath ? { worktreePath: record.worktreePath } : {}),
        ...(record.branchName ? { branchName: record.branchName } : {}),
        ...(record.prUrl ? { prUrl: record.prUrl } : {}),
        ...(record.priority != null ? { priority: record.priority } : {}),
        ...(record.estimate != null ? { estimate: record.estimate } : {}),
        ciRepairAttempts: record.ciRepairAttempts,
        queueRepairAttempts: record.queueRepairAttempts,
        reviewFixAttempts: record.reviewFixAttempts,
        ...(issue.latestFailureSource ? { latestFailureSource: issue.latestFailureSource } : {}),
        ...(issue.latestFailureHeadSha ? { latestFailureHeadSha: issue.latestFailureHeadSha } : {}),
        ...(issue.latestFailureCheckName ? { latestFailureCheckName: issue.latestFailureCheckName } : {}),
        ...(issue.latestFailureStepName ? { latestFailureStepName: issue.latestFailureStepName } : {}),
        ...(issue.latestFailureSummary ? { latestFailureSummary: issue.latestFailureSummary } : {}),
        runCount: runs.length,
      },
    };
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
        const report = parseStageReport(run.summaryJson, run.status, run.runType);
        return report ? { report } : {};
      })(),
    }));
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
    const live = await this.readLiveThread(activeRun);
    const failureContext = parseGitHubFailureContext(issueRecord?.lastGitHubFailureContextJson);
    const runnableTaskRunType = peekRunnableWorkflowTaskRunType(this.db, session.projectId, session.linearIssueId);

    const derivedWaitingReason = derivePatchRelayWaitingReason({
      delegatedToPatchRelay: issueRecord?.delegatedToPatchRelay,
      currentLinearState: issueRecord?.currentLinearState,
      currentLinearStateType: issueRecord?.currentLinearStateType,
      ...(activeRun ? { activeRunType: activeRun.runType } : {}),
      blockedByKeys,
      workflowOutcome: issueRecord?.workflowOutcome,
      inputRequestKind: issueRecord?.inputRequestKind,
      ...(runnableTaskRunType ? { runnableTaskRunType: runnableTaskRunType } : {}),
      orchestrationSettleUntil: issueRecord?.orchestrationSettleUntil,
      prNumber: session.prNumber,
      prState: issueRecord?.prState,
      prHeadSha: issueRecord?.prHeadSha ?? session.prHeadSha,
      prReviewState: issueRecord?.prReviewState,
      prCheckStatus: issueRecord?.prCheckStatus,
      lastBlockingReviewHeadSha: issueRecord?.lastBlockingReviewHeadSha,
      latestFailureCheckName: issueRecord?.lastGitHubFailureCheckName,
      lastGitHubFailureSource: issueRecord?.lastGitHubFailureSource,
      deployStartedAt: issueRecord?.deployStartedAt,
    });
    const waitingReason = derivedWaitingReason ?? session.waitingReason;
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
      phase: issueRecord ? deriveIssuePhase({
        ...issueRecord,
        activeRunType: activeRun?.runType,
        runnableTaskRunType,
      }) : "delegated",
      ...(session.prNumber !== undefined ? { prNumber: session.prNumber } : {}),
      ...(issueRecord?.prState ? { prState: issueRecord.prState } : {}),
      ...(issueRecord?.prReviewState ? { prReviewState: issueRecord.prReviewState } : {}),
      ...(issueRecord?.prCheckStatus ? { prCheckStatus: issueRecord.prCheckStatus } : {}),
      blockedByCount: unresolvedBlockedBy.length,
      blockedByKeys,
      readyForExecution: isIssueExecutionReadyForExecution(deriveIssueExecutionState({
        workflowOutcome: issueRecord?.workflowOutcome,
        inputRequestKind: issueRecord?.inputRequestKind,
        currentLinearState: issueRecord?.currentLinearState,
        currentLinearStateType: issueRecord?.currentLinearStateType,
        delegatedToPatchRelay: issueRecord?.delegatedToPatchRelay,
        ...(activeRun ? { activeRunId: activeRun.id } : {}),
        ...(activeRun ? { activeRunType: activeRun.runType, activeRunStatus: activeRun.status } : {}),
        blockedByKeys,
        ...(runnableTaskRunType ? { runnableTaskRunType: runnableTaskRunType } : {}),
        orchestrationSettleUntil: issueRecord?.orchestrationSettleUntil,
        ...(session.prNumber !== undefined ? { prNumber: session.prNumber } : {}),
        ...(issueRecord?.prState ? { prState: issueRecord.prState } : {}),
        ...(issueRecord?.prHeadSha ? { prHeadSha: issueRecord.prHeadSha } : {}),
        ...(issueRecord?.prReviewState ? { prReviewState: issueRecord.prReviewState } : {}),
        ...(issueRecord?.prCheckStatus ? { prCheckStatus: issueRecord.prCheckStatus } : {}),
        ...(issueRecord?.lastBlockingReviewHeadSha ? { lastBlockingReviewHeadSha: issueRecord.lastBlockingReviewHeadSha } : {}),
        ...(issueRecord?.lastGitHubFailureCheckName ? { latestFailureCheckName: issueRecord.lastGitHubFailureCheckName } : {}),
        ...(issueRecord?.lastGitHubFailureSource ? { lastGitHubFailureSource: issueRecord.lastGitHubFailureSource } : {}),
        ...(issueRecord?.deployStartedAt ? { deployStartedAt: issueRecord.deployStartedAt } : {}),
      })),
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
      ...(live.thread ? { liveThread: live.thread } : {}),
      ...(live.error ? { liveThreadError: live.error } : {}),
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

  private async readLiveThread(run?: RunRecord | undefined): Promise<{ thread?: CodexThreadSummary; error?: string }> {
    if (!run?.threadId) return {};
    try {
      return { thread: await this.codex.readThread(run.threadId, true) };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }
}
