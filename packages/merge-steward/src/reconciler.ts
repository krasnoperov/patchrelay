import type { GitOperations, CIRunner, GitHubPRApi, RepairDispatcher } from "./interfaces.ts";
import type { QueueStore } from "./store.ts";
import type { QueueEntry, QueueEntryStatus, FailureClass } from "./types.ts";
import { TERMINAL_STATUSES } from "./types.ts";
import { classifyFailure } from "./classify.ts";

export interface ReconcileContext {
  store: QueueStore;
  repoId: string;
  baseBranch: string;
  git: GitOperations;
  ci: CIRunner;
  github: GitHubPRApi;
  repair: RepairDispatcher;
  flakyRetries: number;
  onMerged: (prNumber: number) => void;
  onMainBroken: () => void;
}

/**
 * Phase 1 serial reconciler.
 *
 * Each tick processes at most one state transition for the queue head.
 * Non-head entries remain frozen until the head is terminal.
 *
 * State machine per entry:
 *   queued → preparing_head → validating → merging → merged
 *
 * Failure branches:
 *   preparing_head   → repair_requested   (conflict during rebase)
 *   validating       → validating         (flaky retry)
 *   validating       → repair_requested   (CI failure, retries exhausted)
 *   repair_requested → repair_in_progress (dispatch to PatchRelay)
 *   repair_requested → evicted            (repair budget exhausted)
 *
 * The queue pauses at repair_in_progress until an external callback
 * (completeRepair) transitions the entry back to preparing_head.
 */
export async function reconcile(ctx: ReconcileContext): Promise<void> {
  const head = ctx.store.getHead(ctx.repoId);
  if (!head) return;

  switch (head.status) {
    case "queued":
      ctx.store.transition(head.id, "preparing_head");
      break;

    case "preparing_head":
      await prepareHead(ctx, head);
      break;

    case "validating":
      await checkValidation(ctx, head);
      break;

    case "merging":
      await mergeHead(ctx, head);
      break;

    case "repair_requested":
      await handleRepairRequest(ctx, head);
      break;

    case "repair_in_progress":
      // Waiting for external completeRepair() callback. No action.
      break;

    case "paused":
      // Reserved for Phase 2 (policy_blocked). No action.
      break;

    default:
      // merged, evicted, dequeued — terminal, no action.
      break;
  }
}

/**
 * Rebase the head branch onto the base branch.
 * On success: transition to validating and trigger CI.
 * On conflict: transition to repair_requested.
 */
async function prepareHead(ctx: ReconcileContext, entry: QueueEntry): Promise<void> {
  // Check if main CI is green before rebasing.
  if (ctx.ci.getMainStatus) {
    const mainStatus = await ctx.ci.getMainStatus(ctx.baseBranch);
    if (mainStatus === "fail") {
      ctx.onMainBroken();
      return; // Stay in preparing_head, retry next tick.
    }
  }

  const result = await ctx.git.rebase(entry.branch, ctx.baseBranch);

  if (result.success) {
    const newHeadSha = result.newHeadSha ?? entry.headSha;
    const baseSha = await ctx.git.headSha(ctx.baseBranch);
    await ctx.git.push(entry.branch, true);
    const runId = await ctx.ci.triggerRun(entry.branch, newHeadSha);
    ctx.store.transition(entry.id, "validating", {
      headSha: newHeadSha,
      baseSha,
      ciRunId: runId,
    });
  } else {
    if (entry.repairAttempts >= entry.maxRepairAttempts) {
      ctx.store.transition(entry.id, "evicted");
    } else {
      ctx.store.transition(entry.id, "repair_requested");
    }
  }
}

/**
 * Check CI status for the validating head.
 * Pass → merging. Fail → retry (flaky) or repair_requested. Pending → wait.
 */
async function checkValidation(ctx: ReconcileContext, entry: QueueEntry): Promise<void> {
  if (!entry.ciRunId) {
    const runId = await ctx.ci.triggerRun(entry.branch, entry.headSha);
    ctx.store.transition(entry.id, "validating", { ciRunId: runId });
    return;
  }

  const status = await ctx.ci.getStatus(entry.ciRunId);

  switch (status) {
    case "pending":
      break;

    case "pass":
      ctx.store.transition(entry.id, "merging");
      break;

    case "fail":
      if (entry.ciRetries < ctx.flakyRetries) {
        const runId = await ctx.ci.triggerRun(entry.branch, entry.headSha);
        ctx.store.transition(entry.id, "validating", {
          ciRunId: runId,
          ciRetries: entry.ciRetries + 1,
        });
      } else {
        if (entry.repairAttempts >= entry.maxRepairAttempts) {
          ctx.store.transition(entry.id, "evicted");
        } else {
          ctx.store.transition(entry.id, "repair_requested");
        }
      }
      break;
  }
}

