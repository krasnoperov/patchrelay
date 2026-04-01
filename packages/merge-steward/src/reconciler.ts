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
  specBuilder: SpeculativeBranchBuilder | null;
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

/** The branch and SHA to use for CI — spec branch if available, else PR branch. */
function ciTarget(entry: QueueEntry): { branch: string; sha: string } {
  return {
    branch: entry.specBranch ?? entry.branch,
    sha: entry.specSha ?? entry.headSha,
  };
}

// ─── Main reconcile loop ────────────────────────────────────────

export async function reconcile(ctx: ReconcileContext): Promise<void> {
  const allActive = ctx.store.listActive(ctx.repoId);
  if (allActive.length === 0) return;

  const depth = ctx.specBuilder ? Math.min(ctx.speculativeDepth, allActive.length) : 1;

  for (let i = 0; i < depth; i++) {
    const entryId = allActive[i]!.id;
    const entry = ctx.store.getEntry(entryId);
    if (!entry || TERMINAL_STATUSES.includes(entry.status)) continue;

    const isHead = i === 0;
    const prevEntry = i > 0 ? ctx.store.getEntry(allActive[i - 1]!.id) : null;

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
        const freshIdx = freshActive.findIndex((e) => e.id === entry.id);
        await checkValidation(ctx, entry, freshActive, freshIdx >= 0 ? freshIdx : i);
        break;
      }

      case "merging":
        if (isHead) {
          await mergeHead(ctx, entry, ctx.store.listActive(ctx.repoId));
        }
        break;

      default:
        break;
    }
  }
}

// ─── Head entry: fetch + gate + rebase ──────────────────────────

