import type { QueueEntry } from "./types.ts";
import type { ReconcileContext } from "./reconciler-core.ts";
import { CLEAN_CI, CLEAN_SPEC, emit, isBudgetExhausted, ref } from "./reconciler-core.ts";
import { cleanupSpec, evictEntry, invalidateDownstream } from "./reconciler-evict.ts";
import { verifyPostMergeStatus } from "./reconciler-post-merge.ts";

export async function mergeHead(ctx: ReconcileContext, entry: QueueEntry): Promise<void> {
  emit(ctx, entry, "merge_revalidating");
  const prStatus = await ctx.github.getStatus(entry.prNumber);

  if (prStatus.merged) {
    emit(ctx, entry, "merge_external");
    ctx.store.transition(entry.id, "merged", CLEAN_SPEC, "merged externally");
    await cleanupSpec(ctx, entry);
    return;
  }

  if (!prStatus.reviewApproved) {
    const detail = prStatus.reviewDecision === "CHANGES_REQUESTED"
      ? "blocking review present, waiting for approval"
      : prStatus.reviewDecision === "REVIEW_REQUIRED"
        ? "required approval missing"
        : `review gate not satisfied (${prStatus.reviewDecision ?? "unknown"})`;
    emit(ctx, entry, "merge_waiting_approval", { detail });
    ctx.store.transition(entry.id, "merging", { waitDetail: detail }, detail);
    return;
  }

  if (prStatus.headSha !== entry.headSha) {
    emit(ctx, entry, "branch_mismatch", { detail: `PR head: expected ${entry.headSha.slice(0, 8)}, got ${prStatus.headSha.slice(0, 8)}` });
    const allActive = ctx.store.listActive(ctx.repoId);
    ctx.store.updateHead(entry.id, prStatus.headSha);
    await invalidateDownstream(ctx, allActive, 0);
    return;
  }

  if (!entry.specBranch || !entry.specSha) {
    ctx.store.transition(entry.id, "preparing_head", { ...CLEAN_CI, ...CLEAN_SPEC }, "no spec branch, re-prepare");
    return;
  }

  try {
    await ctx.git.fetch();
    const currentBase = await ctx.git.headSha(ref(ctx, ctx.baseBranch));
    const isFF = await ctx.git.isAncestor(currentBase, entry.specSha);
    if (!isFF) {
      emit(ctx, entry, "branch_mismatch", { detail: `spec is not a fast-forward from main (${currentBase.slice(0, 8)})` });
      const allActive = ctx.store.listActive(ctx.repoId);
      ctx.store.transition(entry.id, "preparing_head", { ...CLEAN_CI, ...CLEAN_SPEC }, "main diverged, re-prepare");
      await invalidateDownstream(ctx, allActive, 0);
      return;
    }
  } catch {
    // Can't verify — proceed and let push fail if needed.
  }

  if (ctx.ci.getMainStatus && entry.priority <= 0) {
    const mainStatus = await ctx.ci.getMainStatus(ctx.baseBranch);
    if (mainStatus === "pending") {
      // Main is still verifying itself (typically post-merge CI from the
      // previous entry).  The spec was built on top of main-as-it-was
      // (isFF check above guarantees main hasn't diverged) and already
      // passed CI, so keep the spec + CI state and retry next tick.
      // Throwing the spec away here would force a rebuild + re-run of
      // CI that produces the same tree — wasting the speculation.
      emit(ctx, entry, "merge_waiting_main", { detail: "main checks still pending, holding merge" });
      ctx.store.transition(entry.id, "merging", { waitDetail: "main checks still pending, holding merge" }, "main checks still pending, holding merge");
      return;
    }
    if (mainStatus === "fail") {
      try {
        const refresh = await ctx.policy.refreshOnIssue("main_unhealthy_at_merge");
        if (refresh.attempted && refresh.changed) {
          emit(ctx, entry, "policy_changed", {
            detail: `GitHub required checks changed from [${refresh.previousRequiredChecks.join(", ") || "(none)"}] to [${refresh.requiredChecks.join(", ") || "(none)"}]`,
          });
        }
      } catch {
        // Keep using cached GitHub policy and pause the queue conservatively.
      }
      emit(ctx, entry, "main_broken", { detail: "main unhealthy at merge time, re-preparing" });
      ctx.store.transition(entry.id, "preparing_head", { ...CLEAN_CI, ...CLEAN_SPEC }, "main unhealthy at merge time");
      return;
    }
  }

  try {
    await ctx.git.push(entry.specBranch, false, ctx.baseBranch);
  } catch {
    try {
      const refresh = await ctx.policy.refreshOnIssue("merge_push_rejected");
      if (refresh.attempted && refresh.changed) {
        emit(ctx, entry, "policy_changed", {
          detail: `GitHub required checks changed from [${refresh.previousRequiredChecks.join(", ") || "(none)"}] to [${refresh.requiredChecks.join(", ") || "(none)"}]`,
        });
        ctx.store.transition(entry.id, "preparing_head", { ...CLEAN_CI, ...CLEAN_SPEC }, "GitHub protection changed, re-preparing");
        const allActive = ctx.store.listActive(ctx.repoId);
        await invalidateDownstream(ctx, allActive, 0);
        return;
      }
    } catch {
      // Fall through to the normal push failure handling when policy refresh is unavailable.
    }
    emit(ctx, entry, "merge_rejected", { detail: "push to main failed" });
    const allActive = ctx.store.listActive(ctx.repoId);
    if (isBudgetExhausted(entry)) {
      emit(ctx, entry, "budget_exhausted");
      await evictEntry(ctx, entry, "integration_conflict");
    } else {
      ctx.store.transition(entry.id, "preparing_head", {
        retryAttempts: entry.retryAttempts + 1,
        ...CLEAN_CI,
        ...CLEAN_SPEC,
      }, `push failed, retry ${entry.retryAttempts + 1}/${entry.maxRetries}`);
    }
    await invalidateDownstream(ctx, allActive, 0);
    return;
  }

  emit(ctx, entry, "merge_succeeded");
  const verificationResult = await verifyPostMergeStatus(ctx, {
    ...entry,
    postMergeSha: entry.specSha ?? entry.headSha,
  });
  ctx.store.transition(entry.id, "merged", {
    ...CLEAN_SPEC,
    postMergeStatus: verificationResult.postMergeStatus,
    postMergeSha: verificationResult.postMergeSha,
    postMergeSummary: verificationResult.postMergeSummary,
    postMergeCheckedAt: new Date().toISOString(),
  }, `spec pushed to main; ${verificationResult.postMergeSummary}`);

  await cleanupSpec(ctx, entry);

  try {
    await ctx.github.deleteBranch(entry.prNumber);
  } catch {
    /* cosmetic */
  }
}
