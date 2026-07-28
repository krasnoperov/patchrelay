import type { CheckResult, QueueEntry } from "./types.ts";
import type { ReconcileContext } from "./reconciler-core.ts";
import { CLEAN_CANDIDATE_REF, CLEAN_CI, CLEAR_CANDIDATE, emit, isBudgetExhausted, ref } from "./reconciler-core.ts";
import { cleanupCandidate, evictEntry, invalidateDownstream } from "./reconciler-evict.ts";
import { verifyPostMergeStatus } from "./reconciler-post-merge.ts";
import { evaluateCheckPolicy, formatRequiredCheck } from "./check-policy.ts";

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

function summarizeChecks(checks: CheckResult[], missingRequiredChecks: string[]): string {
  const visible = checks
    .filter((check) => check.name.trim())
    .map((check) => `${check.name}=${check.conclusion}`);
  const parts: string[] = [];
  if (visible.length > 0) {
    parts.push(`candidate checks ${visible.slice(0, 5).join(", ")}`);
    if (visible.length > 5) {
      parts.push(`+${visible.length - 5} more`);
    }
  } else {
    parts.push("no candidate checks visible");
  }
  if (missingRequiredChecks.length > 0) {
    parts.push(`missing required ${missingRequiredChecks.join(", ")}`);
  }
  return parts.join("; ");
}

async function inspectCandidateChecks(ctx: ReconcileContext, candidateSha: string | null): Promise<{
  detail: string;
  failingChecks: CheckResult[];
  pendingChecks: CheckResult[];
  missingRequiredChecks: string[];
}> {
  if (!candidateSha) {
    return {
      detail: "candidate checks unavailable: no candidate SHA",
      failingChecks: [],
      pendingChecks: [],
      missingRequiredChecks: ctx.policy.getRequiredCheckRules().map(formatRequiredCheck),
    };
  }

  try {
    const checks = await ctx.github.listChecksForRef(candidateSha);
    const evaluation = evaluateCheckPolicy(
      ctx.policy.getRequiredCheckRules(),
      ctx.policy.shouldRequireAllChecksOnEmptyRequiredSet(),
      checks,
    );
    const missingRequiredChecks = evaluation.missing.map(formatRequiredCheck);
    return {
      detail: summarizeChecks(checks, missingRequiredChecks),
      failingChecks: evaluation.failing,
      pendingChecks: evaluation.pending,
      missingRequiredChecks,
    };
  } catch (error) {
    return {
      detail: `candidate checks unavailable: ${describeError(error)}`,
      failingChecks: [],
      pendingChecks: [],
      missingRequiredChecks: ctx.policy.getRequiredCheckRules().map(formatRequiredCheck),
    };
  }
}

