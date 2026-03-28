import type { GitOperations, CIRunner, GitHubPRApi, EvictionReporter, SpeculativeBranchBuilder } from "./interfaces.ts";
import type { QueueStore } from "./store.ts";
import type { QueueEntry, EvictionContext, FailureClass } from "./types.ts";
import { TERMINAL_STATUSES } from "./types.ts";
import { classifyFailure } from "./classify.ts";
import { randomUUID } from "node:crypto";

export interface ReconcileContext {
  store: QueueStore;
  repoId: string;
  baseBranch: string;
  /** Prefix for remote refs. Production: "origin/". Sim: "". */
  remotePrefix: string;
  git: GitOperations;
  ci: CIRunner;
  github: GitHubPRApi;
  eviction: EvictionReporter;
  specBuilder: SpeculativeBranchBuilder | null;
  speculativeDepth: number;
  flakyRetries: number;
  mergeMethod: "merge" | "squash";
  onMerged: (prNumber: number) => void;
  onEvicted: (prNumber: number, context: EvictionContext) => void;
  onMainBroken: () => void;
}

/**
 * Reconciler with speculative execution.
 *
 * Processes up to `speculativeDepth` active entries per tick:
 * - Entry at index 0 (head): rebase onto main, CI, merge
 * - Entries at index 1..N: build speculative cumulative branches, CI in parallel
 *
 * When speculativeDepth is 1 or specBuilder is null, behaves as serial queue.
 *
 *   queued → preparing_head → validating → merging → merged
 */
export async function reconcile(ctx: ReconcileContext): Promise<void> {
  const allActive = ctx.store.listActive(ctx.repoId);
  if (allActive.length === 0) return;

  // How many entries to process speculatively this tick.
  const depth = ctx.specBuilder ? Math.min(ctx.speculativeDepth, allActive.length) : 1;

  // Process entries in order. Re-read from store each iteration because
  // earlier iterations may have transitioned entries within this tick.
  for (let i = 0; i < depth; i++) {
    const entryId = allActive[i]!.id;
    const entry = ctx.store.getEntry(entryId);
    if (!entry || TERMINAL_STATUSES.includes(entry.status)) continue;
    const isHead = i === 0;
    const prevEntryId = i > 0 ? allActive[i - 1]!.id : null;
    const prevEntry = prevEntryId ? ctx.store.getEntry(prevEntryId) : null;

    switch (entry.status) {
      case "queued":
        ctx.store.transition(entry.id, "preparing_head");
        break;

      case "preparing_head":
        if (isHead) {
          await prepareHead(ctx, entry);
        } else if (ctx.specBuilder && prevEntry) {
          await prepareSpeculative(ctx, entry, prevEntry);
        }
        break;

      case "validating": {
        const freshActive = ctx.store.listActive(ctx.repoId);
        const freshIndex = freshActive.findIndex((e) => e.id === entry.id);
        await checkValidation(ctx, entry, freshActive, freshIndex >= 0 ? freshIndex : i);
        break;
      }

      case "merging":
        if (isHead) {
          const freshActive = ctx.store.listActive(ctx.repoId);
          await mergeHead(ctx, entry, freshActive);
        }
        // Non-head entries in merging wait for head to merge first.
        break;

      default:
        break;
    }
  }
}

// ─── Head entry: rebase onto main ───────────────────────────────

