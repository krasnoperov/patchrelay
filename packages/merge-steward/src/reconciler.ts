import type { QueueEntry } from "./types.ts";
import { TERMINAL_STATUSES } from "./types.ts";
import type { ReconcileContext } from "./reconciler-core.ts";
import { CLEAN_CI, CLEAN_SPEC, emit } from "./reconciler-core.ts";
import { sanitizeEntry } from "./reconciler-sanitize.ts";
import { prepareEntry } from "./reconciler-prepare.ts";
import { checkValidation } from "./reconciler-validate.ts";
import { mergeHead } from "./reconciler-merge.ts";
import { cleanupSpec } from "./reconciler-evict.ts";
import { INVALIDATION_PATCH } from "./invalidation.ts";

export type { ReconcileContext } from "./reconciler-core.ts";

// ─── Main reconcile loop ────────────────────────────────────────

export async function reconcile(ctx: ReconcileContext): Promise<void> {
  const allActive = ctx.store.listActive(ctx.repoId);
  if (allActive.length === 0) return;

  // Process up to speculativeDepth entries. GitHub truth checks are
  // bounded by this window — we never scan the full queue.
  const depth = Math.min(ctx.speculativeDepth, allActive.length);

  for (let i = 0; i < depth; i++) {
    const entryId = allActive[i]!.id;
    const entry = ctx.store.getEntry(entryId);
    if (!entry || TERMINAL_STATUSES.includes(entry.status)) continue;

    // Truth guard: verify entry against GitHub before processing.
    if (await sanitizeEntry(ctx, entry)) continue;

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
  }
}

// phase implementations live in dedicated modules now
