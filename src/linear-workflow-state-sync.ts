import type { PatchRelayDatabase } from "./db.ts";
import type { IssueRecord, TrackedIssueRecord } from "./db-types.ts";
import type { RunType } from "./factory-state.ts";
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
    workflowStates: Array<{ name: string; type?: string }>;
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

// True only when (a) the issue is in the merge queue (`awaiting_queue`)
// AND (b) the project's Linear workflow has no dedicated In Merge Queue
// state — detected by the preferred merge-queue state collapsing to the
// same name as the reviewing state. When the project has a real In Merge
// Queue (or Deploying) state, `setIssueState` flows the issue there and
// the label is unnecessary.
function isQueuedForDeployFallback(
  issue: Pick<IssueRecord, "factoryState">,
  liveIssue: { workflowStates: Array<{ name: string; type?: string }> },
): boolean {
  if (issue.factoryState !== "awaiting_queue") return false;
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

type WorkflowStateIssue = Pick<IssueRecord,
  | "factoryState" | "prNumber" | "prUrl" | "prState" | "prIsDraft" | "prReviewState"
  | "prCheckStatus" | "lastGitHubCiSnapshotJson" | "delegatedToPatchRelay">;
type WorkflowTracked = Pick<TrackedIssueRecord, "sessionState" | "blockedByCount" | "readyForExecution">;

// ─── Unified PR-lifecycle → Linear-state mapping ─────────────────────
//
// Five phases, in lifecycle order:
//   Implementing → Reviewing → In Merge Queue → Deploying → Done
//
// Every phase is decided from DURABLE signals (factoryState, prState,
// prReviewState) — never the ephemeral activeRunId / sessionState / run
// type. That is what kills the Implementing↔Reviewing flap: the state
// only moves on a real lifecycle handoff (a review verdict, an approval,
// a merge), not on whichever transient webhook happens to recompute it
// while a run briefly holds a lease.
//
// Branches are ordered "furthest along the lifecycle wins" so a stale
// earlier signal can never pull a more-advanced issue backwards.
function resolveDesiredActiveWorkflowState(
  issue: WorkflowStateIssue,
  trackedIssue: WorkflowTracked | undefined,
  _options: { activeRunType?: RunType } | undefined,
  liveIssue: {
    workflowStates: Array<{ name: string; type?: string }>;
  },
): string | undefined {
  // 1. Operator must act — overrides everything.
  if (needsHumanAttention(issue, trackedIssue)) {
    return resolvePreferredHumanNeededLinearState(liveIssue);
  }

  // 2. Completed → Done. Covers today's merge→done path (the factory has
  //    no post-merge state yet), so a done issue never reads as Deploying.
  if (issue.factoryState === "done") {
    return resolvePreferredCompletedLinearState(liveIssue);
  }

  // 3. Paused with no PR and nothing for us to do → backlog.
  const blocked = (trackedIssue?.blockedByCount ?? 0) > 0;
  const noPr = issue.prNumber === undefined && !issue.prUrl;
  if (noPr && (issue.delegatedToPatchRelay === false || blocked)) {
    return resolvePreferredQueuedLinearState(liveIssue);
  }

  // 4. Post-merge: the change is on main, deploy running → Deploying.
  //    Durable signals: factoryState === "deploying" (post-merge deploy
  //    watch in progress) or the PR is merged but not yet done.
  if (issue.factoryState === "deploying" || normalize(issue.prState) === "merged") {
    return resolvePreferredDeployingLinearState(liveIssue);
  }

  // 5. Patchrelay is actively addressing review/CI/queue feedback →
  //    Implementing. These factory states persist for the run's whole
  //    duration, so this is stable, not flappy — and it is exactly the
  //    "show when patchrelay handles feedback" behavior we want.
  if (isAddressingFeedback(issue)) {
    return resolvePreferredImplementingLinearState(liveIssue);
  }

  // 6. Approved / admitted to the merge queue → In Merge Queue.
  if (isInMergeQueue(issue)) {
    return resolvePreferredMergeQueueLinearState(liveIssue);
  }

  // 7. Pre-review-feedback implementation work (incl. a draft PR) →
  //    Implementing.
  if (isImplementing(issue, trackedIssue)) {
    return resolvePreferredImplementingLinearState(liveIssue);
  }

  // 8. PR exists and is under review → Reviewing.
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
  issue: Pick<WorkflowStateIssue, "factoryState">,
  trackedIssue: Pick<WorkflowTracked, "sessionState"> | undefined,
): boolean {
  return issue.factoryState === "awaiting_input"
    || issue.factoryState === "failed"
    || issue.factoryState === "escalated"
    || trackedIssue?.sessionState === "waiting_input"
    || trackedIssue?.sessionState === "failed";
}

// Active code work to address feedback. Durable factory states +
// changes-requested review verdict — no run-id involvement. Gated on
// delegation: an undelegated PR (operator paused us) is not being worked
// by patchrelay, so it must not read as Implementing.
function isAddressingFeedback(issue: Pick<WorkflowStateIssue, "factoryState" | "prReviewState" | "delegatedToPatchRelay">): boolean {
  if (issue.delegatedToPatchRelay === false) return false;
  return issue.factoryState === "changes_requested"
    || issue.factoryState === "repairing_ci"
    || issue.factoryState === "repairing_queue"
    || normalize(issue.prReviewState) === "changes_requested";
}

// Approved and heading to / sitting in the merge queue. Not yet merged
// (branch 4 catches merged first).
function isInMergeQueue(issue: Pick<WorkflowStateIssue, "factoryState" | "prReviewState">): boolean {
  return issue.factoryState === "awaiting_queue"
    || normalize(issue.prReviewState) === "approved";
}

// Initial implementation, before review starts. A draft PR still counts
// as implementing. Gated on delegation so we never claim Implementing
// for work that isn't ours.
function isImplementing(
  issue: Pick<WorkflowStateIssue, "factoryState" | "prIsDraft" | "delegatedToPatchRelay">,
  trackedIssue: Pick<WorkflowTracked, "blockedByCount" | "readyForExecution"> | undefined,
): boolean {
  if (issue.delegatedToPatchRelay === false) return false;
  if (issue.factoryState === "implementing") return true;
  if (issue.factoryState === "delegated") {
    const blocked = (trackedIssue?.blockedByCount ?? 0) > 0;
    return !blocked && trackedIssue?.readyForExecution !== false;
  }
  return issue.prIsDraft === true;
}

function isReviewBound(issue: Pick<WorkflowStateIssue, "factoryState" | "prNumber" | "prUrl" | "prReviewState" | "prCheckStatus" | "lastGitHubCiSnapshotJson">): boolean {
  return issue.prNumber !== undefined
    || Boolean(issue.prUrl)
    || issue.factoryState === "pr_open"
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
