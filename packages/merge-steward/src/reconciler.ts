import type { GitOperations, CIRunner, GitHubPRApi, EvictionReporter, SpeculativeBranchBuilder } from "./interfaces.ts";
import type { QueueStore } from "./store.ts";
import type { QueueEntry, EvictionContext, FailureClass, MergeResult, ReconcileEvent, ReconcileAction } from "./types.ts";
import { TERMINAL_STATUSES } from "./types.ts";
import { classifyFailure } from "./classify.ts";
import { randomUUID } from "node:crypto";

// ─── Constants ──────────────────────────────────────────────────

const SPEC_BRANCH_PREFIX = "mq-spec-";
const FAILED_CONCLUSIONS = new Set<string>(["failure"]);
const CLEAN_SPEC = { specBranch: null, specSha: null, specBasedOn: null } as const;
const CLEAN_CI = { ciRunId: null, ciRetries: 0 } as const;

// ─── Context ────────────────────────────────────────────────────

export interface ReconcileContext {
  store: QueueStore;
  repoId: string;
  baseBranch: string;
  remotePrefix: string;
  git: GitOperations;
  ci: CIRunner;
  github: GitHubPRApi;
  eviction: EvictionReporter;
  specBuilder: SpeculativeBranchBuilder;
  speculativeDepth: number;
  flakyRetries: number;
  onEvent: (event: ReconcileEvent) => void;
}

// ─── Helpers ────────────────────────────────────────────────────

function emit(ctx: ReconcileContext, entry: QueueEntry, action: ReconcileAction, extra?: Partial<ReconcileEvent>): void {
  ctx.onEvent({ at: new Date().toISOString(), entryId: entry.id, prNumber: entry.prNumber, action, ...extra });
}

function ref(ctx: ReconcileContext, name: string): string {
  return ctx.remotePrefix + name;
}

function specBranchName(entryId: string): string {
  return `${SPEC_BRANCH_PREFIX}${entryId}`;
}

function isBudgetExhausted(entry: QueueEntry): boolean {
  return entry.retryAttempts >= entry.maxRetries;
}

function isRetryGated(entry: QueueEntry, currentBaseSha: string): boolean {
  return entry.lastFailedBaseSha === currentBaseSha;
}

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

// ─── Truth guard ────────────────────────────────────────────────

async function sanitizeEntry(ctx: ReconcileContext, entry: QueueEntry): Promise<boolean> {
  const canonical = ctx.store.getEntryByPR(ctx.repoId, entry.prNumber);
  if (canonical && canonical.id !== entry.id) {
    emit(ctx, entry, "sanitized_duplicate", {
      detail: `superseded by entry ${canonical.id}`,
    });
    await cleanupSpec(ctx, entry);
    ctx.store.dequeue(entry.id);
    return true;
  }

  try {
    const prStatus = await ctx.github.getStatus(entry.prNumber);
    if (prStatus.merged) {
      emit(ctx, entry, "merge_external", {
        detail: `PR #${entry.prNumber} already merged on GitHub (detected in sanitize)`,
      });
      await cleanupSpec(ctx, entry);
      ctx.store.transition(entry.id, "merged", CLEAN_SPEC, "merged externally (sanitize)");
      return true;
    }
    if (!prStatus.mergeable && !prStatus.merged) {
      emit(ctx, entry, "sanitized_closed", {
        detail: `PR #${entry.prNumber} is closed on GitHub`,
      });
      await cleanupSpec(ctx, entry);
      ctx.store.dequeue(entry.id);
      return true;
    }
  } catch {
    // GitHub probe failed — don't block the tick.
  }

  return false;
}

// ─── Entry preparation (unified for head and non-head) ──────────

