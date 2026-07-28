import type { QueueEntry } from "./types.ts";
import type { ReconcileContext } from "./reconciler-core.ts";
import { emit, ref } from "./reconciler-core.ts";
import { classifyFailure } from "./classify.ts";
import { evictEntry, invalidateDownstream } from "./reconciler-evict.ts";
import { evaluateCheckPolicy, formatRequiredCheck } from "./check-policy.ts";

async function evictFailedCandidate(
  ctx: ReconcileContext,
  entry: QueueEntry,
  allActive: QueueEntry[],
  index: number,
  checks: Awaited<ReturnType<ReconcileContext["github"]["listChecksForRef"]>>,
): Promise<void> {
  const failedChecks = checks
    .filter((check) => check.conclusion === "failure" || check.conclusion === "skipped")
    .map((check) => ({
      name: check.name,
      conclusion: check.conclusion,
      ...(check.url ? { url: check.url } : {}),
    }));
  const mainChecks = await ctx.github.listChecksForRef(ref(ctx, ctx.baseBranch));
  const failureClass = checks.some((check) => check.conclusion === "skipped")
    ? "policy_blocked"
    : classifyFailure(checks, mainChecks);
  await evictEntry(ctx, entry, failureClass, { failedChecks });
  if (index >= 0) {
    await invalidateDownstream(ctx, allActive, index);
  }
}

async function requestBoundedRerun(
  ctx: ReconcileContext,
  entry: QueueEntry,
  params: {
    runId: string;
    branch: string;
    sha: string;
    candidateKind: "head" | "integration";
    checks: Awaited<ReturnType<ReconcileContext["github"]["listChecksForRef"]>>;
    allActive: QueueEntry[];
    index: number;
  },
): Promise<boolean> {
  const attempt = entry.ciRetries + 1;
  emit(ctx, entry, "ci_flaky_retry", {
    candidateKind: params.candidateKind,
    candidateSha: params.sha,
    detail: `rerun exact candidate ${attempt}/${ctx.flakyRetries}`,
  });
  try {
    const runId = await ctx.ci.rerunRun(params.runId, params.branch, params.sha);
    ctx.store.transition(entry.id, "validating", {
      ciRunId: runId,
      ciRetries: attempt,
    }, `exact-candidate flaky retry ${attempt}/${ctx.flakyRetries}`);
    return true;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    emit(ctx, entry, "ci_failed", {
      ciRunId: params.runId,
      detail: `candidate rerun unavailable (${attempt}/${ctx.flakyRetries}): ${detail}`,
    });
    if (attempt >= ctx.flakyRetries) {
      await evictFailedCandidate(ctx, entry, params.allActive, params.index, params.checks);
    } else {
      ctx.store.transition(entry.id, "validating", {
        ciRetries: attempt,
        waitDetail: `candidate rerun unavailable (${attempt}/${ctx.flakyRetries}): ${detail}`,
      }, `candidate rerun unavailable ${attempt}/${ctx.flakyRetries}`);
    }
    return false;
  }
}

export async function checkValidation(
  ctx: ReconcileContext,
  entry: QueueEntry,
  allActive: QueueEntry[],
  index: number,
  isLandingHead: boolean,
): Promise<void> {
  if (entry.candidateKind === "head") {
    const checks = await ctx.github.listChecksForRef(entry.candidateSha ?? entry.headSha);
    const evaluation = evaluateCheckPolicy(
      ctx.policy.getRequiredCheckRules(),
      ctx.policy.shouldRequireAllChecksOnEmptyRequiredSet(),
      checks,
    );
    const candidateRunId = `head:${entry.headSha}`;

    if (evaluation.status === "pending") {
      emit(ctx, entry, "ci_pending", {
        ciRunId: candidateRunId,
        detail: evaluation.missing.length > 0
          ? `missing ${evaluation.missing.map(formatRequiredCheck).join(", ")}`
          : "head candidate checks pending",
      });
      return;
    }
    if (evaluation.status === "fail") {
      emit(ctx, entry, "ci_failed", {
        ciRunId: candidateRunId,
        failingChecks: evaluation.failing,
      });
      if (entry.ciRetries < ctx.flakyRetries) {
        await requestBoundedRerun(ctx, entry, {
          runId: candidateRunId,
          branch: entry.branch,
          sha: entry.headSha,
          candidateKind: "head",
          checks,
          allActive,
          index,
        });
        return;
      }
      await evictFailedCandidate(ctx, entry, allActive, index, checks);
      return;
    }

    emit(ctx, entry, "ci_passed", {
      ciRunId: candidateRunId,
      candidateKind: "head",
      candidateSha: entry.headSha,
      policyFingerprint: entry.candidatePolicyFingerprint ?? undefined,
    });
    if (isLandingHead) {
      ctx.store.transition(entry.id, "merging", undefined, "exact head checks passed, ready to land");
    }
    return;
  }

  if (!entry.ciRunId) {
    const branch = entry.candidateRef ?? entry.branch;
    const sha = entry.candidateSha ?? entry.headSha;
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
      emit(ctx, entry, "ci_passed", {
        ciRunId: entry.ciRunId,
        candidateKind: entry.candidateKind ?? undefined,
        candidateSha: entry.candidateSha ?? undefined,
        policyFingerprint: entry.candidatePolicyFingerprint ?? undefined,
      });
      if (isLandingHead) {
        ctx.store.transition(entry.id, "merging", undefined, "CI passed, ready to merge");
      }
      break;

    case "fail": {
      emit(ctx, entry, "ci_failed", { ciRunId: entry.ciRunId });
      if (entry.ciRetries < ctx.flakyRetries) {
        const branch = entry.candidateRef ?? entry.branch;
        const sha = entry.candidateSha ?? entry.headSha;
        const checks = await ctx.github.listChecksForRef(sha);
        await requestBoundedRerun(ctx, entry, {
          runId: entry.ciRunId,
          branch,
          sha,
          candidateKind: "integration",
          checks,
          allActive,
          index,
        });
      } else {
        const sha = entry.candidateSha ?? entry.headSha;
        const checks = await ctx.github.listChecksForRef(sha);
        await evictFailedCandidate(ctx, entry, allActive, index, checks);
      }
      break;
    }
  }
}
