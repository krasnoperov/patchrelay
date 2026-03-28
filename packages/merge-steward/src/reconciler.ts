import type { GitOperations, CIRunner, GitHubPRApi, EvictionReporter, SpeculativeBranchBuilder } from "./interfaces.ts";
import type { QueueStore } from "./store.ts";
import type { QueueEntry, EvictionContext, FailureClass, ReconcileEvent, ReconcileAction } from "./types.ts";
import { TERMINAL_STATUSES } from "./types.ts";
import { classifyFailure } from "./classify.ts";
import { randomUUID } from "node:crypto";

export interface ReconcileContext {
  store: QueueStore;
  repoId: string;
  baseBranch: string;
  remotePrefix: string;
  git: GitOperations;
  ci: CIRunner;
  github: GitHubPRApi;
  eviction: EvictionReporter;
  specBuilder: SpeculativeBranchBuilder | null;
  speculativeDepth: number;
  flakyRetries: number;
  mergeMethod: "merge" | "squash";
  onEvent: (event: ReconcileEvent) => void;
}

function emit(ctx: ReconcileContext, entry: QueueEntry, action: ReconcileAction, extra?: Partial<ReconcileEvent>): void {
  ctx.onEvent({
    at: new Date().toISOString(),
    entryId: entry.id,
    prNumber: entry.prNumber,
    action,
    ...extra,
  });
}

/**
 * Reconciler with speculative execution and structured event stream.
 */
export async function reconcile(ctx: ReconcileContext): Promise<void> {
  const allActive = ctx.store.listActive(ctx.repoId);
  if (allActive.length === 0) return;

  const depth = ctx.specBuilder ? Math.min(ctx.speculativeDepth, allActive.length) : 1;

  for (let i = 0; i < depth; i++) {
    const entryId = allActive[i]!.id;
    const entry = ctx.store.getEntry(entryId);
    if (!entry || TERMINAL_STATUSES.includes(entry.status)) continue;
    const isHead = i === 0;
    const prevEntryId = i > 0 ? allActive[i - 1]!.id : null;
    const prevEntry = prevEntryId ? ctx.store.getEntry(prevEntryId) : null;

    switch (entry.status) {
      case "queued":
        emit(ctx, entry, "promoted");
        ctx.store.transition(entry.id, "preparing_head", undefined, "promoted to head");
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
        break;

      default:
        break;
    }
  }
}

// ─── Head entry: rebase onto main ───────────────────────────────

async function prepareHead(ctx: ReconcileContext, entry: QueueEntry): Promise<void> {
  const r = ctx.remotePrefix;

  emit(ctx, entry, "fetch_started");
  await ctx.git.fetch();

  if (ctx.ci.getMainStatus) {
    const mainStatus = await ctx.ci.getMainStatus(ctx.baseBranch);
    if (mainStatus === "fail") {
      emit(ctx, entry, "main_broken");
      return;
    }
  }

  const currentRef = await ctx.git.headSha(r + entry.branch);
  if (currentRef !== entry.headSha) {
    emit(ctx, entry, "branch_mismatch", { detail: `expected ${entry.headSha}, got ${currentRef}` });
    ctx.store.updateHead(entry.id, currentRef);
    return;
  }

  const currentBaseSha = await ctx.git.headSha(r + ctx.baseBranch);

  if (entry.retryAttempts >= entry.maxRetries && entry.lastFailedBaseSha !== null) {
    emit(ctx, entry, "budget_exhausted", { baseSha: currentBaseSha });
    await evictEntry(ctx, entry, "integration_conflict");
    return;
  }

  if (entry.lastFailedBaseSha === currentBaseSha) {
    emit(ctx, entry, "retry_gated", { baseSha: currentBaseSha, detail: "base unchanged since last conflict" });
    return;
  }

  emit(ctx, entry, "rebase_started", { baseSha: currentBaseSha });
  const result = await ctx.git.rebase(entry.branch, r + ctx.baseBranch);

  if (result.success) {
    const newHeadSha = result.newHeadSha ?? entry.headSha;
    await ctx.git.push(entry.branch, true);
    emit(ctx, entry, "rebase_succeeded", { baseSha: currentBaseSha });

    let specBranch: string | null = null;
    let specSha: string | null = null;
    if (ctx.specBuilder) {
      specBranch = `mq-spec-${entry.id}`;
      emit(ctx, entry, "spec_build_started", { specBranch, baseSha: currentBaseSha });
      const specResult = await ctx.specBuilder.buildSpeculative(entry.branch, r + ctx.baseBranch, specBranch);
      specSha = specResult.success ? (specResult.sha ?? newHeadSha) : null;
      if (specResult.success) {
        emit(ctx, entry, "spec_build_succeeded", { specBranch, baseSha: currentBaseSha });
      } else {
        emit(ctx, entry, "spec_build_conflict", { specBranch });
        specBranch = null;
      }
    }

    const runId = await ctx.ci.triggerRun(entry.branch, newHeadSha);
    emit(ctx, entry, "ci_triggered", { ciRunId: runId });
    ctx.store.transition(entry.id, "validating", {
      headSha: newHeadSha, baseSha: currentBaseSha, ciRunId: runId,
      lastFailedBaseSha: null, specBranch, specSha, specBasedOn: null,
    }, `rebase onto ${currentBaseSha.slice(0, 8)}, CI ${runId}`);
  } else {
    emit(ctx, entry, "rebase_conflict", { baseSha: currentBaseSha, conflictFiles: result.conflictFiles });
    if (entry.retryAttempts >= entry.maxRetries) {
      await evictEntry(ctx, entry, "integration_conflict",
        result.conflictFiles ? { conflictFiles: result.conflictFiles } : undefined);
    } else {
      ctx.store.transition(entry.id, "preparing_head", {
        retryAttempts: entry.retryAttempts + 1, lastFailedBaseSha: currentBaseSha,
      }, `conflict, retry ${entry.retryAttempts + 1}/${entry.maxRetries}`);
    }
  }
}

