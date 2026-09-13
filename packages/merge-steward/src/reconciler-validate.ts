import type { QueueEntry } from "./types.ts";
import type { ReconcileContext } from "./reconciler-core.ts";
import { CLEAN_CI, CLEAR_CANDIDATE, INTEGRATION_REVIEW_CHECK, candidateRefName, emit, ref } from "./reconciler-core.ts";
import { evictEntry, invalidateDownstream } from "./reconciler-evict.ts";
import { evaluateCheckPolicy, formatRequiredCheck } from "./check-policy.ts";

async function holdForIntegrationRepair(
  ctx: ReconcileContext,
  entry: QueueEntry,
  allActive: QueueEntry[],
  index: number,
  checks: Awaited<ReturnType<ReconcileContext["github"]["listChecksForRef"]>>,
): Promise<void> {
  let candidateRef = entry.candidateRef;
  if (!candidateRef) {
    candidateRef = candidateRefName(ctx.baseBranch, entry.prNumber);
    await ctx.specBuilder.createWorkspace(candidateRef, entry.candidateSha ?? entry.headSha);
    await ctx.git.push(candidateRef, true);
  }
  const failed = checks
    .filter((check) => check.conclusion === "failure" || check.conclusion === "skipped")
    .map((check) => check.name)
    .join(", ");
  ctx.store.transition(entry.id, "validating", {
    // A failed repaired candidate is still a repaired candidate. Preserve the
    // provenance so a same-SHA rerun remains gated by integration review.
    candidateKind: entry.candidateKind === "integration_repair" ? "integration_repair" : "integration",
    ciRunId: entry.ciRunId ?? `head:${entry.candidateSha ?? entry.headSha}`,
    candidateRef,
    candidateSha: entry.candidateSha ?? entry.headSha,
    candidateBasedOn: entry.candidateBasedOn,
    lastFailedBaseSha: entry.baseSha,
    waitDetail: `candidate CI failed; integration workspace awaits repair${failed ? ` (${failed})` : ""}`,
  }, "candidate retained for integration repair");
  if (index >= 0) await invalidateDownstream(ctx, allActive, index);
}

async function refreshIntegrationWorkspace(
  ctx: ReconcileContext,
  entry: QueueEntry,
  allActive: QueueEntry[],
  index: number,
): Promise<QueueEntry | null> {
  if (!entry.candidateRef) return entry;
  await ctx.git.fetch();
  const liveSha = await ctx.git.headSha(ref(ctx, entry.candidateRef));

  const dependency = entry.candidateBasedOn ? ctx.store.getEntry(entry.candidateBasedOn) : null;
  const expectedBaseSha = dependency && dependency.status !== "merged"
    ? dependency.candidateSha
    : await ctx.git.headSha(ref(ctx, ctx.baseBranch));
  if (!expectedBaseSha || !await ctx.git.isAncestor(expectedBaseSha, liveSha)) {
    emit(ctx, entry, "invalidated", { detail: "integration workspace no longer descends from its prospective base" });
    ctx.store.transition(entry.id, "preparing_head", { ...CLEAN_CI, ...CLEAR_CANDIDATE }, "stale integration workspace; rebuilding");
    if (index >= 0) await invalidateDownstream(ctx, allActive, index);
    return null;
  }

  if (liveSha !== entry.candidateSha) {
    emit(ctx, entry, "candidate_selected", {
      candidateRef: entry.candidateRef,
      candidateKind: "integration_repair",
      candidateSha: liveSha,
      baseSha: expectedBaseSha,
      detail: "external non-force integration repair detected",
    });
    ctx.store.transition(entry.id, "validating", {
      baseSha: expectedBaseSha,
      ...CLEAN_CI,
      candidateKind: "integration_repair",
      candidatePolicyFingerprint: ctx.policy.getFingerprint(),
      candidateRef: entry.candidateRef,
      candidateSha: liveSha,
      candidateBasedOn: entry.candidateBasedOn,
      lastFailedBaseSha: entry.lastFailedBaseSha ?? entry.baseSha,
      waitDetail: "integration repair detected; validating exact candidate",
    }, `integration workspace advanced to ${liveSha.slice(0, 12)}`);
    if (index >= 0) await invalidateDownstream(ctx, allActive, index);
    return ctx.store.getEntry(entry.id) ?? null;
  }
  return entry;
}

