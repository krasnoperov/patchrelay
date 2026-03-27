import type { GitOperations, CIRunner, GitHubPRApi, RepairDispatcher } from "./interfaces.ts";
import type { QueueEntry, QueueEntryStatus } from "./types.ts";

const TERMINAL: QueueEntryStatus[] = ["merged", "evicted"];

export interface ReconcileContext {
  entries: QueueEntry[];
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
 *   preparing_head → repair_requested  (conflict during rebase)
 *   validating     → validating        (flaky retry)
 *   validating     → repair_requested  (CI failure, retries exhausted)
 *   repair_requested → evicted         (repair budget exhausted)
 */
export async function reconcile(ctx: ReconcileContext): Promise<void> {
  const head = findHead(ctx.entries);
  if (!head) return;

  switch (head.status) {
    case "queued":
      // Promote to preparing_head — this is the head now.
      transition(head, "preparing_head");
      break;

    case "preparing_head":
      await prepareHead(ctx, head);
      break;

    case "validating":
      await checkValidation(ctx, head);
      break;

    case "passed":
      transition(head, "merging");
      break;

    case "merging":
      await mergeHead(ctx, head);
      break;

    case "repair_requested":
      await handleRepairRequest(ctx, head);
      break;

    case "repair_in_progress":
      // Waiting for PatchRelay. No action this tick.
      break;

    case "paused":
      // Manual intervention needed. No action.
      break;

    default:
      // waiting_head, merged, evicted — no action for head.
      break;
  }
}

/**
 * Find the current queue head: the first non-terminal entry by position.
 */
function findHead(entries: QueueEntry[]): QueueEntry | undefined {
  return entries
    .filter((e) => !TERMINAL.includes(e.status))
    .sort((a, b) => a.position - b.position)[0];
}

/**
 * Rebase the head branch onto the base branch.
 * On success: transition to validating and trigger CI.
 * On conflict: transition to repair_requested.
 */
async function prepareHead(ctx: ReconcileContext, entry: QueueEntry): Promise<void> {
  const result = await ctx.git.rebase(entry.branch, ctx.baseBranch);

  if (result.success) {
    if (result.newHeadSha) {
      entry.headSha = result.newHeadSha;
    }
    entry.baseSha = await ctx.git.headSha(ctx.baseBranch);
    await ctx.git.push(entry.branch, true);
    // Trigger CI.
    const runId = await ctx.ci.triggerRun(entry.branch, entry.headSha);
    entry.ciRunId = runId;
    transition(entry, "validating");
  } else {
    // Conflict — need repair or eviction.
    if (entry.repairAttempts >= entry.maxRepairAttempts) {
      transition(entry, "evicted");
    } else {
      transition(entry, "repair_requested");
    }
  }
}

/**
 * Check CI status for the validating head.
 * Pass → merging. Fail → retry (flaky) or repair_requested. Pending → wait.
 */
async function checkValidation(ctx: ReconcileContext, entry: QueueEntry): Promise<void> {
  if (!entry.ciRunId) {
    // No CI run — trigger one.
    const runId = await ctx.ci.triggerRun(entry.branch, entry.headSha);
    entry.ciRunId = runId;
    return;
  }

  const status = await ctx.ci.getStatus(entry.ciRunId);

  switch (status) {
    case "pending":
      // Still running — wait for next tick.
      break;

    case "pass":
      transition(entry, "merging");
      break;

    case "fail":
      // Can we retry as flaky?
      if (entry.ciRetries < ctx.flakyRetries) {
        entry.ciRetries++;
        // Trigger a new CI run.
        const runId = await ctx.ci.triggerRun(entry.branch, entry.headSha);
        entry.ciRunId = runId;
        // Stay in validating.
      } else {
        // Flaky retries exhausted — escalate.
        if (entry.repairAttempts >= entry.maxRepairAttempts) {
          transition(entry, "evicted");
        } else {
          transition(entry, "repair_requested");
        }
      }
      break;
  }
}

/**
 * Merge the head PR into the base branch.
 */
async function mergeHead(ctx: ReconcileContext, entry: QueueEntry): Promise<void> {
  // Merge the branch into base in git.
  const result = await ctx.git.merge(entry.branch, ctx.baseBranch);
  if (!result.success) {
    // Merge failed at merge time — shouldn't happen if rebase succeeded,
    // but handle defensively.
    if (entry.repairAttempts >= entry.maxRepairAttempts) {
      transition(entry, "evicted");
    } else {
      transition(entry, "repair_requested");
    }
    return;
  }

  // Notify GitHub to mark PR as merged.
  await ctx.github.mergePR(entry.prNumber, "squash");

  transition(entry, "merged");
  ctx.onMerged(entry.prNumber);
}

/**
 * Handle a repair request — dispatch to PatchRelay or evict if budget exhausted.
 */
async function handleRepairRequest(ctx: ReconcileContext, entry: QueueEntry): Promise<void> {
  if (entry.repairAttempts >= entry.maxRepairAttempts) {
    transition(entry, "evicted");
    return;
  }

  entry.repairAttempts++;

  // Build the repair context.
  const allEntries = ctx.entries;
  const ahead = allEntries
    .filter((e) => e.position < entry.position && !TERMINAL.includes(e.status))
    .map((e) => e.prNumber);
  const behind = allEntries
    .filter((e) => e.position > entry.position && !TERMINAL.includes(e.status))
    .map((e) => e.prNumber);

  await ctx.repair.requestRepair({
    queueEntryId: entry.id,
    issueId: entry.id, // In sim, issue ID = entry ID.
    prNumber: entry.prNumber,
    prHeadSha: entry.headSha,
    baseSha: entry.baseSha,
    failureClass: "integration_conflict",
    failedChecks: [],
    baselineChecksOnMain: [],
    queuePosition: entry.position,
    aheadPrNumbers: ahead,
    behindPrNumbers: behind,
    priorAttempts: [],
    attemptBudget: {
      current: entry.repairAttempts,
      max: entry.maxRepairAttempts,
    },
  });

  // In simulation, repair is instant (no async wait).
  // After dispatching, the entry should go back to preparing_head
  // so the next tick retries the rebase.
  // In production, this would transition to repair_in_progress and
  // wait for PatchRelay's callback.
  transition(entry, "preparing_head");
}

function transition(entry: QueueEntry, to: QueueEntryStatus): void {
  entry.status = to;
  entry.updatedAt = new Date().toISOString();
}