// ─── Non-head entry: speculative branch ─────────────────────────

async function prepareSpeculative(ctx: ReconcileContext, entry: QueueEntry, prevEntry: QueueEntry): Promise<void> {
  if (!ctx.specBuilder || !prevEntry.specBranch) return;

  const specName = `mq-spec-${entry.id}`;
  emit(ctx, entry, "spec_build_started", { specBranch: specName, dependsOn: prevEntry.id });
  const result = await ctx.specBuilder.buildSpeculative(entry.branch, prevEntry.specBranch, specName);

  if (result.success) {
    const specSha = result.sha ?? entry.headSha;
    emit(ctx, entry, "spec_build_succeeded", { specBranch: specName, dependsOn: prevEntry.id });
    const runId = await ctx.ci.triggerRun(specName, specSha);
    emit(ctx, entry, "ci_triggered", { ciRunId: runId, specBranch: specName });
    ctx.store.transition(entry.id, "validating", {
      ciRunId: runId, specBranch: specName, specSha, specBasedOn: prevEntry.id,
    }, `spec ${specName} based on ${prevEntry.id}, CI ${runId}`);
  } else {
    emit(ctx, entry, "spec_build_conflict", { specBranch: specName, dependsOn: prevEntry.id });
    if (entry.retryAttempts >= entry.maxRetries) {
      await evictEntry(ctx, entry, "integration_conflict");
    } else {
      ctx.store.transition(entry.id, "preparing_head", {
        retryAttempts: entry.retryAttempts + 1, lastFailedBaseSha: prevEntry.specSha,
      }, `spec conflict, retry ${entry.retryAttempts + 1}/${entry.maxRetries}`);
    }
  }
}

// ─── CI validation ──────────────────────────────────────────────

async function checkValidation(ctx: ReconcileContext, entry: QueueEntry, allActive: QueueEntry[], index: number): Promise<void> {
  if (!entry.ciRunId) {
    const branch = entry.specBranch ?? entry.branch;
    const sha = entry.specSha ?? entry.headSha;
    const runId = await ctx.ci.triggerRun(branch, sha);
    emit(ctx, entry, "ci_triggered", { ciRunId: runId });
    ctx.store.transition(entry.id, "validating", { ciRunId: runId }, `CI triggered: ${runId}`);
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
          ciRunId: runId, ciRetries: entry.ciRetries + 1,
        }, `flaky retry ${entry.ciRetries + 1}/${ctx.flakyRetries}`);
      } else if (entry.retryAttempts >= entry.maxRetries) {
        emit(ctx, entry, "budget_exhausted");
        const branchChecks = await ctx.github.listChecks(entry.prNumber);
        const failedChecks = branchChecks
          .filter((c) => c.conclusion === "failure" || c.conclusion === "timed_out" || c.conclusion === "cancelled")
          .map((c) => ({ name: c.name, conclusion: c.conclusion }));
        const failureClass = classifyFailure(branchChecks, []);
        await evictEntry(ctx, entry, failureClass, { failedChecks });
        await invalidateDownstream(ctx, allActive, index);
      } else {
        ctx.store.transition(entry.id, "preparing_head", {
          retryAttempts: entry.retryAttempts + 1, ciRunId: null, ciRetries: 0,
          specBranch: null, specSha: null, specBasedOn: null,
        }, `CI failed, retry ${entry.retryAttempts + 1}/${entry.maxRetries}`);
        await invalidateDownstream(ctx, allActive, index);
      }
      break;
    }
  }
}

