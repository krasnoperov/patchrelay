import type {
  IssueDependencyRecord,
  IssueRecord,
  IssueSessionEventRecord,
  IssueSessionRecord,
  RunRecord,
  TrackedIssueRecord,
} from "./db-types.ts";
import { parseGitHubFailureContext } from "./github-failure-context.ts";
import { isIssueSessionReadyForExecution } from "./issue-session.ts";
import { deriveIssueStatusNote } from "./status-note.ts";
import { derivePatchRelayWaitingReason } from "./waiting-reason.ts";

export function isResolvedLinearState(stateType: string | undefined, stateName: string | undefined): boolean {
  return stateType === "completed" || stateName?.trim().toLowerCase() === "done";
}

export function buildTrackedIssueRecord(params: {
  issue: IssueRecord;
  session?: IssueSessionRecord | undefined;
  blockedBy: IssueDependencyRecord[];
  hasPendingWake: boolean;
  latestRun?: RunRecord | undefined;
  latestEvent?: IssueSessionEventRecord | undefined;
}): TrackedIssueRecord {
  const unresolvedBlockedBy = params.blockedBy.filter((entry) => !isResolvedLinearState(
    entry.blockerCurrentLinearStateType,
    entry.blockerCurrentLinearState,
  ));
  const failureContext = parseGitHubFailureContext(params.issue.lastGitHubFailureContextJson);
  const blockedByKeys = unresolvedBlockedBy.map((entry) => entry.blockerIssueKey ?? entry.blockerLinearIssueId);
  const waitingReason = derivePatchRelayWaitingReason({
    ...(params.issue.activeRunId !== undefined ? { activeRunId: params.issue.activeRunId } : {}),
    blockedByKeys,
    factoryState: params.issue.factoryState,
    pendingRunType: params.issue.pendingRunType,
    prNumber: params.issue.prNumber,
    prState: params.issue.prState,
    prHeadSha: params.issue.prHeadSha,
    prReviewState: params.issue.prReviewState,
    prCheckStatus: params.issue.prCheckStatus,
    lastBlockingReviewHeadSha: params.issue.lastBlockingReviewHeadSha,
    latestFailureCheckName: params.issue.lastGitHubFailureCheckName,
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
    params.issue.activeRunId !== undefined
      && params.latestRun?.id === params.issue.activeRunId
      && params.latestRun.status === "running"
      && params.latestRun.completionCheckThreadId
      && !params.latestRun.completionCheckOutcome,
  );

  return {
    id: params.issue.id,
    projectId: params.issue.projectId,
    linearIssueId: params.issue.linearIssueId,
    ...(params.issue.issueKey ? { issueKey: params.issue.issueKey } : {}),
    ...(params.issue.title ? { title: params.issue.title } : {}),
    ...(params.issue.url ? { issueUrl: params.issue.url } : {}),
    ...(statusNote ? { statusNote } : {}),
    ...(params.issue.currentLinearState ? { currentLinearState: params.issue.currentLinearState } : {}),
    ...(params.session?.sessionState ? { sessionState: params.session.sessionState } : {}),
    factoryState: params.issue.factoryState,
    ...(params.issue.prNumber !== undefined ? { prNumber: params.issue.prNumber } : {}),
    ...(params.issue.prState ? { prState: params.issue.prState } : {}),
    ...(params.issue.prReviewState ? { prReviewState: params.issue.prReviewState } : {}),
    ...(params.issue.prCheckStatus ? { prCheckStatus: params.issue.prCheckStatus } : {}),
    blockedByCount: unresolvedBlockedBy.length,
    blockedByKeys,
    readyForExecution: isIssueSessionReadyForExecution({
      sessionState: params.session?.sessionState,
      factoryState: params.issue.factoryState,
      activeRunId: params.issue.activeRunId,
      blockedByCount: unresolvedBlockedBy.length,
      hasPendingWake: params.hasPendingWake,
      hasLegacyPendingRun: params.issue.pendingRunType !== undefined,
      ...(params.issue.prNumber !== undefined ? { prNumber: params.issue.prNumber } : {}),
      ...(params.issue.prState ? { prState: params.issue.prState } : {}),
      ...(params.issue.prReviewState ? { prReviewState: params.issue.prReviewState } : {}),
      ...(params.issue.prCheckStatus ? { prCheckStatus: params.issue.prCheckStatus } : {}),
      ...(params.issue.lastGitHubFailureSource ? { latestFailureSource: params.issue.lastGitHubFailureSource } : {}),
    }),
    ...(params.issue.lastGitHubFailureSource ? { latestFailureSource: params.issue.lastGitHubFailureSource } : {}),
    ...(params.issue.lastGitHubFailureHeadSha ? { latestFailureHeadSha: params.issue.lastGitHubFailureHeadSha } : {}),
    ...(params.issue.lastGitHubFailureCheckName ? { latestFailureCheckName: params.issue.lastGitHubFailureCheckName } : {}),
    ...(failureContext?.stepName ? { latestFailureStepName: failureContext.stepName } : {}),
    ...(failureContext?.summary ? { latestFailureSummary: failureContext.summary } : {}),
    ...(waitingReason ? { waitingReason } : {}),
    ...(completionCheckActive ? { completionCheckActive } : {}),
    ...(params.issue.activeRunId !== undefined ? { activeRunId: params.issue.activeRunId } : {}),
    ...(params.issue.agentSessionId ? { activeAgentSessionId: params.issue.agentSessionId } : {}),
    updatedAt: params.issue.updatedAt,
  };
}