/**
 * Merge the head PR into the base branch.
 */
async function mergeHead(ctx: ReconcileContext, entry: QueueEntry): Promise<void> {
  // Revalidation: check PR is still in a mergeable state.
  const prStatus = await ctx.github.getStatus(entry.prNumber);

  if (prStatus.merged) {
    // Already merged externally — acknowledge.
    ctx.store.transition(entry.id, "merged");
    ctx.onMerged(entry.prNumber);
    return;
  }

  if (!prStatus.reviewApproved) {
    // Approval withdrawn.
    ctx.store.transition(entry.id, "evicted");
    return;
  }

  if (prStatus.headSha !== entry.headSha) {
    // PR was force-pushed since validation. Reset.
    ctx.store.updateHead(entry.id, prStatus.headSha);
    return;
  }

  const result = await ctx.git.merge(entry.branch, ctx.baseBranch);
  if (!result.success) {
    if (entry.repairAttempts >= entry.maxRepairAttempts) {
      ctx.store.transition(entry.id, "evicted");
    } else {
      ctx.store.transition(entry.id, "repair_requested");
    }
    return;
  }

  await ctx.github.mergePR(entry.prNumber, "squash");
  ctx.store.transition(entry.id, "merged");
  ctx.onMerged(entry.prNumber);
}

/**
 * Handle a repair request — dispatch to PatchRelay or evict if budget exhausted.
 */
async function handleRepairRequest(ctx: ReconcileContext, entry: QueueEntry): Promise<void> {
  if (entry.repairAttempts >= entry.maxRepairAttempts) {
    ctx.store.transition(entry.id, "evicted");
    return;
  }

  const newAttempts = entry.repairAttempts + 1;
  ctx.store.transition(entry.id, "repair_in_progress", { repairAttempts: newAttempts });

  // Read the updated entry for the repair context.
  const updated = ctx.store.getEntry(entry.id)!;

  const allActive = ctx.store.listActive(ctx.repoId);
  const ahead = allActive
    .filter((e) => e.position < updated.position)
    .map((e) => e.prNumber);
  const behind = allActive
    .filter((e) => e.position > updated.position)
    .map((e) => e.prNumber);

  // Gather check data for classification and repair context.
  const branchChecks = await ctx.github.listChecks(updated.prNumber);
  const failedChecks = branchChecks
    .filter((c) => c.conclusion === "failure" || c.conclusion === "timed_out" || c.conclusion === "cancelled")
    .map((c) => ({ name: c.name, url: c.url, conclusion: c.conclusion as "failure" | "timed_out" | "cancelled" }));

  const failureClass: FailureClass = failedChecks.length > 0
    ? classifyFailure(branchChecks, []) // main baseline populated when real adapters land
    : "integration_conflict";

  const repairKind = failureClass === "branch_local" ? "ci_repair" as const : "queue_repair" as const;

  const repairReq = {
    id: `rr-${updated.id}-${newAttempts}`,
    entryId: updated.id,
    at: new Date().toISOString(),
    kind: repairKind,
    failureClass,
    outcome: "pending" as const,
  };
  ctx.store.insertRepairRequest(repairReq);

  const repairFailureClass = failureClass === "branch_local" ? "branch_local" as const : "integration_conflict" as const;

  await ctx.repair.requestRepair({
    queueEntryId: updated.id,
    issueKey: updated.issueKey,
    prNumber: updated.prNumber,
    prHeadSha: updated.headSha,
    baseSha: updated.baseSha,
    failureClass: repairFailureClass,
    failedChecks,
    baselineChecksOnMain: [],
    queuePosition: updated.position,
    aheadPrNumbers: ahead,
    behindPrNumbers: behind,
    priorAttempts: ctx.store.listRepairRequests(updated.id)
      .filter((r) => r.outcome !== "pending")
      .map((r) => ({
        at: r.at,
        kind: r.kind,
        summary: r.summary,
        outcome: r.outcome as "failed" | "succeeded" | "abandoned",
      })),
    attemptBudget: {
      current: newAttempts,
      max: updated.maxRepairAttempts,
    },
  });
}

/**
 * External callback: repair is complete, resume the entry.
 * Called by PatchRelay (or the test harness) when a repair run finishes.
 * Resets CI state so the next tick retries rebase + CI from scratch.
 */
export function completeRepair(store: QueueStore, queueEntryId: string): boolean {
  const entry = store.getEntry(queueEntryId);
  if (!entry || entry.status !== "repair_in_progress") return false;
  store.transition(entry.id, "preparing_head", { ciRunId: null, ciRetries: 0 });
  return true;
}
