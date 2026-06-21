import { TERMINAL_STATUSES } from "./types.ts";
import type { ReconcileContext } from "./reconciler-core.ts";
import { emit } from "./reconciler-core.ts";
import { sanitizeEntry } from "./reconciler-sanitize.ts";
import { prepareEntry } from "./reconciler-prepare.ts";
import { checkValidation } from "./reconciler-validate.ts";
import { mergeHead } from "./reconciler-merge.ts";
import { cleanupSpec } from "./reconciler-evict.ts";
import { INVALIDATION_PATCH } from "./invalidation.ts";
import { verifyPostMergeStatus } from "./reconciler-post-merge.ts";
import { syncQueueStateLabels } from "./reconciler-queue-labels.ts";

export type { ReconcileContext } from "./reconciler-core.ts";

// ─── Main reconcile loop ────────────────────────────────────────

export async function reconcile(ctx: ReconcileContext): Promise<void> {
  const allActive = ctx.store.listActive(ctx.repoId);
  // Note: do NOT early-return when the active queue is empty. A drained queue
  // can still hold merged entries whose post-merge verification is unresolved
  // (e.g. an externally-merged PR), and verifyMergedEntriesPostPush below is
  // the only thing that advances them. depth=0 simply skips the active loop.

  // Process up to speculativeDepth entries. GitHub truth checks are
  // bounded by this window — we never scan the full queue.
  const depth = Math.min(ctx.speculativeDepth, allActive.length);

  for (let i = 0; i < depth; i++) {
    const entryId = allActive[i]!.id;
    const entry = ctx.store.getEntry(entryId);
    if (!entry || TERMINAL_STATUSES.includes(entry.status)) continue;

    // Truth guard: verify entry against GitHub before processing.
    if (await sanitizeEntry(ctx, entry)) {
      // Entry may have been terminalized (closed/duplicate) — clear any
      // stale queue sub-state label it still carries.
      const sanitized = ctx.store.getEntry(entry.id);
      if (sanitized) await syncQueueStateLabels(ctx, sanitized);
      continue;
    }

    // Stale dependency guard: if this entry's spec was built on top of
    // another entry that was dequeued or evicted (without downstream
    // invalidation), the spec is contaminated with the removed entry's
    // changes. Reset so it rebuilds on the correct base next tick.
    // Exclude "merged" — a merged dependency means main advanced to its
    // spec, so our cumulative spec is still valid (speculative consistency).
    if (entry.specBasedOn) {
      const dep = ctx.store.getEntry(entry.specBasedOn);
      if (!dep || dep.status === "dequeued" || dep.status === "evicted") {
        emit(ctx, entry, "invalidated", {
          detail: `dependency ${entry.specBasedOn} is ${dep?.status ?? "removed"}`,
        });
        await cleanupSpec(ctx, entry);
        ctx.store.transition(entry.id, "preparing_head",
          INVALIDATION_PATCH, `stale dependency ${dep?.status ?? "removed"}`);
        continue;
      }
    }

    const isHead = i === 0;
    const prevEntry = i > 0 ? ctx.store.getEntry(allActive[i - 1]!.id) ?? null : null;
    const phase = entry.status;

    try {
      switch (phase) {
        case "queued":
          emit(ctx, entry, "promoted");
          ctx.store.transition(entry.id, "preparing_head", undefined, "promoted");
          break;

        case "preparing_head":
          await prepareEntry(ctx, entry, isHead, prevEntry);
          break;

        case "validating": {
          const freshActive = ctx.store.listActive(ctx.repoId);
          const freshIdx = freshActive.findIndex((e) => e.id === entry.id);
          await checkValidation(ctx, entry, freshActive, freshIdx >= 0 ? freshIdx : i);
          break;
        }

        case "merging":
          if (isHead) {
            await mergeHead(ctx, entry);
          }
          break;

        default:
          break;
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      const wrapped = new Error(`[PR #${entry.prNumber} ${entry.id} phase=${phase}] ${msg}`);
      if (error instanceof Error && error.stack) wrapped.stack = error.stack;
      throw wrapped;
    }

    // Sync the GitHub queue sub-state label to the (possibly just
    // transitioned) phase: queue:testing while validating, queue:merging
    // while merging, cleared once merged/preparing/terminal.
    const post = ctx.store.getEntry(entry.id);
    if (post) await syncQueueStateLabels(ctx, post);
  }

  await verifyMergedEntriesPostPush(ctx);
}

async function verifyMergedEntriesPostPush(ctx: ReconcileContext): Promise<void> {
  // Targeted query (not listAll) so an idle repo with a large merged history
  // doesn't scan every terminal row each tick — only the unresolved ones.
  const mergedEntries = ctx.store.listPostMergePending(ctx.repoId);
  for (const entry of mergedEntries) {
    const postMergeSha = entry.postMergeSha ?? entry.specSha ?? entry.headSha;
    if (!postMergeSha) {
      continue;
    }

    emit(ctx, entry, "post_merge_verification_started", {
      detail: `post-merge check on ${postMergeSha.slice(0, 8)}`,
    });
    const verification = await verifyPostMergeStatus(ctx, entry);
    emit(ctx, entry, "post_merge_verification_completed", {
      detail: `post-merge checks ${verification.postMergeStatus}: ${verification.postMergeSummary}`,
    });

    const now = new Date().toISOString();
    const previousStatus = entry.postMergeStatus ?? "pending";
    if (
      previousStatus !== verification.postMergeStatus
      || entry.postMergeSummary !== verification.postMergeSummary
      || entry.postMergeCheckedAt === null
      || entry.postMergeCheckedAt === undefined
    ) {
      ctx.store.transition(entry.id, "merged", {
        postMergeStatus: verification.postMergeStatus,
        postMergeSha: verification.postMergeSha,
        postMergeSummary: verification.postMergeSummary,
        postMergeCheckedAt: now,
      }, `post-merge verification: ${verification.postMergeStatus}`);
    } else {
      ctx.store.transition(entry.id, "merged", {
        postMergeCheckedAt: now,
      }, "post-merge verification");
    }

    const post = ctx.store.getEntry(entry.id);
    if (post) await syncQueueStateLabels(ctx, post);
  }
}

// phase implementations live in dedicated modules now