async function integrationReviewStatus(
  ctx: ReconcileContext,
  entry: QueueEntry,
): Promise<"pass" | "pending" | "fail"> {
  if (entry.candidateKind !== "integration_repair") return "pass";
  const checks = await ctx.github.listChecksForRef(entry.candidateSha!);
  return evaluateCheckPolicy(
    [{ name: INTEGRATION_REVIEW_CHECK, appId: null }],
    false,
    checks,
  ).status;
}

async function acceptPassingIntegrationCandidate(
  ctx: ReconcileContext,
  entry: QueueEntry,
  allActive: QueueEntry[],
  index: number,
  isLandingHead: boolean,
  ciRunId: string,
): Promise<void> {
  const reviewStatus = await integrationReviewStatus(ctx, entry);
  if (reviewStatus === "pending") {
    ctx.store.transition(entry.id, "validating", {
      waitDetail: `waiting for ${INTEGRATION_REVIEW_CHECK} on repaired candidate`,
    }, `waiting for ${INTEGRATION_REVIEW_CHECK}`);
    return;
  }
  if (reviewStatus === "fail") {
    await evictEntry(ctx, entry, "feature_changed");
    if (index >= 0) await invalidateDownstream(ctx, allActive, index);
    return;
  }
  emit(ctx, entry, "ci_passed", {
    ciRunId,
    candidateKind: entry.candidateKind ?? undefined,
    candidateSha: entry.candidateSha ?? undefined,
    policyFingerprint: entry.candidatePolicyFingerprint ?? undefined,
  });
  if (isLandingHead) {
    ctx.store.transition(entry.id, "merging", { lastFailedBaseSha: null, waitDetail: null }, "CI and integration review passed, ready to merge");
  } else if (entry.lastFailedBaseSha) {
    ctx.store.transition(entry.id, "validating", {
      lastFailedBaseSha: null,
      waitDetail: null,
    }, "integration repair validated for speculative descendants");
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
      await holdForIntegrationRepair(ctx, entry, params.allActive, params.index, params.checks);
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
  const refreshed = await refreshIntegrationWorkspace(ctx, entry, allActive, index);
  if (!refreshed) return;
  entry = refreshed;

  if (entry.candidateRef && !await ctx.git.isAncestor(entry.headSha, entry.candidateSha!)) {
    return;
  }
  if (entry.candidateRef && entry.lastFailedBaseSha && entry.ciRunId) {
    // Do not manufacture another CI run on every wakeup, but do re-read the
    // exact SHA: an operator or GitHub may have rerun the failed workflow in
    // place. A green rerun must resume the queue without a no-op commit.
    const checks = (await ctx.github.listChecksForRef(entry.candidateSha!))
      .filter((check) => check.name.toLowerCase() !== INTEGRATION_REVIEW_CHECK);
    const evaluation = evaluateCheckPolicy(
      ctx.policy.getRequiredCheckRules(),
      ctx.policy.shouldRequireAllChecksOnEmptyRequiredSet(),
      checks,
    );
    if (evaluation.status === "pass") {
      await acceptPassingIntegrationCandidate(ctx, entry, allActive, index, isLandingHead, entry.ciRunId);
    } else if (evaluation.status === "pending") {
      ctx.store.transition(entry.id, "validating", {
        waitDetail: "waiting for exact-candidate rerun",
      }, "exact-candidate rerun pending");
    }
    return;
  }

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
      await holdForIntegrationRepair(ctx, entry, allActive, index, checks);
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
    const existingChecks = (await ctx.github.listChecksForRef(sha))
      .filter((check) => check.name.toLowerCase() !== INTEGRATION_REVIEW_CHECK);
    if (existingChecks.length > 0) {
      const evaluation = evaluateCheckPolicy(
        ctx.policy.getRequiredCheckRules(),
        ctx.policy.shouldRequireAllChecksOnEmptyRequiredSet(),
        existingChecks,
      );
      if (evaluation.status === "pass") {
        await acceptPassingIntegrationCandidate(ctx, entry, allActive, index, isLandingHead, `checks:${sha}`);
      } else if (evaluation.status === "pending") {
        emit(ctx, entry, "ci_pending", { detail: "existing exact-SHA checks pending" });
      } else {
        await holdForIntegrationRepair(ctx, entry, allActive, index, existingChecks);
      }
      return;
    }
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
      await acceptPassingIntegrationCandidate(ctx, entry, allActive, index, isLandingHead, entry.ciRunId);
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
        await holdForIntegrationRepair(ctx, entry, allActive, index, checks);
      }
      break;
    }
  }
}
