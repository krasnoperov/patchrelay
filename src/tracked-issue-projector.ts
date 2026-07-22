import type {
  IssueDependencyRecord,
  IssueRecord,
  IssueSessionEventRecord,
  IssueSessionRecord,
  RunRecord,
  TrackedIssueRecord,
} from "./db-types.ts";
import { parseGitHubFailureContext } from "./github-failure-context.ts";
import { deriveIssueExecutionStateFromRecords, isIssueExecutionReadyForExecution } from "./issue-execution-state.ts";
import { deriveIssueStatusNote } from "./status-note.ts";
import { derivePatchRelayWaitingReason } from "./waiting-reason.ts";
import { hasDetachedActiveLatestRun, resolveEffectiveActiveRun } from "./effective-active-run.ts";
import type { RunType } from "./run-type.ts";
import { deriveIssuePhase } from "./issue-phase.ts";

export function isResolvedLinearState(stateType: string | undefined, stateName: string | undefined): boolean {
  return stateType === "completed" || stateName?.trim().toLowerCase() === "done";
}

export function buildTrackedIssueRecord(params: {
  issue: IssueRecord;
  session?: IssueSessionRecord | undefined;
  blockedBy: IssueDependencyRecord[];
  runnableTaskRunType?: RunType | undefined;
  latestRun?: RunRecord | undefined;
  latestEvent?: IssueSessionEventRecord | undefined;
}): TrackedIssueRecord {
  const unresolvedBlockedBy = params.blockedBy.filter((entry) => !isResolvedLinearState(
    entry.blockerCurrentLinearStateType,
    entry.blockerCurrentLinearState,
  ));
  const failureContext = parseGitHubFailureContext(params.issue.lastGitHubFailureContextJson);
  const blockedByKeys = unresolvedBlockedBy.map((entry) => entry.blockerIssueKey ?? entry.blockerLinearIssueId);
  const effectiveActiveRun = resolveEffectiveActiveRun({
    activeRun: params.issue.activeRunId !== undefined && params.latestRun?.id === params.issue.activeRunId ? params.latestRun : undefined,
    latestRun: params.latestRun,
  });
  const detachedActiveRun = hasDetachedActiveLatestRun({
    activeRunId: params.issue.activeRunId,
    latestRun: params.latestRun,
  });
  const waitingReason = derivePatchRelayWaitingReason({
    delegatedToPatchRelay: params.issue.delegatedToPatchRelay,
    currentLinearState: params.issue.currentLinearState,
    currentLinearStateType: params.issue.currentLinearStateType,
    ...(effectiveActiveRun ? { activeRunId: effectiveActiveRun.id } : {}),
    blockedByKeys,
    workflowOutcome: params.issue.workflowOutcome,
    inputRequestKind: params.issue.inputRequestKind,
    ...(params.runnableTaskRunType ? { runnableTaskRunType: params.runnableTaskRunType } : {}),
    orchestrationSettleUntil: params.issue.orchestrationSettleUntil,
    prNumber: params.issue.prNumber,
    prState: params.issue.prState,
    prHeadSha: params.issue.prHeadSha,
    prReviewState: params.issue.prReviewState,
    prCheckStatus: params.issue.prCheckStatus,
    lastBlockingReviewHeadSha: params.issue.lastBlockingReviewHeadSha,
    latestFailureCheckName: params.issue.lastGitHubFailureCheckName,
    lastGitHubFailureSource: params.issue.lastGitHubFailureSource,
    deployStartedAt: params.issue.deployStartedAt,
  });
  const statusNote = deriveIssueStatusNote({
    issue: params.issue,
    sessionSummary: params.session?.summaryText,
    latestRun: params.latestRun,
    latestEvent: params.latestEvent,
    failureSummary: failureContext?.summary,
    blockedByKeys,
    waitingReason,
  });
  const completionCheckActive = Boolean(
    effectiveActiveRun?.status === "running"
      && effectiveActiveRun.completionCheckThreadId
      && !effectiveActiveRun.completionCheckOutcome,
  );

  return {
    id: params.issue.id,
    projectId: params.issue.projectId,
    linearIssueId: params.issue.linearIssueId,
    delegatedToPatchRelay: params.issue.delegatedToPatchRelay,
    ...(params.issue.issueClass ? { issueClass: params.issue.issueClass } : {}),
    ...(params.issue.issueKey ? { issueKey: params.issue.issueKey } : {}),
    ...(params.issue.title ? { title: params.issue.title } : {}),
    ...(params.issue.url ? { issueUrl: params.issue.url } : {}),
    ...(statusNote ? { statusNote } : {}),
    ...(params.issue.currentLinearState ? { currentLinearState: params.issue.currentLinearState } : {}),
    ...(params.session?.sessionState ? { sessionState: params.session.sessionState } : {}),
    phase: deriveIssuePhase({
      ...params.issue,
      activeRunType: effectiveActiveRun?.runType,
      runnableTaskRunType: params.runnableTaskRunType,
    }),
    ...(params.issue.prNumber !== undefined ? { prNumber: params.issue.prNumber } : {}),
    ...(params.issue.prState ? { prState: params.issue.prState } : {}),
    ...(params.issue.prReviewState ? { prReviewState: params.issue.prReviewState } : {}),
    ...(params.issue.prCheckStatus ? { prCheckStatus: params.issue.prCheckStatus } : {}),
    blockedByCount: unresolvedBlockedBy.length,
    blockedByKeys,
    readyForExecution: isIssueExecutionReadyForExecution(deriveIssueExecutionStateFromRecords(params.issue, {
      ...(effectiveActiveRun ? { activeRun: effectiveActiveRun } : {}),
      ...(params.latestRun ? { latestRun: params.latestRun } : {}),
      blockedByKeys,
      ...(params.runnableTaskRunType ? { runnableTaskRunType: params.runnableTaskRunType } : {}),
    })),
    ...(params.issue.lastGitHubFailureSource ? { latestFailureSource: params.issue.lastGitHubFailureSource } : {}),
    ...(params.issue.lastGitHubFailureHeadSha ? { latestFailureHeadSha: params.issue.lastGitHubFailureHeadSha } : {}),
    ...(params.issue.lastGitHubFailureCheckName ? { latestFailureCheckName: params.issue.lastGitHubFailureCheckName } : {}),
    ...(failureContext?.stepName ? { latestFailureStepName: failureContext.stepName } : {}),
    ...(failureContext?.summary ? { latestFailureSummary: failureContext.summary } : {}),
    ...(waitingReason ? { waitingReason } : {}),
    ...(completionCheckActive ? { completionCheckActive } : {}),
    ...(effectiveActiveRun ? { activeRunId: effectiveActiveRun.id } : {}),
    ...(params.issue.agentSessionId ? { activeAgentSessionId: params.issue.agentSessionId } : {}),
    ...(detachedActiveRun && params.session?.sessionState ? { sessionState: "running" } : {}),
    updatedAt: params.issue.updatedAt,
  };
}