async function prepareHead(ctx: ReconcileContext, entry: QueueEntry): Promise<void> {
  const r = ctx.remotePrefix;

  await ctx.git.fetch();

  if (ctx.ci.getMainStatus) {
    const mainStatus = await ctx.ci.getMainStatus(ctx.baseBranch);
    if (mainStatus === "fail") {
      ctx.onMainBroken();
      return;
    }
  }

  const currentRef = await ctx.git.headSha(r + entry.branch);
  if (currentRef !== entry.headSha) {
    ctx.store.updateHead(entry.id, currentRef);
    return;
  }

  const currentBaseSha = await ctx.git.headSha(r + ctx.baseBranch);

  if (entry.retryAttempts >= entry.maxRetries && entry.lastFailedBaseSha !== null) {
    await evictEntry(ctx, entry, "integration_conflict");
    return;
  }

  if (entry.lastFailedBaseSha === currentBaseSha) {
    return;
  }

  const result = await ctx.git.rebase(entry.branch, r + ctx.baseBranch);

  if (result.success) {
    const newHeadSha = result.newHeadSha ?? entry.headSha;
    await ctx.git.push(entry.branch, true);

    // Also build a speculative branch for the head so downstream entries
    // can base their speculative branches on it.
    let specBranch: string | null = null;
    let specSha: string | null = null;
    if (ctx.specBuilder) {
      specBranch = `mq-spec-${entry.id}`;
      const specResult = await ctx.specBuilder.buildSpeculative(
        entry.branch, r + ctx.baseBranch, specBranch,
      );
      specSha = specResult.success ? (specResult.sha ?? newHeadSha) : null;
      if (!specResult.success) specBranch = null;
    }

    const runId = await ctx.ci.triggerRun(entry.branch, newHeadSha);
    ctx.store.transition(entry.id, "validating", {
      headSha: newHeadSha,
      baseSha: currentBaseSha,
      ciRunId: runId,
      lastFailedBaseSha: null,
      specBranch,
      specSha,
      specBasedOn: null,
    });
  } else {
    if (entry.retryAttempts >= entry.maxRetries) {
      await evictEntry(ctx, entry, "integration_conflict",
        result.conflictFiles ? { conflictFiles: result.conflictFiles } : undefined);
    } else {
      ctx.store.transition(entry.id, "preparing_head", {
        retryAttempts: entry.retryAttempts + 1,
        lastFailedBaseSha: currentBaseSha,
      });
    }
  }
}

// ─── Non-head entry: build speculative cumulative branch ────────

async function prepareSpeculative(
  ctx: ReconcileContext,
  entry: QueueEntry,
  prevEntry: QueueEntry,
): Promise<void> {
  if (!ctx.specBuilder) return;

  // The previous entry must have a speculative branch to base on.
  if (!prevEntry.specBranch) return;

  const specName = `mq-spec-${entry.id}`;
  const result = await ctx.specBuilder.buildSpeculative(
    entry.branch, prevEntry.specBranch, specName,
  );

  if (result.success) {
    const specSha = result.sha ?? entry.headSha;
    const runId = await ctx.ci.triggerRun(specName, specSha);
    ctx.store.transition(entry.id, "validating", {
      ciRunId: runId,
      specBranch: specName,
      specSha,
      specBasedOn: prevEntry.id,
    });
  } else {
    // Conflict building speculative branch — this PR conflicts with the chain.
    if (entry.retryAttempts >= entry.maxRetries) {
      await evictEntry(ctx, entry, "integration_conflict");
    } else {
      ctx.store.transition(entry.id, "preparing_head", {
        retryAttempts: entry.retryAttempts + 1,
        lastFailedBaseSha: prevEntry.specSha,
      });
    }
  }
}

// ─── CI validation ──────────────────────────────────────────────

async function checkValidation(
  ctx: ReconcileContext,
  entry: QueueEntry,
  allActive: QueueEntry[],
  index: number,
): Promise<void> {
  if (!entry.ciRunId) {
    const branch = entry.specBranch ?? entry.branch;
    const sha = entry.specSha ?? entry.headSha;
    const runId = await ctx.ci.triggerRun(branch, sha);
    ctx.store.transition(entry.id, "validating", { ciRunId: runId });
    return;
  }

  const status = await ctx.ci.getStatus(entry.ciRunId);

  switch (status) {
    case "pending":
      break;

    case "pass":
      if (index === 0) {
        // Head entry: advance to merging.
        ctx.store.transition(entry.id, "merging");
      }
      // Non-head entries stay in validating until they become head.
      // Their spec result is valid — speculative consistency.
      break;

    case "fail": {
      if (entry.ciRetries < ctx.flakyRetries) {
        const branch = entry.specBranch ?? entry.branch;
        const sha = entry.specSha ?? entry.headSha;
        const runId = await ctx.ci.triggerRun(branch, sha);
        ctx.store.transition(entry.id, "validating", {
          ciRunId: runId,
          ciRetries: entry.ciRetries + 1,
        });
      } else if (entry.retryAttempts >= entry.maxRetries) {
        const branchChecks = await ctx.github.listChecks(entry.prNumber);
        const failedChecks = branchChecks
          .filter((c) => c.conclusion === "failure" || c.conclusion === "timed_out" || c.conclusion === "cancelled")
          .map((c) => ({ name: c.name, conclusion: c.conclusion }));
        const failureClass = classifyFailure(branchChecks, []);
        await evictEntry(ctx, entry, failureClass, { failedChecks });

        // Invalidate downstream entries that depended on this one.
        await invalidateDownstream(ctx, allActive, index);
      } else {
        ctx.store.transition(entry.id, "preparing_head", {
          retryAttempts: entry.retryAttempts + 1,
          ciRunId: null,
          ciRetries: 0,
          specBranch: null,
          specSha: null,
          specBasedOn: null,
        });
        // Invalidate downstream.
        await invalidateDownstream(ctx, allActive, index);
      }
      break;
    }
  }
}