async function prepareHead(ctx: ReconcileContext, entry: QueueEntry): Promise<void> {
  emit(ctx, entry, "fetch_started");
  await ctx.git.fetch();

  const baseSha = await ctx.git.headSha(ref(ctx, ctx.baseBranch));

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

  // Gate: branch must match expected SHA (detect external pushes).
  const currentRef = await ctx.git.headSha(ref(ctx, entry.branch));
  if (currentRef !== entry.headSha) {
    emit(ctx, entry, "branch_mismatch", { detail: `expected ${entry.headSha.slice(0, 8)}, got ${currentRef.slice(0, 8)}` });
    ctx.store.updateHead(entry.id, currentRef);
    return;
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
    return;
  }

  await performRebase(ctx, entry, baseSha);
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

async function performRebase(ctx: ReconcileContext, entry: QueueEntry, baseSha: string): Promise<void> {
  emit(ctx, entry, "rebase_started", { baseSha });
  const result = await ctx.git.rebase(entry.branch, ref(ctx, ctx.baseBranch));

  if (!result.success) {
    emit(ctx, entry, "rebase_conflict", { baseSha, conflictFiles: result.conflictFiles });
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

  const headSha = result.newHeadSha ?? entry.headSha;
  await ctx.git.fetch();
  const latestRemoteHead = await ctx.git.headSha(ref(ctx, entry.branch));
  if (latestRemoteHead !== entry.headSha) {
    const candidateKeepsLatestRemote = await ctx.git.isAncestor(latestRemoteHead, headSha);
    if (!candidateKeepsLatestRemote) {
      emit(ctx, entry, "branch_mismatch", {
        detail:
          `remote advanced during rebase: expected ${entry.headSha.slice(0, 8)}, ` +
          `latest ${latestRemoteHead.slice(0, 8)}, candidate ${headSha.slice(0, 8)}`,
      });
      ctx.store.updateHead(entry.id, latestRemoteHead);
      return;
    }
  }
  await ctx.git.push(entry.branch, true);
  emit(ctx, entry, "rebase_succeeded", { baseSha });

  // Build speculative branch for downstream entries.
  let specBranch: string | null = null;
  let specSha: string | null = null;
  if (ctx.specBuilder) {
    specBranch = specBranchName(entry.id);
    emit(ctx, entry, "spec_build_started", { specBranch, baseSha });
    const specResult = await ctx.specBuilder.buildSpeculative(entry.branch, ref(ctx, ctx.baseBranch), specBranch);
    if (specResult.success) {
      specSha = specResult.sha ?? headSha;
      emit(ctx, entry, "spec_build_succeeded", { specBranch });
    } else {
      emit(ctx, entry, "spec_build_conflict", { specBranch });
      specBranch = null;
    }
  }

  const runId = await ctx.ci.triggerRun(entry.branch, headSha);
  emit(ctx, entry, "ci_triggered", { ciRunId: runId });
  ctx.store.transition(entry.id, "validating", {
    headSha, baseSha, ciRunId: runId, lastFailedBaseSha: null,
    specBranch, specSha, specBasedOn: null,
  }, `rebase onto ${baseSha.slice(0, 8)}, CI ${runId}`);
}

// ─── Non-head entry: speculative branch ─────────────────────────

async function prepareSpeculative(ctx: ReconcileContext, entry: QueueEntry, prevEntry: QueueEntry): Promise<void> {
  if (!ctx.specBuilder || !prevEntry.specBranch) return;

  const specName = specBranchName(entry.id);
  emit(ctx, entry, "spec_build_started", { specBranch: specName, dependsOn: prevEntry.id });

  let result: MergeResult;
  try {
    result = await ctx.specBuilder.buildSpeculative(entry.branch, prevEntry.specBranch, specName);
  } catch {
    // Stale spec branch — the previous entry's branch doesn't exist
    // (e.g., after restart with fresh clone). Reset both entries.
    emit(ctx, entry, "invalidated", { detail: "stale spec branch, rebuilding" });
    ctx.store.transition(prevEntry.id, "preparing_head", { ...CLEAN_CI, ...CLEAN_SPEC }, "spec branch missing, rebuilding");
    ctx.store.transition(entry.id, "preparing_head", { ...CLEAN_CI, ...CLEAN_SPEC }, "stale dependency, rebuilding");
    return;
  }
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
    if (!isBudgetExhausted(entry)) {
      ctx.store.transition(entry.id, "preparing_head", {
        retryAttempts: entry.retryAttempts + 1, lastFailedBaseSha: prevEntry.specSha,
      }, `spec conflict, retry ${entry.retryAttempts + 1}/${entry.maxRetries}`);
    } else {
      await evictEntry(ctx, entry, "integration_conflict");
    }
  }
}

// ─── CI validation ──────────────────────────────────────────────

async function checkValidation(ctx: ReconcileContext, entry: QueueEntry, allActive: QueueEntry[], index: number): Promise<void> {
  if (!entry.ciRunId) {
    const target = ciTarget(entry);
    const runId = await ctx.ci.triggerRun(target.branch, target.sha);
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
        const target = ciTarget(entry);
        const runId = await ctx.ci.triggerRun(target.branch, target.sha);
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

// ─── Merge (head only) ──────────────────────────────────────────

async function mergeHead(ctx: ReconcileContext, entry: QueueEntry, allActive: QueueEntry[]): Promise<void> {
  emit(ctx, entry, "merge_revalidating");
  const prStatus = await ctx.github.getStatus(entry.prNumber);

  if (prStatus.merged) {
    emit(ctx, entry, "merge_external");
    ctx.store.transition(entry.id, "merged", CLEAN_SPEC, "merged externally");
    await cleanupSpec(ctx, entry);
    return;
  }

  if (!prStatus.reviewApproved) {
    emit(ctx, entry, "merge_rejected", { detail: "approval withdrawn" });
    await evictEntry(ctx, entry, "policy_blocked");
    await invalidateDownstream(ctx, allActive, 0);
    return;
  }

  if (prStatus.headSha !== entry.headSha) {
    emit(ctx, entry, "branch_mismatch", { detail: `PR head: expected ${entry.headSha.slice(0, 8)}, got ${prStatus.headSha.slice(0, 8)}` });
    ctx.store.updateHead(entry.id, prStatus.headSha);
    await invalidateDownstream(ctx, allActive, 0);
    return;
  }

  // Check if base branch moved since validation — if so, re-prepare.
  if (entry.baseSha) {
    try {
      const currentBase = await ctx.git.headSha(ref(ctx, ctx.baseBranch));
      if (currentBase !== entry.baseSha) {
        emit(ctx, entry, "branch_mismatch", { detail: `base: expected ${entry.baseSha.slice(0, 8)}, got ${currentBase.slice(0, 8)}` });
        ctx.store.transition(entry.id, "preparing_head", { ...CLEAN_CI, ...CLEAN_SPEC }, "base moved, re-prepare");
        await invalidateDownstream(ctx, allActive, 0);
        return;
      }
    } catch {
      // Can't resolve base — proceed and let GitHub enforce.
    }
  }

  try {
    await ctx.github.mergePR(entry.prNumber);
  } catch {
    emit(ctx, entry, "merge_rejected", { detail: "GitHub API rejected merge" });
    if (isBudgetExhausted(entry)) {
      emit(ctx, entry, "budget_exhausted");
      await evictEntry(ctx, entry, "integration_conflict");
    } else {
      ctx.store.transition(entry.id, "preparing_head", {
        retryAttempts: entry.retryAttempts + 1, ...CLEAN_CI, ...CLEAN_SPEC,
      }, `merge rejected, retry ${entry.retryAttempts + 1}/${entry.maxRetries}`);
    }
    await invalidateDownstream(ctx, allActive, 0);
    return;
  }

  emit(ctx, entry, "merge_succeeded");
  ctx.store.transition(entry.id, "merged", CLEAN_SPEC, "merged to main");
  await cleanupSpec(ctx, entry);
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
  if (entry.specBranch && ctx.specBuilder) {
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

  // Use recorded baseSha if available, else resolve current base.
  let baseSha = entry.baseSha;
  if (!baseSha) {
    try { baseSha = await ctx.git.headSha(ref(ctx, ctx.baseBranch)); } catch { baseSha = "unknown"; }
  }

  // Build retry history from queue events (each event snapshots baseSha at transition time).
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
