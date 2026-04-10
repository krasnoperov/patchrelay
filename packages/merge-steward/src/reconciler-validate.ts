import type { QueueEntry } from "./types.ts";
import type { ReconcileContext } from "./reconciler-core.ts";
import { CLEAN_CI, CLEAN_SPEC, emit, isBudgetExhausted, ref } from "./reconciler-core.ts";
import { classifyFailure } from "./classify.ts";
import { evictEntry, invalidateDownstream } from "./reconciler-evict.ts";

const FAILED_CONCLUSIONS = new Set<string>(["failure"]);

export async function checkValidation(ctx: ReconcileContext, entry: QueueEntry, allActive: QueueEntry[], index: number): Promise<void> {
  if (!entry.ciRunId) {
    const branch = entry.specBranch ?? entry.branch;
    const sha = entry.specSha ?? entry.headSha;
    const runId = await ctx.ci.triggerRun(branch, sha);
    emit(ctx, entry, "ci_triggered", { ciRunId: runId });
    ctx.store.transition(entry.id, "validating", { ciRunId: runId }, `CI triggered: ${runId.slice(0, 12)}`);
    return;
  }

  const status = await ctx.ci.getStatus(entry.ciRunId);

  switch (status) {
    case "pending":
      emit(ctx, entry, "ci_pending", { ciRunId: entry.ciRunId });
      break;

    case "pass":
      emit(ctx, entry, "ci_passed", { ciRunId: entry.ciRunId });
      if (index === 0) {
        ctx.store.transition(entry.id, "merging", undefined, "CI passed, ready to merge");
      }
      break;

    case "fail": {
      emit(ctx, entry, "ci_failed", { ciRunId: entry.ciRunId });
      if (entry.ciRetries < ctx.flakyRetries) {
        emit(ctx, entry, "ci_flaky_retry", { detail: `retry ${entry.ciRetries + 1}/${ctx.flakyRetries}` });
        const branch = entry.specBranch ?? entry.branch;
        const sha = entry.specSha ?? entry.headSha;
        const runId = await ctx.ci.triggerRun(branch, sha);
        ctx.store.transition(entry.id, "validating", {
          ciRunId: runId,
          ciRetries: entry.ciRetries + 1,
        }, `flaky retry ${entry.ciRetries + 1}/${ctx.flakyRetries}`);
      } else if (isBudgetExhausted(entry)) {
        emit(ctx, entry, "budget_exhausted");
        const branchChecks = await ctx.github.listChecks(entry.prNumber);
        const mainChecks = await ctx.github.listChecksForRef(ref(ctx, ctx.baseBranch));
        const failedChecks = branchChecks
          .filter((c) => FAILED_CONCLUSIONS.has(c.conclusion))
          .map((c) => ({ name: c.name, conclusion: c.conclusion, ...(c.url ? { url: c.url } : {}) }));
        await evictEntry(ctx, entry, classifyFailure(branchChecks, mainChecks), { failedChecks });
        await invalidateDownstream(ctx, allActive, index);
      } else {
        ctx.store.transition(entry.id, "preparing_head", {
          retryAttempts: entry.retryAttempts + 1,
          ...CLEAN_CI,
          ...CLEAN_SPEC,
        }, `CI failed, retry ${entry.retryAttempts + 1}/${entry.maxRetries}`);
        await invalidateDownstream(ctx, allActive, index);
      }
      break;
    }
  }
}

