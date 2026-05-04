import type { PatchRelayDatabase } from "./db.ts";
import type { IssueRecord, TrackedIssueRecord } from "./db-types.ts";
import type { RunType } from "./factory-state.ts";
import {
  resolvePreferredQueuedLinearState,
  resolvePreferredCompletedLinearState,
  resolvePreferredDeployingLinearState,
  resolvePreferredDeployLinearState,
  resolvePreferredHumanNeededLinearState,
  resolvePreferredImplementingLinearState,
  resolvePreferredReviewLinearState,
  resolvePreferredReviewingLinearState,
} from "./linear-workflow.ts";
import { resolveMergeQueueProtocol } from "./merge-queue-protocol.ts";
import { isCompletedLinearState } from "./pr-state.ts";
import { hasTrustedNoPrCompletion } from "./trusted-no-pr-completion.ts";
import type { LinearClientProvider } from "./types.ts";
import type { ProjectConfig } from "./workflow-types.ts";

export async function syncActiveWorkflowState(params: {
  db: PatchRelayDatabase;
  issue: IssueRecord;
  linear: NonNullable<Awaited<ReturnType<LinearClientProvider["forProject"]>>>;
  trackedIssue?: TrackedIssueRecord | undefined;
  options?: { activeRunType?: RunType } | undefined;
  project?: ProjectConfig | undefined;
}): Promise<void> {
  const { db, issue, linear, trackedIssue, options, project } = params;
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

  // Plan §4.6: keep the queued-for-deploy label in sync UNCONDITIONALLY,
  // before the state-equality early-return. When a project lacks an
  // In Deploy state the deploying-Linear-state collapses to the same
  // value as In Review — meaning when an awaiting_queue issue is sitting
  // in the In Review state, the early-return below skips the state
  // write but the label still needs to be added/removed to reflect
  // factoryState. Running first guarantees the label tracks reality
  // even when the state name doesn't change.
  await syncQueuedForDeployLabel({ issue, liveIssue, linear, project }).catch(() => undefined);

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

// Plan §4.6: when the issue's factoryState says it's In Deploy but the
// project's Linear workflow has no In Deploy-equivalent state, we want
// the dashboard to be able to distinguish "in review, awaiting verdict"
// from "in review, queued for landing". A configurable PR/Linear label
// (`queuedForDeployLabel`, default `queued-for-deploy`) carries that
// signal idempotently. The helper computes the desired present/absent
// state and only calls the API when there's a delta — safe to run on
// every sync invocation.
async function syncQueuedForDeployLabel(params: {
  issue: Pick<IssueRecord, "linearIssueId" | "factoryState">;
  liveIssue: {
    workflowStates: Array<{ name: string; type?: string | undefined }>;
    labels: Array<{ id: string; name: string }>;
  };
  linear: NonNullable<Awaited<ReturnType<LinearClientProvider["forProject"]>>>;
  project: ProjectConfig | undefined;
}): Promise<void> {
  const { issue, liveIssue, linear, project } = params;
  const labelName = resolveMergeQueueProtocol(project).queuedForDeployLabel;
  const want = isQueuedForDeployFallback(issue, liveIssue);
  const currentLabels = (liveIssue.labels ?? [])
    .map((label) => label.name.trim().toLowerCase())
    .filter(Boolean);
  const have = currentLabels.includes(labelName.trim().toLowerCase());
  if (want === have) return;
  if (want) {
    await linear.updateIssueLabels({ issueId: issue.linearIssueId, addNames: [labelName] });
  } else {
    await linear.updateIssueLabels({ issueId: issue.linearIssueId, removeNames: [labelName] });
  }
}

// True only when (a) the issue is In Deploy AND (b) the project's
// Linear workflow has no In Deploy-equivalent state — detected by the
// preferred-deploying state collapsing to the same name as the
// preferred-review state. When the project does have a real In Deploy
// state, `setIssueState` flows the issue there and the label is
// unnecessary.
function isQueuedForDeployFallback(
  issue: Pick<IssueRecord, "factoryState">,
  liveIssue: { workflowStates: Array<{ name: string; type?: string | undefined }> },
): boolean {
  if (issue.factoryState !== "awaiting_queue") return false;
  const deploying = resolvePreferredDeployingLinearState(liveIssue);
  const review = resolvePreferredReviewLinearState(liveIssue);
  const deployUnstarted = resolvePreferredDeployLinearState(liveIssue);
  if (!deploying || !review) return false;
  // No "deploying"/"deploy" state in the workflow → both resolve to
  // a review state. That's the fallback condition.
  return deploying.trim().toLowerCase() === review.trim().toLowerCase()
    && (deployUnstarted ?? "").trim().toLowerCase() === review.trim().toLowerCase();
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