// ─── Merge (head only) ──────────────────────────────────────────

async function mergeHead(ctx: ReconcileContext, entry: QueueEntry, allActive: QueueEntry[]): Promise<void> {
  emit(ctx, entry, "merge_revalidating");
  const prStatus = await ctx.github.getStatus(entry.prNumber);

  if (prStatus.merged) {
    emit(ctx, entry, "merge_external");
    ctx.store.transition(entry.id, "merged", { specBranch: null, specSha: null, specBasedOn: null }, "merged externally");
    await cleanupSpecBranch(ctx, entry);
    return;
  }

  if (!prStatus.reviewApproved) {
    emit(ctx, entry, "merge_rejected", { detail: "approval withdrawn" });
    await evictEntry(ctx, entry, "policy_blocked");
    await invalidateDownstream(ctx, allActive, 0);
    return;
  }

  if (prStatus.headSha !== entry.headSha) {
    emit(ctx, entry, "branch_mismatch", { detail: `expected ${entry.headSha}, got ${prStatus.headSha}` });
    ctx.store.updateHead(entry.id, prStatus.headSha);
    await invalidateDownstream(ctx, allActive, 0);
    return;
  }

  try {
    await ctx.github.mergePR(entry.prNumber, ctx.mergeMethod);
  } catch {
    emit(ctx, entry, "merge_rejected", { detail: "GitHub API rejected merge" });
    if (entry.retryAttempts >= entry.maxRetries) {
      await evictEntry(ctx, entry, "integration_conflict");
      await invalidateDownstream(ctx, allActive, 0);
    } else {
      ctx.store.transition(entry.id, "preparing_head", {
        retryAttempts: entry.retryAttempts + 1, ciRunId: null, ciRetries: 0,
        specBranch: null, specSha: null, specBasedOn: null,
      }, `merge rejected, retry ${entry.retryAttempts + 1}/${entry.maxRetries}`);
      await invalidateDownstream(ctx, allActive, 0);
    }
    return;
  }

  emit(ctx, entry, "merge_succeeded");
  ctx.store.transition(entry.id, "merged", { specBranch: null, specSha: null, specBasedOn: null }, "merged to main");
  await cleanupSpecBranch(ctx, entry);
}

// ─── Helpers ────────────────────────────────────────────────────

async function invalidateDownstream(ctx: ReconcileContext, allActive: QueueEntry[], afterIndex: number): Promise<void> {
  for (let i = afterIndex + 1; i < allActive.length; i++) {
    const downstream = allActive[i]!;
    if (TERMINAL_STATUSES.includes(downstream.status)) continue;
    emit(ctx, downstream, "invalidated", { detail: `base changed after entry at position ${afterIndex}` });
    await cleanupSpecBranch(ctx, downstream);
    ctx.store.transition(downstream.id, "preparing_head", {
      ciRunId: null, ciRetries: 0, specBranch: null, specSha: null, specBasedOn: null,
    }, "invalidated: base changed");
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
    version: 1, failureClass, baseSha: entry.baseSha, prHeadSha: entry.headSha,
    queuePosition: entry.position, conflictFiles: extra?.conflictFiles,
    failedChecks: extra?.failedChecks, retryHistory: [],
  };

  const incident = {
    id: randomUUID(), entryId: entry.id, at: new Date().toISOString(),
    failureClass, context, outcome: "open" as const,
  };

  ctx.store.insertIncident(incident);
  emit(ctx, entry, "evicted", { failureClass });
  ctx.store.transition(entry.id, "evicted", { specBranch: null, specSha: null, specBasedOn: null }, `evicted: ${failureClass}`);
  await ctx.eviction.reportEviction(entry, incident);
}
