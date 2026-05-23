import type { CheckResult, QueueEntry } from "./types.ts";
import type { ReconcileContext } from "./reconciler-core.ts";
import { CLEAN_CI, CLEAN_SPEC, emit, isBudgetExhausted, ref } from "./reconciler-core.ts";
import { cleanupSpec, evictEntry, invalidateDownstream } from "./reconciler-evict.ts";
import { verifyPostMergeStatus } from "./reconciler-post-merge.ts";

const DEFAULT_PR_MERGED_POLL_ATTEMPTS = 6;
const DEFAULT_PR_MERGED_POLL_DELAY_MS = 2_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type PushFailureKind =
  | "non_fast_forward"
  | "protected_branch"
  | "auth_or_permission"
  | "workflow_permission"
  | "timeout"
  | "github_push_rejected";

type ExecFailure = Error & {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  signal?: NodeJS.Signals | null;
  timedOut?: boolean;
};

function shortSha(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 8) : "unknown";
}

function sanitizeCommandOutput(value: string): string {
  return value
    .replace(/x-access-token:[^@\s]+@/g, "x-access-token:[redacted]@")
    .replace(/\bgh[psu]_[A-Za-z0-9_]+\b/g, "[redacted-token]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1200);
}

function describeError(error: unknown): string {
  if (!(error instanceof Error)) {
    return sanitizeCommandOutput(String(error));
  }
  const failure = error as ExecFailure;
  const parts = [
    failure.stderr,
    failure.stdout,
    error.message,
    typeof failure.exitCode === "number" ? `exit code ${failure.exitCode}` : undefined,
    failure.signal ? `signal ${failure.signal}` : undefined,
  ].filter((part): part is string => Boolean(part && part.trim()));
  return sanitizeCommandOutput(parts.join(" "));
}

function classifyPushFailure(error: unknown, detail: string): PushFailureKind {
  const failure = error instanceof Error ? error as ExecFailure : undefined;
  const lower = detail.toLowerCase();
  if (failure?.timedOut || lower.includes("timed out")) {
    return "timeout";
  }
  if (lower.includes("refusing to allow a github app to create or update workflow")) {
    return "workflow_permission";
  }
  if (
    lower.includes("non-fast-forward")
    || lower.includes("fetch first")
    || lower.includes("stale info")
    || lower.includes("cannot lock ref")
  ) {
    return "non_fast_forward";
  }
  if (
    lower.includes("protected branch")
    || lower.includes("gh006")
    || lower.includes("required status check")
    || lower.includes("required approving review")
    || lower.includes("changes must be made through a pull request")
  ) {
    return "protected_branch";
  }
  if (
    lower.includes("authentication failed")
    || lower.includes("permission denied")
    || lower.includes("write access")
    || lower.includes("403")
    || lower.includes("not authorized")
  ) {
    return "auth_or_permission";
  }
  return "github_push_rejected";
}

function normalizeCheckName(name: string): string {
  return name.trim().toLowerCase();
}

function getMissingRequiredChecks(requiredChecks: string[], checks: Array<{ name: string }>): string[] {
  if (requiredChecks.length === 0) {
    return [];
  }
  const available = new Set(checks.map((check) => normalizeCheckName(check.name)).filter(Boolean));
  return requiredChecks.filter((check) => !available.has(normalizeCheckName(check)));
}

function summarizeChecks(checks: CheckResult[], missingRequiredChecks: string[]): string {
  const visible = checks
    .filter((check) => check.name.trim())
    .map((check) => `${check.name}=${check.conclusion}`);
  const parts: string[] = [];
  if (visible.length > 0) {
    parts.push(`spec checks ${visible.slice(0, 5).join(", ")}`);
    if (visible.length > 5) {
      parts.push(`+${visible.length - 5} more`);
    }
  } else {
    parts.push("no spec checks visible");
  }
  if (missingRequiredChecks.length > 0) {
    parts.push(`missing required ${missingRequiredChecks.join(", ")}`);
  }
  return parts.join("; ");
}

async function inspectSpecChecks(ctx: ReconcileContext, specSha: string | null): Promise<{
  detail: string;
  failingChecks: CheckResult[];
  pendingChecks: CheckResult[];
  missingRequiredChecks: string[];
}> {
  if (!specSha) {
    return {
      detail: "spec checks unavailable: no spec SHA",
      failingChecks: [],
      pendingChecks: [],
      missingRequiredChecks: ctx.policy.getRequiredChecks(),
    };
  }

  try {
    const checks = await ctx.github.listChecksForRef(specSha);
    const failingChecks = checks.filter((check) => check.conclusion === "failure");
    const pendingChecks = checks.filter((check) => check.conclusion === "pending");
    const missingRequiredChecks = getMissingRequiredChecks(ctx.policy.getRequiredChecks(), checks);
    return {
      detail: summarizeChecks(checks, missingRequiredChecks),
      failingChecks,
      pendingChecks,
      missingRequiredChecks,
    };
  } catch (error) {
    return {
      detail: `spec checks unavailable: ${describeError(error)}`,
      failingChecks: [],
      pendingChecks: [],
      missingRequiredChecks: ctx.policy.getRequiredChecks(),
    };
  }
}

async function verifySpecStillFastForwards(
  ctx: ReconcileContext,
  specSha: string,
): Promise<{ currentBase: string | null; isFastForward: boolean | null; detail?: string }> {
  try {
    await ctx.git.fetch();
    const currentBase = await ctx.git.headSha(ref(ctx, ctx.baseBranch));
    const isFastForward = await ctx.git.isAncestor(currentBase, specSha);
    return { currentBase, isFastForward };
  } catch (error) {
    return {
      currentBase: null,
      isFastForward: null,
      detail: `fast-forward verification unavailable: ${describeError(error)}`,
    };
  }
}

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

  let currentBase: string | null = null;
  try {
    await ctx.git.fetch();
    currentBase = await ctx.git.headSha(ref(ctx, ctx.baseBranch));
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

  // The queue gates only on its own spec CI. main's CI status is irrelevant to
  // landing: the spec was built on current main (the fast-forward check above
  // guarantees main hasn't diverged) and its checks passed, so pushing it advances
  // main to a green SHA. We never wait for main's own CI to settle, and never pause
  // the queue because main is red — a red main is either flaky or fixed by landing
  // this green spec. main CI is information-only (out-of-band breakage canary).

  try {
    await ctx.git.push(entry.specBranch, false, ctx.baseBranch);
  } catch (error) {
    const pushErrorDetail = describeError(error);
    const pushFailureKind = classifyPushFailure(error, pushErrorDetail);
    const fastForward = entry.specSha
      ? await verifySpecStillFastForwards(ctx, entry.specSha)
      : { currentBase: null, isFastForward: null, detail: "fast-forward verification unavailable: no spec SHA" };

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

    const checkState = await inspectSpecChecks(ctx, entry.specSha);
    const detail = [
      `push to ${ctx.baseBranch} failed (${pushFailureKind})`,
      `spec ${shortSha(entry.specSha)}`,
      `main ${shortSha(fastForward.currentBase ?? currentBase)}`,
      fastForward.isFastForward === null
        ? fastForward.detail
        : `spec fast-forward ${fastForward.isFastForward ? "yes" : "no"}`,
      checkState.detail,
      pushErrorDetail,
    ].filter((part): part is string => Boolean(part && part.trim())).join("; ");

    emit(ctx, entry, "merge_rejected", {
      detail,
      baseSha: fastForward.currentBase ?? currentBase ?? undefined,
      failingChecks: checkState.failingChecks,
      pendingChecks: checkState.pendingChecks,
      missingRequiredChecks: checkState.missingRequiredChecks,
    });

    const mustRebuild = pushFailureKind === "non_fast_forward" || fastForward.isFastForward === false;
    if (mustRebuild) {
      const allActive = ctx.store.listActive(ctx.repoId);
      if (isBudgetExhausted(entry)) {
        emit(ctx, entry, "budget_exhausted", {
          detail: "push retry budget exhausted after non-fast-forward rejection",
        });
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

    if (isBudgetExhausted(entry)) {
      emit(ctx, entry, "budget_exhausted", {
        detail: "push retry budget exhausted; keeping validated spec for GitHub recovery",
      });
    }

    ctx.store.transition(entry.id, "merging", {
      retryAttempts: Math.min(entry.retryAttempts + 1, entry.maxRetries),
      waitDetail: detail,
    }, `push failed, keeping validated spec: ${detail}`);
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

  await deletePrBranchAfterGitHubMarksMerged(ctx, entry);
}

export async function deletePrBranchAfterGitHubMarksMerged(
  ctx: ReconcileContext,
  entry: QueueEntry,
  options: { attempts?: number; delayMs?: number } = {},
): Promise<void> {
  const attempts = options.attempts ?? DEFAULT_PR_MERGED_POLL_ATTEMPTS;
  const delayMs = options.delayMs ?? DEFAULT_PR_MERGED_POLL_DELAY_MS;

  for (let attempt = 0; attempt < attempts; attempt++) {
    let merged = false;
    try {
      merged = (await ctx.github.getStatus(entry.prNumber)).merged;
    } catch {
      // Keep polling briefly. If GitHub is unavailable, branch cleanup is
      // cosmetic; preserving correct PR merge classification matters more.
    }

    if (merged) {
      try {
        await ctx.github.deleteBranch(entry.prNumber);
      } catch {
        emit(ctx, entry, "pr_branch_cleanup_failed", {
          detail: "GitHub marked the PR merged, but deleting the head branch failed",
        });
      }
      return;
    }

    if (attempt < attempts - 1 && delayMs > 0) {
      await delay(delayMs);
    }
  }

  emit(ctx, entry, "pr_branch_cleanup_deferred", {
    detail: "waiting for GitHub to classify the fast-forwarded PR as merged before deleting the head branch",
  });
}