async function prepareEntry(
  ctx: ReconcileContext,
  entry: QueueEntry,
  isHead: boolean,
  prevEntry: QueueEntry | null,
): Promise<void> {
  emit(ctx, entry, "fetch_started");
  await ctx.git.fetch();

  // Determine base: head merges onto main, non-head onto prev entry's spec.
  const base = isHead ? ref(ctx, ctx.baseBranch) : prevEntry?.specBranch ?? null;
  if (!base) return; // Non-head: prev hasn't built its spec yet, wait.

  const baseSha = await ctx.git.headSha(base);

  // ── Branch mismatch gate (all entries) ─────────────────────────
  // Detect external pushes to the PR branch. If webhooks missed
  // a force-push, catch it here before building a spec from stale content.
  const currentRef = await ctx.git.headSha(ref(ctx, entry.branch));
  if (currentRef !== entry.headSha) {
    emit(ctx, entry, "branch_mismatch", { detail: `expected ${entry.headSha.slice(0, 8)}, got ${currentRef.slice(0, 8)}` });
    ctx.store.updateHead(entry.id, currentRef);
    return;
  }

  // ── Head-only gates ───────────────────────────────────────────
  if (isHead) {
    // Gate: main CI must be green.
    if (ctx.ci.getMainStatus) {
      const mainStatus = await ctx.ci.getMainStatus(ctx.baseBranch);
      if (mainStatus === "fail") {
        let mainChecks: Array<{ name: string; conclusion: "success" | "failure" | "pending"; url?: string | undefined }> = [];
        try {
          mainChecks = await ctx.github.listChecksForRef(ref(ctx, ctx.baseBranch));
        } catch {
          mainChecks = [];
        }
        const failingChecks = mainChecks.filter((check) => check.conclusion === "failure");
        const pendingChecks = mainChecks.filter((check) => check.conclusion === "pending");
        emit(ctx, entry, "main_broken", {
          baseSha,
          failingChecks,
          pendingChecks,
          detail: describeMainBroken(failingChecks, pendingChecks),
        });
        return;
      }
    }

    // Gate: budget exhausted after previous conflict.
    if (isBudgetExhausted(entry) && entry.lastFailedBaseSha !== null) {
      emit(ctx, entry, "budget_exhausted", { baseSha });
      await evictEntry(ctx, entry, "integration_conflict");
      return;
    }

    // Gate: non-spinning — skip if base hasn't changed since last conflict.
    if (isRetryGated(entry, baseSha)) {
      emit(ctx, entry, "retry_gated", { baseSha, detail: "base unchanged since last conflict" });
      try {
        const prStatus = await ctx.github.getStatus(entry.prNumber);
        if (prStatus.mergeStateStatus === "DIRTY") {
          emit(ctx, entry, "budget_exhausted", {
            baseSha,
            detail: "retry gated and GitHub still reports merge conflict",
          });
          await evictEntry(ctx, entry, "integration_conflict");
        }
      } catch {
        // Best-effort check.
      }
      return;
    }
  }

  // ── Build spec branch: merge PR into base ─────────────────────

  const specName = specBranchName(entry.id);
  emit(ctx, entry, "spec_build_started", { specBranch: specName, baseSha, ...(prevEntry ? { dependsOn: prevEntry.id } : {}) });

  let result: MergeResult;
  try {
    result = await ctx.specBuilder.buildSpeculative(entry.branch, base, specName);
  } catch (err) {
    if (isHead) {
      // Branch gone or unreachable.
      const detail = `git error during spec build: ${err instanceof Error ? err.message : String(err)}`;
      emit(ctx, entry, "branch_unreachable", { baseSha, detail });
      await evictEntry(ctx, entry, "branch_local");
    } else {
      // Stale spec from prev entry — reset both.
      emit(ctx, entry, "invalidated", { detail: "stale spec branch, rebuilding" });
      ctx.store.transition(prevEntry!.id, "preparing_head", { ...CLEAN_CI, ...CLEAN_SPEC }, "spec branch missing, rebuilding");
      ctx.store.transition(entry.id, "preparing_head", { ...CLEAN_CI, ...CLEAN_SPEC }, "stale dependency, rebuilding");
    }
    return;
  }

  if (!result.success) {
    emit(ctx, entry, "spec_build_conflict", { baseSha, conflictFiles: result.conflictFiles });
    if (isBudgetExhausted(entry)) {
      emit(ctx, entry, "budget_exhausted");
      await evictEntry(ctx, entry, "integration_conflict",
        result.conflictFiles ? { conflictFiles: result.conflictFiles } : undefined);
    } else {
      ctx.store.transition(entry.id, "preparing_head", {
        retryAttempts: entry.retryAttempts + 1,
        lastFailedBaseSha: baseSha,
        ...CLEAN_CI, ...CLEAN_SPEC,
      }, `conflict on ${baseSha.slice(0, 8)}, retry ${entry.retryAttempts + 1}/${entry.maxRetries}`);
    }
    return;
  }

  const specSha = result.sha ?? entry.headSha;
  emit(ctx, entry, "spec_build_succeeded", { specBranch: specName, ...(prevEntry ? { dependsOn: prevEntry.id } : {}) });

  // Trigger CI on the spec branch.
  const runId = await ctx.ci.triggerRun(specName, specSha);
  emit(ctx, entry, "ci_triggered", { ciRunId: runId, specBranch: specName });
  ctx.store.transition(entry.id, "validating", {
    baseSha, ciRunId: runId, lastFailedBaseSha: null,
    specBranch: specName, specSha, specBasedOn: isHead ? null : prevEntry!.id,
  }, `spec ${specName} ready, CI ${runId}`);
}

