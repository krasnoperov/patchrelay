import type { PatchRelayDatabase } from "./db.ts";
import type { IssueRecord, TrackedIssueRecord } from "./db-types.ts";
import type { RunType } from "./run-type.ts";
import { deriveIssueExecutionStateFromRecords, type IssueExecutionState } from "./issue-execution-state.ts";
import {
  resolvePreferredQueuedLinearState,
  resolvePreferredCompletedLinearState,
  resolvePreferredDeployingLinearState,
  resolvePreferredHumanNeededLinearState,
  resolvePreferredImplementingLinearState,
  resolvePreferredMergeQueueLinearState,
  resolvePreferredReviewingLinearState,
} from "./linear-workflow.ts";
import { resolveMergeQueueProtocol } from "./merge-queue-protocol.ts";
import { peekRunnableWorkflowTaskRunType } from "./pending-workflow-task.ts";
import { isCompletedLinearState } from "./pr-state.ts";
import { hasTrustedNoPrCompletion } from "./trusted-no-pr-completion.ts";
import type { LinearClientProvider } from "./types.ts";
import type { ProjectConfig } from "./workflow-types.ts";

const WRITER = "linear-workflow-state-sync";

export async function syncActiveWorkflowState(params: {
  db: PatchRelayDatabase;
  issue: IssueRecord;
  linear: NonNullable<Awaited<ReturnType<LinearClientProvider["forProject"]>>>;
  trackedIssue?: TrackedIssueRecord | undefined;
  options?: { activeRunType?: RunType } | undefined;
  project?: ProjectConfig | undefined;
}): Promise<void> {
  const { db, issue, linear, options, project } = params;
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

  const executionState = deriveLinearExecutionState(db, issue);

  // Plan §4.6: keep the queued-for-deploy label in sync UNCONDITIONALLY,
  // before the state-equality early-return. When a project lacks an
  // In Deploy state the deploying-Linear-state collapses to the same
  // value as In Review — meaning when an awaiting_queue issue is sitting
  // in the In Review state, the early-return below skips the state
  // write but the label still needs to be added/removed to reflect
  // the rendered execution state. Running first guarantees the label tracks reality
  // even when the state name doesn't change.
  await syncQueuedForDeployLabel({ issue, executionState, liveIssue, linear, project }).catch(() => undefined);

  const targetState = resolveDesiredActiveWorkflowState(issue, executionState, options, liveIssue);
  if (!targetState) return;

  const normalizedCurrent = liveIssue.stateName?.trim().toLowerCase();
  if (normalizedCurrent === targetState.trim().toLowerCase()) {
    refreshCachedLinearState(db, issue, liveIssue.stateName, liveIssue.stateType);
    return;
  }

  const updated = await linear.setIssueState(issue.linearIssueId, targetState);
  refreshCachedLinearState(db, issue, updated.stateName, updated.stateType);
}

