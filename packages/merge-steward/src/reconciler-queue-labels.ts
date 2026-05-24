import type { ReconcileContext } from "./reconciler-core.ts";
import { emit } from "./reconciler-core.ts";
import type { QueueEntry } from "./types.ts";

/**
 * Edge-triggered GitHub label sync for queue sub-state.
 *
 * The label is a pure function of the entry's phase, so a PR's live
 * position in the merge queue is obvious from GitHub — and readable by
 * patchrelay to drive its Linear "In Merge Queue" status:
 *
 *   validating → testing label  (spec CI is running / awaiting turn)
 *   merging    → merging label  (head of queue, merge in progress)
 *   everything else (queued, preparing_head, merged, evicted, …) → neither
 *
 * Idempotent: reads the PR's current labels and only edits the delta, so
 * it is safe to call every tick and after a restart. Cosmetic-only — any
 * GitHub error is swallowed so it can never break the reconcile loop.
 */
export async function syncQueueStateLabels(ctx: ReconcileContext, entry: QueueEntry): Promise<void> {
  const labels = ctx.queueStateLabels;
  if (!labels) return;

  const managed = [labels.testing, labels.merging];
  const desired =
    entry.status === "validating" ? labels.testing
    : entry.status === "merging" ? labels.merging
    : null;

  let current: string[];
  try {
    current = await ctx.github.listLabels(entry.prNumber);
  } catch {
    return;
  }

  const add = desired && !current.includes(desired) ? [desired] : [];
  const remove = managed.filter((l) => l !== desired && current.includes(l));
  if (add.length === 0 && remove.length === 0) return;

  try {
    await ctx.github.setLabels(entry.prNumber, { add, remove });
    const parts: string[] = [];
    if (add.length) parts.push(`+${add.join(",")}`);
    if (remove.length) parts.push(`-${remove.join(",")}`);
    emit(ctx, entry, "queue_label_synced", { detail: `${entry.status}: ${parts.join(" ")}` });
  } catch {
    // best-effort; the next tick retries
  }
}
