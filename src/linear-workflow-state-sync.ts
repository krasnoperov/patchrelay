import type { PatchRelayDatabase } from "./db.ts";
import type { IssueRecord, TrackedIssueRecord } from "./db-types.ts";
import type { RunType } from "./factory-state.ts";
import {
  resolvePreferredQueuedLinearState,
  resolvePreferredCompletedLinearState,
  resolvePreferredDeployingLinearState,
  resolvePreferredHumanNeededLinearState,
  resolvePreferredImplementingLinearState,
  resolvePreferredReviewLinearState,
  resolvePreferredReviewingLinearState,
} from "./linear-workflow.ts";
import { isCompletedLinearState } from "./pr-state.ts";
import { hasTrustedNoPrCompletion } from "./trusted-no-pr-completion.ts";
import type { LinearClientProvider } from "./types.ts";

export async function syncActiveWorkflowState(params: {
  db: PatchRelayDatabase;
  issue: IssueRecord;
  linear: NonNullable<Awaited<ReturnType<LinearClientProvider["forProject"]>>>;
  trackedIssue?: TrackedIssueRecord | undefined;
  options?: { activeRunType?: RunType } | undefined;
}): Promise<void> {
  const { db, issue, linear, trackedIssue, options } = params;
  const liveIssue = await linear.getIssue(issue.linearIssueId).catch(() => undefined);
  if (!liveIssue) return;

  const latestRun = db.runs.getLatestRunForIssue(issue.projectId, issue.linearIssueId);
  if (hasTrustedNoPrCompletion(issue, latestRun)) {
    await syncCompletedLinearState({ db, issue, linear, liveIssue });
    return;
  }

  if (!shouldAutoAdvanceLinearState(issue)) {
    return;
  }

  if (!shouldAutoAdvanceLinearState({
    currentLinearState: liveIssue.stateName,
    currentLinearStateType: liveIssue.stateType,
  })) {
    refreshCachedLinearState(db, issue, liveIssue.stateName, liveIssue.stateType);
    return;
  }

  const targetState = resolveDesiredActiveWorkflowState(issue, trackedIssue, options, liveIssue);
  if (!targetState) return;

  const normalizedCurrent = liveIssue.stateName?.trim().toLowerCase();
  if (normalizedCurrent === targetState.trim().toLowerCase()) {
    refreshCachedLinearState(db, issue, liveIssue.stateName, liveIssue.stateType);
    return;
  }

  const updated = await linear.setIssueState(issue.linearIssueId, targetState);
  refreshCachedLinearState(db, issue, updated.stateName, updated.stateType);
}

async function syncCompletedLinearState(params: {
  db: PatchRelayDatabase;
  issue: Pick<IssueRecord, "projectId" | "linearIssueId">;
  linear: NonNullable<Awaited<ReturnType<LinearClientProvider["forProject"]>>>;
  liveIssue: {
    stateName?: string;
    stateType?: string;
    workflowStates: Array<{ name: string; type?: string }>;
  };
}): Promise<void> {
  const { db, issue, linear, liveIssue } = params;
  if (isCompletedLinearState(liveIssue.stateType, liveIssue.stateName)) {
    refreshCachedLinearState(db, issue, liveIssue.stateName, liveIssue.stateType);
    return;
  }

  const targetState = resolvePreferredCompletedLinearState(liveIssue);
  if (!targetState) {
    refreshCachedLinearState(db, issue, liveIssue.stateName, liveIssue.stateType);
    return;
  }

  const normalizedCurrent = liveIssue.stateName?.trim().toLowerCase();
  if (normalizedCurrent === targetState.trim().toLowerCase()) {
    refreshCachedLinearState(db, issue, liveIssue.stateName, liveIssue.stateType);
    return;
  }

  const updated = await linear.setIssueState(issue.linearIssueId, targetState);
  refreshCachedLinearState(db, issue, updated.stateName, updated.stateType);
}

function refreshCachedLinearState(
  db: PatchRelayDatabase,
  issue: Pick<IssueRecord, "projectId" | "linearIssueId">,
  stateName: string | undefined,
  stateType: string | undefined,
): void {
  db.issues.upsertIssue({
    projectId: issue.projectId,
    linearIssueId: issue.linearIssueId,
    ...(stateName ? { currentLinearState: stateName } : {}),
    ...(stateType ? { currentLinearStateType: stateType } : {}),
  });
}