// Plan §4.6: when the rendered execution state says the issue is waiting on
// landing/deploy automation but the project's Linear workflow has no
// In Deploy-equivalent state, we want
// the dashboard to be able to distinguish "in review, awaiting verdict"
// from "in review, queued for landing". A configurable PR/Linear label
// (`queuedForDeployLabel`, default `queued-for-deploy`) carries that
// signal idempotently. The helper computes the desired present/absent
// state and only calls the API when there's a delta — safe to run on
// every sync invocation.
async function syncQueuedForDeployLabel(params: {
  issue: Pick<IssueRecord, "linearIssueId">;
  executionState: IssueExecutionState;
  liveIssue: {
    workflowStates: Array<{ name: string; type?: string }>;
    labels: Array<{ id: string; name: string }>;
  };
  linear: NonNullable<Awaited<ReturnType<LinearClientProvider["forProject"]>>>;
  project: ProjectConfig | undefined;
}): Promise<void> {
  const { issue, executionState, liveIssue, linear, project } = params;
  const labelName = resolveMergeQueueProtocol(project).queuedForDeployLabel;
  const want = isQueuedForDeployFallback(executionState, liveIssue);
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

// True only when (a) the issue is in the merge queue (`awaiting_queue`)
// AND (b) the project's Linear workflow has no dedicated In Merge Queue
// state — detected by the preferred merge-queue state collapsing to the
// same name as the reviewing state. When the project has a real In Merge
// Queue (or Deploying) state, `setIssueState` flows the issue there and
// the label is unnecessary.
function isQueuedForDeployFallback(
  executionState: IssueExecutionState,
  liveIssue: { workflowStates: Array<{ name: string; type?: string }> },
): boolean {
  if (
    executionState.kind !== "idle_awaiting_external"
    || (executionState.waitingOn !== "merge_queue" && executionState.waitingOn !== "downstream_automation")
  ) return false;
  const mergeQueue = resolvePreferredMergeQueueLinearState(liveIssue);
  const reviewing = resolvePreferredReviewingLinearState(liveIssue);
  if (!mergeQueue || !reviewing) return false;
  // No dedicated merge-queue state → it collapses to the reviewing state.
  return mergeQueue.trim().toLowerCase() === reviewing.trim().toLowerCase();
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
  db.issueSessions.commitIssueState({
    writer: WRITER,
    update: {
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      ...(stateName ? { currentLinearState: stateName } : {}),
      ...(stateType ? { currentLinearStateType: stateType } : {}),
    },
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

type WorkflowStateIssue = Pick<IssueRecord,
  | "prNumber" | "prUrl" | "prState" | "prIsDraft" | "prReviewState"
  | "prCheckStatus" | "lastGitHubCiSnapshotJson" | "delegatedToPatchRelay">;

function deriveLinearExecutionState(db: PatchRelayDatabase, issue: IssueRecord): IssueExecutionState {
  const latestRun = db.runs.getLatestRunForIssue(issue.projectId, issue.linearIssueId);
  const activeRun = issue.activeRunId !== undefined ? db.runs.getRunById(issue.activeRunId) : undefined;
  const blockedByKeys = db.issues.listIssueDependencies(issue.projectId, issue.linearIssueId)
    .filter((entry) => entry.blockerCurrentLinearStateType !== "completed"
      && entry.blockerCurrentLinearState?.trim().toLowerCase() !== "done")
    .map((entry) => entry.blockerIssueKey ?? entry.blockerLinearIssueId);
  const runnableTaskRunType = peekRunnableWorkflowTaskRunType(
    { workflowTasks: db.workflowTasks },
    issue.projectId,
    issue.linearIssueId,
  );
  return deriveIssueExecutionStateFromRecords(issue, {
    ...(activeRun ? { activeRun } : {}),
    ...(latestRun ? { latestRun } : {}),
    blockedByKeys,
    ...(runnableTaskRunType ? { runnableTaskRunType } : {}),
  });
}

function resolveDesiredActiveWorkflowState(
  issue: WorkflowStateIssue,
  executionState: IssueExecutionState,
  _options: { activeRunType?: RunType } | undefined,
  liveIssue: {
    workflowStates: Array<{ name: string; type?: string }>;
  },
): string | undefined {
  if (needsHumanAttention(executionState)) {
    return resolvePreferredHumanNeededLinearState(liveIssue);
  }

  if (executionState.kind === "terminal" && executionState.outcome === "done") {
    return resolvePreferredCompletedLinearState(liveIssue);
  }

  const noPr = issue.prNumber === undefined && !issue.prUrl;
  if (noPr && (executionState.kind === "undelegated" || executionState.kind === "blocked")) {
    return resolvePreferredQueuedLinearState(liveIssue);
  }

  if (normalize(issue.prState) === "merged") {
    return resolvePreferredDeployingLinearState(liveIssue);
  }

  if (shouldRenderAuthorPhase(issue, executionState)) {
    return resolvePreferredImplementingLinearState(liveIssue);
  }

  if (executionState.kind === "idle_awaiting_external" && executionState.waitingOn === "merge_queue") {
    return resolvePreferredMergeQueueLinearState(liveIssue);
  }
  if (normalize(issue.prReviewState) === "approved") {
    return resolvePreferredMergeQueueLinearState(liveIssue);
  }

  if (isReviewBound(issue)) {
    return resolvePreferredReviewingLinearState(liveIssue);
  }

  return undefined;
}

function normalize(value: string | undefined): string | undefined {
  const trimmed = value?.trim().toLowerCase();
  return trimmed ? trimmed : undefined;
}

function needsHumanAttention(
  state: IssueExecutionState,
): boolean {
  return state.kind === "waiting_input"
    || (state.kind === "terminal" && state.outcome !== "done");
}

function shouldRenderAuthorPhase(
  issue: Pick<WorkflowStateIssue, "prIsDraft" | "prNumber" | "prUrl" | "delegatedToPatchRelay">,
  state: IssueExecutionState,
): boolean {
  if (issue.delegatedToPatchRelay === false) return false;
  if (issue.prIsDraft === true) return true;
  if (state.kind === "awaiting_followup") return true;
  if (state.kind === "ready") return true;
  if (state.kind === "running") {
    const noPr = issue.prNumber === undefined && !issue.prUrl;
    return noPr || state.run.runType === "implementation" || state.run.runType === "ci_repair" || state.run.runType === "queue_repair" || state.run.runType === "branch_upkeep";
  }
  return false;
}

function isReviewBound(issue: Pick<WorkflowStateIssue, "prNumber" | "prUrl" | "prReviewState" | "prCheckStatus" | "lastGitHubCiSnapshotJson">): boolean {
  return issue.prNumber !== undefined
    || Boolean(issue.prUrl)
    || issue.prReviewState !== undefined
    || issue.prCheckStatus !== undefined
    || hasPendingReviewQuillVerdict(issue.lastGitHubCiSnapshotJson);
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