// ─── Merge (head only) ──────────────────────────────────────────

async function mergeHead(
  ctx: ReconcileContext,
  entry: QueueEntry,
  allActive: QueueEntry[],
): Promise<void> {
  const prStatus = await ctx.github.getStatus(entry.prNumber);

  if (prStatus.merged) {
    ctx.store.transition(entry.id, "merged", {
      specBranch: null, specSha: null, specBasedOn: null,
    });
    ctx.onMerged(entry.prNumber);
    await cleanupSpecBranch(ctx, entry);
    // Don't invalidate downstream — their spec branches already include
    // this entry's changes. Speculative consistency: if the head's spec
    // passed and the downstream spec also passed, the downstream result
    // is still valid. The next tick will promote the new head.
    return;
  }

  if (!prStatus.reviewApproved) {
    await evictEntry(ctx, entry, "policy_blocked");
    await invalidateDownstream(ctx, allActive, 0);
    return;
  }

  if (prStatus.headSha !== entry.headSha) {
    ctx.store.updateHead(entry.id, prStatus.headSha);
    await invalidateDownstream(ctx, allActive, 0);
    return;
  }

  try {
    await ctx.github.mergePR(entry.prNumber, ctx.mergeMethod);
  } catch {
    if (entry.retryAttempts >= entry.maxRetries) {
      await evictEntry(ctx, entry, "integration_conflict");
      await invalidateDownstream(ctx, allActive, 0);
    } else {
      ctx.store.transition(entry.id, "preparing_head", {
        retryAttempts: entry.retryAttempts + 1,
        ciRunId: null,
        ciRetries: 0,
        specBranch: null,
        specSha: null,
        specBasedOn: null,
      });
      await invalidateDownstream(ctx, allActive, 0);
    }
    return;
  }

  ctx.store.transition(entry.id, "merged", {
    specBranch: null, specSha: null, specBasedOn: null,
  });
  ctx.onMerged(entry.prNumber);
  await cleanupSpecBranch(ctx, entry);

  // Speculative consistency: downstream entries that were already
  // validated include this entry's changes. They don't need re-testing.
  // The next tick will promote the new head, which can go straight to
  // merging if its CI already passed.
}

// ─── Helpers ────────────────────────────────────────────────────

/**
 * Invalidate all entries after the given index. Their speculative
 * branches are stale (base changed). Reset to preparing_head.
 */
async function invalidateDownstream(
  ctx: ReconcileContext,
  allActive: QueueEntry[],
  afterIndex: number,
): Promise<void> {
  for (let i = afterIndex + 1; i < allActive.length; i++) {
    const downstream = allActive[i]!;
    if (TERMINAL_STATUSES.includes(downstream.status)) continue;
    await cleanupSpecBranch(ctx, downstream);
    ctx.store.transition(downstream.id, "preparing_head", {
      ciRunId: null,
      ciRetries: 0,
      specBranch: null,
      specSha: null,
      specBasedOn: null,
    });
  }
}

async function cleanupSpecBranch(ctx: ReconcileContext, entry: QueueEntry): Promise<void> {
  if (entry.specBranch && ctx.specBuilder) {
    await ctx.specBuilder.deleteSpeculative(entry.specBranch).catch(() => {});
  }
}

async function evictEntry(
  ctx: ReconcileContext,
  entry: QueueEntry,
  failureClass: FailureClass,
  extra?: { conflictFiles?: string[]; failedChecks?: Array<{ name: string; conclusion: string }> },
): Promise<void> {
  await cleanupSpecBranch(ctx, entry);

  const context: EvictionContext = {
    version: 1,
    failureClass,
    baseSha: entry.baseSha,
    prHeadSha: entry.headSha,
    queuePosition: entry.position,
    conflictFiles: extra?.conflictFiles,
    failedChecks: extra?.failedChecks,
    retryHistory: [],
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
  ctx.store.transition(entry.id, "evicted", {
    specBranch: null, specSha: null, specBasedOn: null,
  });
  await ctx.eviction.reportEviction(entry, incident);
  ctx.onEvicted(entry.prNumber, context);
}