function shouldAutoAdvanceLinearState(issue: {
  currentLinearState?: string | undefined;
  currentLinearStateType?: string | undefined;
}): boolean {
  const normalizedType = issue.currentLinearStateType?.trim().toLowerCase();
  if (normalizedType === "completed" || normalizedType === "canceled" || normalizedType === "cancelled") {
    return false;
  }
  const normalizedName = issue.currentLinearState?.trim().toLowerCase();
  return normalizedName !== "done" && normalizedName !== "completed" && normalizedName !== "complete";
}

function resolveDesiredActiveWorkflowState(
  issue: Pick<IssueRecord, "factoryState" | "prNumber" | "prUrl" | "prReviewState" | "prCheckStatus" | "activeRunId" | "lastGitHubCiSnapshotJson" | "delegatedToPatchRelay">,
  trackedIssue: Pick<TrackedIssueRecord, "sessionState" | "blockedByCount" | "readyForExecution"> | undefined,
  options: { activeRunType?: RunType } | undefined,
  liveIssue: {
    workflowStates: Array<{ name: string; type?: string }>;
  },
): string | undefined {
  if (issue.factoryState === "awaiting_input" || issue.factoryState === "failed" || issue.factoryState === "escalated"
    || trackedIssue?.sessionState === "waiting_input" || trackedIssue?.sessionState === "failed") {
    return resolvePreferredHumanNeededLinearState(liveIssue);
  }

  const blocked = (trackedIssue?.blockedByCount ?? 0) > 0;
  const pausedNoPrWork = issue.prNumber === undefined && (!issue.delegatedToPatchRelay || blocked);
  if (pausedNoPrWork) {
    return resolvePreferredQueuedLinearState(liveIssue);
  }

  const activelyWorking = issue.delegatedToPatchRelay !== false && (
    issue.activeRunId !== undefined
    || options?.activeRunType !== undefined
    || trackedIssue?.sessionState === "running"
    || (issue.factoryState === "delegated" && !blocked && trackedIssue?.readyForExecution !== false)
    || issue.factoryState === "implementing"
    || issue.factoryState === "changes_requested"
    || issue.factoryState === "repairing_ci"
    || issue.factoryState === "repairing_queue"
  );
  if (activelyWorking) {
    return resolvePreferredImplementingLinearState(liveIssue);
  }

  if (issue.factoryState === "awaiting_queue"
    || issue.prReviewState === "approved"
    || isApprovedAndGreen(issue.prReviewState, issue.prCheckStatus)) {
    return resolvePreferredDeployingLinearState(liveIssue);
  }

  if (hasPendingReviewQuillVerdict(issue.lastGitHubCiSnapshotJson)) {
    return resolvePreferredReviewingLinearState(liveIssue);
  }

  const reviewBound = issue.prNumber !== undefined
    || Boolean(issue.prUrl)
    || issue.factoryState === "pr_open"
    || issue.prReviewState !== undefined
    || issue.prCheckStatus !== undefined;
  if (reviewBound) {
    return resolvePreferredReviewLinearState(liveIssue);
  }

  return undefined;
}

function isApprovedAndGreen(prReviewState: string | undefined, prCheckStatus: string | undefined): boolean {
  const normalizedReview = prReviewState?.trim().toLowerCase();
  const normalizedChecks = prCheckStatus?.trim().toLowerCase();
  return normalizedReview === "approved" && (normalizedChecks === "success" || normalizedChecks === "passed");
}

function hasPendingReviewQuillVerdict(snapshotJson: string | undefined): boolean {
  if (!snapshotJson) return false;
  try {
    const parsed = JSON.parse(snapshotJson) as { checks?: Array<{ name?: string; status?: string }> };
    return Array.isArray(parsed.checks) && parsed.checks.some((check) =>
      typeof check.name === "string"
      && check.name === "review-quill/verdict"
      && typeof check.status === "string"
      && check.status.toLowerCase() === "pending");
  } catch {
    return false;
  }
}