function describeMainBroken(failingChecks: Array<{ name: string }>, pendingChecks: Array<{ name: string }>): string {
  const parts: string[] = [];
  if (failingChecks.length > 0) {
    parts.push(`failing ${summarizeCheckNames(failingChecks)}`);
  }
  if (pendingChecks.length > 0) {
    parts.push(`pending ${summarizeCheckNames(pendingChecks)}`);
  }
  return parts.length > 0 ? `main checks unhealthy: ${parts.join("; ")}` : "main checks unhealthy";
}

function summarizeCheckNames(checks: Array<{ name: string }>, limit = 3): string {
  const names = [...new Set(checks.map((check) => check.name))];
  if (names.length <= limit) {
    return names.join(", ");
  }
  return `${names.slice(0, limit).join(", ")} +${names.length - limit} more`;
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
      // Non-head: stay in validating (speculative consistency).
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
          retryAttempts: entry.retryAttempts + 1, ...CLEAN_CI, ...CLEAN_SPEC,
        }, `CI failed, retry ${entry.retryAttempts + 1}/${entry.maxRetries}`);
        await invalidateDownstream(ctx, allActive, index);
      }
      break;
    }
  }
}

// ─── Merge: push spec branch to main (head only) ───────────────

async function mergeHead(ctx: ReconcileContext, entry: QueueEntry): Promise<void> {
  emit(ctx, entry, "merge_revalidating");
  const prStatus = await ctx.github.getStatus(entry.prNumber);

  if (prStatus.merged) {
    emit(ctx, entry, "merge_external");
    ctx.store.transition(entry.id, "merged", CLEAN_SPEC, "merged externally");
    await cleanupSpec(ctx, entry);
    return;
  }

  if (!prStatus.reviewApproved) {
    // Don't evict immediately — reviewer may re-approve after re-review.
    // Stay in merging and re-check on the next tick. Operator can dequeue
    // manually if the approval never comes back.
    emit(ctx, entry, "merge_waiting_approval", { detail: "approval withdrawn, waiting for re-approval" });
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

  // Guard: verify our spec is a fast-forward from current main.
  // If someone pushed directly to main outside the queue, this catches it.
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

  // Push the spec branch to main (fast-forward).
  try {
    await ctx.git.push(entry.specBranch, false, ctx.baseBranch);
  } catch {
    emit(ctx, entry, "merge_rejected", { detail: "push to main failed" });
    const allActive = ctx.store.listActive(ctx.repoId);
    if (isBudgetExhausted(entry)) {
      emit(ctx, entry, "budget_exhausted");
      await evictEntry(ctx, entry, "integration_conflict");
    } else {
      ctx.store.transition(entry.id, "preparing_head", {
        retryAttempts: entry.retryAttempts + 1, ...CLEAN_CI, ...CLEAN_SPEC,
      }, `push failed, retry ${entry.retryAttempts + 1}/${entry.maxRetries}`);
    }
    // Head is rebuilding — downstream specs are stale (they were built
    // on the old head spec which will change after re-preparation).
    await invalidateDownstream(ctx, allActive, 0);
    return;
  }

  emit(ctx, entry, "merge_succeeded");
  ctx.store.transition(entry.id, "merged", CLEAN_SPEC, "spec pushed to main");
  await cleanupSpec(ctx, entry);

  // Best-effort: delete the PR branch from remote.
  try { await ctx.github.deleteBranch(entry.prNumber); } catch { /* cosmetic */ }
}

// ─── Invalidation + eviction ────────────────────────────────────

async function invalidateDownstream(ctx: ReconcileContext, allActive: QueueEntry[], afterIndex: number): Promise<void> {
  for (let i = afterIndex + 1; i < allActive.length; i++) {
    const downstream = allActive[i]!;
    if (TERMINAL_STATUSES.includes(downstream.status)) continue;
    emit(ctx, downstream, "invalidated", { detail: `base changed after position ${afterIndex}` });
    await cleanupSpec(ctx, downstream);
    ctx.store.transition(downstream.id, "preparing_head", { ...CLEAN_CI, ...CLEAN_SPEC }, "invalidated: base changed");
  }
}

async function cleanupSpec(ctx: ReconcileContext, entry: QueueEntry): Promise<void> {
  if (entry.specBranch) {
    await ctx.specBuilder.deleteSpeculative(entry.specBranch).catch(() => {
      // Best-effort cleanup — branch may not exist.
    });
  }
}

async function evictEntry(
  ctx: ReconcileContext,
  entry: QueueEntry,
  failureClass: FailureClass,
  extra?: { conflictFiles?: string[]; failedChecks?: Array<{ name: string; conclusion: string; url?: string }> },
): Promise<void> {
  await cleanupSpec(ctx, entry);

  let baseSha = entry.baseSha;
  if (!baseSha) {
    try { baseSha = await ctx.git.headSha(ref(ctx, ctx.baseBranch)); } catch { baseSha = "unknown"; }
  }

  const events = ctx.store.listEvents(entry.id);
  const retryHistory: EvictionContext["retryHistory"] = [];
  for (const event of events) {
    const eventBaseSha = event.baseSha || "unknown";
    if (event.fromStatus === "preparing_head" && event.toStatus === "validating") {
      retryHistory.push({ at: event.at, baseSha: eventBaseSha, outcome: "passed_to_validation" });
    } else if (event.fromStatus === "validating" && event.toStatus === "preparing_head") {
      retryHistory.push({ at: event.at, baseSha: eventBaseSha, outcome: "ci_failed_retry" });
    } else if (event.fromStatus === "preparing_head" && event.toStatus === "preparing_head") {
      retryHistory.push({ at: event.at, baseSha: eventBaseSha, outcome: "conflict_retry" });
    }
  }

  const context: EvictionContext = {
    version: 1, failureClass, baseSha, prHeadSha: entry.headSha,
    queuePosition: entry.position, conflictFiles: extra?.conflictFiles,
    failedChecks: extra?.failedChecks,
    baseBranch: ctx.baseBranch,
    branch: entry.branch,
    issueKey: entry.issueKey,
    retryHistory,
  };

  const incident = {
    id: randomUUID(), entryId: entry.id, at: new Date().toISOString(),
    failureClass, context, outcome: "open" as const,
  };

  ctx.store.insertIncident(incident);
  emit(ctx, entry, "evicted", { failureClass });
  ctx.store.transition(entry.id, "evicted", CLEAN_SPEC, `evicted: ${failureClass}`);
  await ctx.eviction.reportEviction(entry, incident);
}
