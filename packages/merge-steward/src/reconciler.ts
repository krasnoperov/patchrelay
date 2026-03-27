import type { GitOperations, CIRunner, GitHubPRApi, EvictionReporter } from "./interfaces.ts";
import type { QueueStore } from "./store.ts";
import type { QueueEntry, EvictionContext, FailureClass } from "./types.ts";
import { classifyFailure } from "./classify.ts";
import { randomUUID } from "node:crypto";

export interface ReconcileContext {
  store: QueueStore;
  repoId: string;
  baseBranch: string;
  git: GitOperations;
  ci: CIRunner;
  github: GitHubPRApi;
  eviction: EvictionReporter;
  flakyRetries: number;
  mergeMethod: "merge" | "squash";
  onMerged: (prNumber: number) => void;
  onEvicted: (prNumber: number, context: EvictionContext) => void;
  onMainBroken: () => void;
}

/**
 * Serial reconciler.
 *
 * Each tick processes at most one state transition for the queue head.
 *
 *   queued → preparing_head → validating → merging → merged
 *
 * Failure: eviction after retry budget exhausted.
 * Conflict retries are gated on base SHA change (non-spinning).
 * CI retries use flakyRetries budget, then count toward retryAttempts.
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

    case "paused":
      break;

    default:
      break;
  }
}

/**
 * Rebase the head branch onto the base branch.
 *
 * Non-spinning retry: if the conflict happened on the same base SHA
 * as last time, do nothing — wait for main to advance.
 */
async function prepareHead(ctx: ReconcileContext, entry: QueueEntry): Promise<void> {
  // Check if main CI is green before rebasing.
  if (ctx.ci.getMainStatus) {
    const mainStatus = await ctx.ci.getMainStatus(ctx.baseBranch);
    if (mainStatus === "fail") {
      ctx.onMainBroken();
      return;
    }
  }

  // Branch ownership: verify head SHA matches what we expect.
  const currentRef = await ctx.git.headSha(entry.branch);
  if (currentRef !== entry.headSha) {
    ctx.store.updateHead(entry.id, currentRef);
    return;
  }

  const currentBaseSha = await ctx.git.headSha(ctx.baseBranch);

  // Budget exhausted — evict regardless of base change.
  if (entry.retryAttempts >= entry.maxRetries && entry.lastFailedBaseSha !== null) {
    await evictEntry(ctx, entry, "integration_conflict");
    return;
  }

  // Non-spinning: if the last conflict was on this same base, skip the
  // rebase entirely. Wait for main to advance before trying again.
  if (entry.lastFailedBaseSha === currentBaseSha) {
    return;
  }

  const result = await ctx.git.rebase(entry.branch, ctx.baseBranch);

  if (result.success) {
    const newHeadSha = result.newHeadSha ?? entry.headSha;
    await ctx.git.push(entry.branch, true);
    const runId = await ctx.ci.triggerRun(entry.branch, newHeadSha);
    ctx.store.transition(entry.id, "validating", {
      headSha: newHeadSha,
      baseSha: currentBaseSha,
      ciRunId: runId,
      lastFailedBaseSha: null,
    });
  } else {
    // Conflict.
    if (entry.retryAttempts >= entry.maxRetries) {
      await evictEntry(ctx, entry, "integration_conflict",
        result.conflictFiles ? { conflictFiles: result.conflictFiles } : undefined);
    } else {
      // Record this conflict. Next tick will skip rebase until base changes.
      ctx.store.transition(entry.id, "preparing_head", {
        retryAttempts: entry.retryAttempts + 1,
        lastFailedBaseSha: currentBaseSha,
      });
    }
  }
}

/**
 * Check CI status for the validating head.
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

    case "fail": {
      if (entry.ciRetries < ctx.flakyRetries) {
        // Flaky retry — doesn't count toward retryAttempts.
        const runId = await ctx.ci.triggerRun(entry.branch, entry.headSha);
        ctx.store.transition(entry.id, "validating", {
          ciRunId: runId,
          ciRetries: entry.ciRetries + 1,
        });
      } else if (entry.retryAttempts >= entry.maxRetries) {
        // Budget exhausted.
        const branchChecks = await ctx.github.listChecks(entry.prNumber);
        const failedChecks = branchChecks
          .filter((c) => c.conclusion === "failure" || c.conclusion === "timed_out" || c.conclusion === "cancelled")
          .map((c) => ({ name: c.name, conclusion: c.conclusion }));
        const failureClass = classifyFailure(branchChecks, []);
        await evictEntry(ctx, entry, failureClass, { failedChecks });
      } else {
        // Retry: go back to preparing_head for a fresh rebase + CI cycle.
        ctx.store.transition(entry.id, "preparing_head", {
          retryAttempts: entry.retryAttempts + 1,
          ciRunId: null,
          ciRetries: 0,
        });
      }
      break;
    }
  }
}

/**
 * Merge the head PR. Includes revalidation checks before the actual merge.
 */
async function mergeHead(ctx: ReconcileContext, entry: QueueEntry): Promise<void> {
  // Revalidation.
  const prStatus = await ctx.github.getStatus(entry.prNumber);

  if (prStatus.merged) {
    ctx.store.transition(entry.id, "merged");
    ctx.onMerged(entry.prNumber);
    return;
  }

  if (!prStatus.reviewApproved) {
    await evictEntry(ctx, entry, "policy_blocked");
    return;
  }

  if (prStatus.headSha !== entry.headSha) {
    ctx.store.updateHead(entry.id, prStatus.headSha);
    return;
  }

  // Merge via GitHub API. No local merge needed — the steward's clone
  // is for rebasing only. GitHub handles the actual merge to main.
  try {
    await ctx.github.mergePR(entry.prNumber, ctx.mergeMethod);
  } catch {
    // GitHub rejected the merge (branch protection, conflicts, etc.).
    if (entry.retryAttempts >= entry.maxRetries) {
      await evictEntry(ctx, entry, "integration_conflict");
    } else {
      ctx.store.transition(entry.id, "preparing_head", {
        retryAttempts: entry.retryAttempts + 1,
        ciRunId: null,
        ciRetries: 0,
      });
    }
    return;
  }
  ctx.store.transition(entry.id, "merged");
  ctx.onMerged(entry.prNumber);
}

/**
 * Evict an entry and create a durable incident record.
 */
async function evictEntry(
  ctx: ReconcileContext,
  entry: QueueEntry,
  failureClass: FailureClass,
  extra?: { conflictFiles?: string[]; failedChecks?: Array<{ name: string; conclusion: string }> },
): Promise<void> {
  const context: EvictionContext = {
    version: 1,
    failureClass,
    baseSha: entry.baseSha,
    prHeadSha: entry.headSha,
    queuePosition: entry.position,
    conflictFiles: extra?.conflictFiles,
    failedChecks: extra?.failedChecks,
    retryHistory: [], // populated from events in production
  };

  const incident = {
    id: randomUUID(),
    entryId: entry.id,
    at: new Date().toISOString(),
    failureClass,
    context,
    outcome: "open" as const,
  };

  ctx.store.insertIncident(incident);
  ctx.store.transition(entry.id, "evicted");
  await ctx.eviction.reportEviction(entry, incident);
  ctx.onEvicted(entry.prNumber, context);
}
