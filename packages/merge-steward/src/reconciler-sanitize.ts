import type { QueueEntry } from "./types.ts";
import type { ReconcileContext } from "./reconciler-core.ts";
import { CLEAN_CANDIDATE_REF, emit } from "./reconciler-core.ts";
import { cleanupCandidate } from "./reconciler-evict.ts";
import { verifyPostMergeStatus } from "./reconciler-post-merge.ts";

export async function sanitizeEntry(ctx: ReconcileContext, entry: QueueEntry): Promise<boolean> {
  const canonical = ctx.store.getEntryByPR(ctx.repoId, entry.prNumber);
  if (canonical && canonical.id !== entry.id) {
    emit(ctx, entry, "sanitized_duplicate", {
      detail: `superseded by entry ${canonical.id}`,
    });
    await cleanupCandidate(ctx, entry);
    ctx.store.dequeue(entry.id);
    return true;
  }

  try {
    const prStatus = await ctx.github.getStatus(entry.prNumber);
    if (prStatus.merged) {
      const verification = await verifyPostMergeStatus(ctx, {
        ...entry,
        postMergeSha: entry.headSha,
      });
      emit(ctx, entry, "merge_external", {
        detail: `PR #${entry.prNumber} already merged on GitHub (detected in sanitize)`,
      });
      await cleanupCandidate(ctx, entry);
      ctx.store.transition(entry.id, "merged", {
        ...CLEAN_CANDIDATE_REF,
        postMergeStatus: verification.postMergeStatus,
        postMergeSha: verification.postMergeSha,
        postMergeSummary: verification.postMergeSummary,
        postMergeCheckedAt: new Date().toISOString(),
      }, "merged externally (sanitize)");
      return true;
    }
    const liveBaseRefName = prStatus.baseRefName ?? ctx.baseBranch;
    const recordedBaseRefName = entry.baseRefName ?? ctx.baseBranch;
    if (liveBaseRefName !== recordedBaseRefName) {
      emit(ctx, entry, "invalidated", {
        detail: `PR base changed from ${recordedBaseRefName} to ${liveBaseRefName}`,
      });
      await cleanupCandidate(ctx, entry);
      ctx.store.updateBaseRef(
        entry.id,
        liveBaseRefName,
        `PR base changed from ${recordedBaseRefName} to ${liveBaseRefName}`,
      );
      return true;
    }
    if (!prStatus.mergeable && !prStatus.merged) {
      emit(ctx, entry, "sanitized_closed", {
        detail: `PR #${entry.prNumber} is closed on GitHub`,
      });
      await cleanupCandidate(ctx, entry);
      ctx.store.dequeue(entry.id);
      return true;
    }
  } catch {
    // GitHub probe failed — don't block the tick.
  }

  return false;
}