async function verifyCandidateStillFastForwards(
  ctx: ReconcileContext,
  candidateSha: string,
): Promise<{ currentBase: string | null; isFastForward: boolean | null; detail?: string }> {
  try {
    await ctx.git.fetch();
    const currentBase = await ctx.git.headSha(ref(ctx, ctx.baseBranch));
    const isFastForward = await ctx.git.isAncestor(currentBase, candidateSha);
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
    ctx.store.transition(entry.id, "merged", CLEAN_CANDIDATE_REF, "merged externally");
    await cleanupCandidate(ctx, entry);
    return;
  }

  if (!prStatus.mergeable) {
    emit(ctx, entry, "sanitized_closed", {
      detail: `PR #${entry.prNumber} closed before landing`,
    });
    const allActive = ctx.store.listActive(ctx.repoId);
    await cleanupCandidate(ctx, entry);
    ctx.store.transition(entry.id, "dequeued", CLEAN_CANDIDATE_REF, "PR closed before landing");
    await invalidateDownstream(ctx, allActive, 0);
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
    await cleanupCandidate(ctx, entry);
    ctx.store.updateHead(entry.id, prStatus.headSha);
    await invalidateDownstream(ctx, allActive, 0);
    return;
  }

  const liveBaseRefName = prStatus.baseRefName ?? ctx.baseBranch;
  const recordedBaseRefName = entry.baseRefName ?? ctx.baseBranch;
  if (liveBaseRefName !== recordedBaseRefName) {
    emit(ctx, entry, "invalidated", {
      detail: `PR base changed from ${recordedBaseRefName} to ${liveBaseRefName}`,
    });
    const allActive = ctx.store.listActive(ctx.repoId);
    await cleanupCandidate(ctx, entry);
    ctx.store.updateBaseRef(
      entry.id,
      liveBaseRefName,
      `PR base changed from ${recordedBaseRefName} to ${liveBaseRefName}`,
    );
    await invalidateDownstream(ctx, allActive, 0);
    return;
  }

  const validatedHead = entry.candidateKind === "head";
  if ((!entry.candidateRef || !entry.candidateSha) && !validatedHead) {
    ctx.store.transition(entry.id, "preparing_head", { ...CLEAN_CI, ...CLEAR_CANDIDATE }, "no integration candidate, re-prepare");
    return;
  }

  let currentBase: string | null = null;
  try {
    await ctx.git.fetch();
    currentBase = await ctx.git.headSha(ref(ctx, ctx.baseBranch));
    const policyRefresh = await ctx.policy.refreshBeforeLanding("candidate_landing");
    if (policyRefresh.changed) {
      emit(ctx, entry, "policy_changed", {
        detail: `GitHub required checks changed from [${policyRefresh.previousRequiredChecks.join(", ") || "(none)"}] to [${policyRefresh.requiredChecks.join(", ") || "(none)"}]`,
      });
    }
    if (validatedHead) {
      if (entry.candidateSha !== entry.headSha) {
        const detail = "head candidate SHA no longer matches the admitted PR head";
        emit(ctx, entry, "invalidated", { detail });
        ctx.store.transition(
          entry.id,
          "preparing_head",
          { ...CLEAN_CI, ...CLEAR_CANDIDATE },
          detail,
        );
        return;
      }
    }
    const landingSha = validatedHead ? entry.headSha : entry.candidateSha!;
    const candidateChecks = await ctx.github.listChecksForRef(landingSha);
    const checkEvaluation = evaluateCheckPolicy(
      ctx.policy.getRequiredCheckRules(),
      ctx.policy.shouldRequireAllChecksOnEmptyRequiredSet(),
      candidateChecks,
    );
    if (checkEvaluation.status !== "pass") {
      const missing = checkEvaluation.missing.map(formatRequiredCheck);
      const detail = missing.length > 0
        ? `candidate checks missing under current policy: ${missing.join(", ")}`
        : `candidate checks are ${checkEvaluation.status} under current policy`;
      emit(ctx, entry, "invalidated", { detail });
      ctx.store.transition(entry.id, "validating", { waitDetail: detail }, detail);
      return;
    }
    const isFF = await ctx.git.isAncestor(currentBase, landingSha);
    if (!isFF) {
      emit(ctx, entry, "branch_mismatch", {
        detail: `candidate is not a fast-forward from main (${currentBase.slice(0, 8)})`,
      });
      const allActive = ctx.store.listActive(ctx.repoId);
      ctx.store.transition(entry.id, "preparing_head", { ...CLEAN_CI, ...CLEAR_CANDIDATE }, "main diverged, re-prepare");
      await invalidateDownstream(ctx, allActive, 0);
      return;
    }

    // GitHub PR truth is deliberately the final remote read before the push.
    // This common gate applies to both exact-head and integration candidates;
    // neither may land after a force-push, retarget, external merge, or
    // approval revocation during policy/check/ancestry revalidation.
    const landingPrStatus = await ctx.github.getStatus(entry.prNumber);
    if (landingPrStatus.merged) {
      emit(ctx, entry, "merge_external");
      ctx.store.transition(entry.id, "merged", CLEAN_CANDIDATE_REF, "merged externally during landing revalidation");
      await cleanupCandidate(ctx, entry);
      return;
    }
    if (!landingPrStatus.mergeable) {
      emit(ctx, entry, "sanitized_closed", {
        detail: `PR #${entry.prNumber} closed during landing revalidation`,
      });
      const allActive = ctx.store.listActive(ctx.repoId);
      await cleanupCandidate(ctx, entry);
      ctx.store.transition(entry.id, "dequeued", CLEAN_CANDIDATE_REF, "PR closed during landing revalidation");
      await invalidateDownstream(ctx, allActive, 0);
      return;
    }
    if (landingPrStatus.headSha !== entry.headSha) {
      emit(ctx, entry, "branch_mismatch", {
        detail: `PR head changed during landing: expected ${entry.headSha.slice(0, 8)}, got ${landingPrStatus.headSha.slice(0, 8)}`,
      });
      const allActive = ctx.store.listActive(ctx.repoId);
      await cleanupCandidate(ctx, entry);
      ctx.store.updateHead(entry.id, landingPrStatus.headSha);
      await invalidateDownstream(ctx, allActive, 0);
      return;
    }
    const landingBaseRefName = landingPrStatus.baseRefName ?? ctx.baseBranch;
    if (landingBaseRefName !== recordedBaseRefName) {
      emit(ctx, entry, "invalidated", {
        detail: `PR base changed during landing from ${recordedBaseRefName} to ${landingBaseRefName}`,
      });
      const allActive = ctx.store.listActive(ctx.repoId);
      await cleanupCandidate(ctx, entry);
      ctx.store.updateBaseRef(
        entry.id,
        landingBaseRefName,
        `PR base changed during landing from ${recordedBaseRefName} to ${landingBaseRefName}`,
      );
      await invalidateDownstream(ctx, allActive, 0);
      return;
    }
    if (!landingPrStatus.reviewApproved) {
      const detail = landingPrStatus.reviewDecision === "CHANGES_REQUESTED"
        ? "blocking review appeared during landing"
        : "approval was withdrawn during landing";
      emit(ctx, entry, "merge_waiting_approval", { detail });
      ctx.store.transition(entry.id, "merging", { waitDetail: detail }, detail);
      return;
    }

    const currentPolicyFingerprint = ctx.policy.getFingerprint();
    if (entry.candidatePolicyFingerprint !== currentPolicyFingerprint) {
      ctx.store.transition(entry.id, "merging", {
        candidatePolicyFingerprint: currentPolicyFingerprint,
      }, `candidate revalidated under policy ${currentPolicyFingerprint.slice(0, 12)}`);
    }
  } catch (error) {
    const detail = `candidate revalidation unavailable: ${describeError(error)}`;
    emit(ctx, entry, "invalidated", { detail });
    ctx.store.transition(
      entry.id,
      validatedHead ? "preparing_head" : "validating",
      validatedHead ? { ...CLEAN_CI, ...CLEAR_CANDIDATE, waitDetail: detail } : { waitDetail: detail },
      detail,
    );
    return;
  }

  // The queue gates only on the exact candidate's CI. main's CI status is
  // irrelevant to landing: the candidate includes current main (the fast-forward
  // check above guarantees main has not diverged) and its checks passed, so pushing it advances
  // main to a green SHA. We never wait for main's own CI to settle, and never pause
  // the queue because main is red — a red main is either flaky or fixed by landing
  // this green candidate. main CI is information-only (out-of-band breakage canary).

  try {
    // The eligibility proof is SHA-bound. Never substitute the mutable remote
    // tracking branch here: a force-push fetched between status reads could
    // otherwise validate H1 and land H2. Git accepts an object ID as the
    // source side of a push refspec, so push the exact validated commit.
    await ctx.git.push(entry.candidateSha!, false, ctx.baseBranch);
  } catch (error) {
    const pushErrorDetail = describeError(error);
    const pushFailureKind = classifyPushFailure(error, pushErrorDetail);
    const landingSha = validatedHead ? entry.headSha : entry.candidateSha;
    const fastForward = landingSha
      ? await verifyCandidateStillFastForwards(ctx, landingSha)
      : { currentBase: null, isFastForward: null, detail: "fast-forward verification unavailable: no candidate SHA" };

    try {
      const refresh = await ctx.policy.refreshOnIssue("merge_push_rejected");
      if (refresh.attempted && refresh.changed) {
        emit(ctx, entry, "policy_changed", {
          detail: `GitHub required checks changed from [${refresh.previousRequiredChecks.join(", ") || "(none)"}] to [${refresh.requiredChecks.join(", ") || "(none)"}]`,
        });
        ctx.store.transition(entry.id, "preparing_head", { ...CLEAN_CI, ...CLEAR_CANDIDATE }, "GitHub protection changed, re-preparing");
        const allActive = ctx.store.listActive(ctx.repoId);
        await invalidateDownstream(ctx, allActive, 0);
        return;
      }
    } catch {
      // Fall through to the normal push failure handling when policy refresh is unavailable.
    }

    const checkState = await inspectCandidateChecks(ctx, landingSha);
    const detail = [
      `push to ${ctx.baseBranch} failed (${pushFailureKind})`,
      `candidate ${shortSha(landingSha)}`,
      `main ${shortSha(fastForward.currentBase ?? currentBase)}`,
      fastForward.isFastForward === null
        ? fastForward.detail
        : `candidate fast-forward ${fastForward.isFastForward ? "yes" : "no"}`,
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
          ...CLEAR_CANDIDATE,
        }, `push failed, retry ${entry.retryAttempts + 1}/${entry.maxRetries}`);
      }
      await invalidateDownstream(ctx, allActive, 0);
      return;
    }

    if (isBudgetExhausted(entry)) {
      emit(ctx, entry, "budget_exhausted", {
        detail: "push retry budget exhausted; keeping validated candidate for GitHub recovery",
      });
    }

    ctx.store.transition(entry.id, "merging", {
      retryAttempts: Math.min(entry.retryAttempts + 1, entry.maxRetries),
      waitDetail: detail,
    }, `push failed, keeping validated candidate: ${detail}`);
    return;
  }

  if (validatedHead) {
    emit(ctx, entry, "head_candidate_landed", {
      baseSha: currentBase ?? undefined,
      candidateKind: "head",
      candidateSha: entry.headSha,
      policyFingerprint: ctx.policy.getFingerprint(),
      detail: `validated head ${entry.headSha.slice(0, 8)} fast-forwarded to ${ctx.baseBranch}`,
    });
  }
  emit(ctx, entry, "merge_succeeded");
  const verificationResult = await verifyPostMergeStatus(ctx, {
    ...entry,
    postMergeSha: validatedHead ? entry.headSha : entry.candidateSha ?? entry.headSha,
  });
  ctx.store.transition(entry.id, "merged", {
    ...CLEAN_CANDIDATE_REF,
    postMergeStatus: verificationResult.postMergeStatus,
    postMergeSha: verificationResult.postMergeSha,
    postMergeSummary: verificationResult.postMergeSummary,
    postMergeCheckedAt: new Date().toISOString(),
  }, `${validatedHead ? "validated head" : "integration candidate"} pushed to main; ${verificationResult.postMergeSummary}`);

  await cleanupCandidate(ctx, entry);

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
