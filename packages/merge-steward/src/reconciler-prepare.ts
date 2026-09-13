import type { MergeResult, QueueEntry } from "./types.ts";
import type { ReconcileContext } from "./reconciler-core.ts";
import { CLEAN_CI, CLEAR_CANDIDATE, emit, ref, candidateRefName } from "./reconciler-core.ts";
import { evictEntry, supersedeAdmittedHead } from "./reconciler-evict.ts";
import { describeOpenPrAncestors, findUnlandedOpenPrAncestors } from "./open-pr-ancestry.ts";

export async function prepareEntry(
  ctx: ReconcileContext,
  entry: QueueEntry,
  isHead: boolean,
  prevEntry: QueueEntry | null,
): Promise<void> {
  emit(ctx, entry, "fetch_started");
  await ctx.git.fetch();

  const predecessorNeedsRepair = prevEntry?.lastFailedBaseSha !== null
    && prevEntry?.lastFailedBaseSha !== undefined
    && prevEntry?.ciRunId !== null
    && prevEntry?.ciRunId !== undefined;
  if (prevEntry?.candidateSha && (
    predecessorNeedsRepair
    || !await ctx.git.isAncestor(prevEntry.headSha, prevEntry.candidateSha)
  )) {
    const detail = `predecessor PR #${prevEntry.prNumber} is awaiting integration repair`;
    if (entry.waitDetail !== detail) {
      emit(ctx, entry, "stack_dependency_waiting", { detail });
      ctx.store.transition(entry.id, "preparing_head", { waitDetail: detail }, detail);
    }
    return;
  }

  const base = isHead ? ref(ctx, ctx.baseBranch) : prevEntry?.candidateSha ?? null;
  if (!base) return;

  const baseSha = await ctx.git.headSha(base);

  const currentRef = await ctx.git.headSha(ref(ctx, entry.branch));
  if (currentRef !== entry.headSha) {
    await supersedeAdmittedHead(ctx, entry, currentRef);
    return;
  }

  if (isHead) {
    const blockers = await findUnlandedOpenPrAncestors({
      github: ctx.github,
      git: ctx.git,
      currentPrNumber: entry.prNumber,
      prHeadSha: entry.headSha,
      candidateSha: entry.headSha,
      baseSha,
    });
    if (blockers.length > 0) {
      const detail = describeOpenPrAncestors(blockers);
      emit(ctx, entry, "open_pr_ancestry_blocked", { baseSha, detail });
      await evictEntry(ctx, entry, "policy_blocked", { openPrAncestors: blockers });
      return;
    }
  }

  // Preparing/validating the head never waits on main's CI. The exact
  // candidate includes current main and is gated solely by its own checks.
  //
  // A remote merge can advance main before GitHub's PR API reports `merged`.
  // The PR head is then already contained in main, so building and testing an
  // "integration" candidate would only reproduce the current main commit.
  // Hold the entry until sanitizeEntry observes GitHub's terminal truth.
  if (baseSha !== entry.headSha && await ctx.git.isAncestor(entry.headSha, baseSha)) {
    const detail = `PR head ${entry.headSha.slice(0, 12)} is already contained in main ${baseSha.slice(0, 12)}; waiting for GitHub merge recognition`;
    if (entry.waitDetail !== detail) {
      emit(ctx, entry, "merge_waiting_recognition", { baseSha, detail });
      ctx.store.transition(entry.id, "preparing_head", {
        baseSha,
        ...CLEAN_CI,
        ...CLEAR_CANDIDATE,
        waitDetail: detail,
      }, detail);
    }
    return;
  }

  // Candidate selection is structural, not a separate fast-forward workflow.
  // If the prospective base is already an ancestor of the PR head, that exact
  // immutable head is the future main candidate and its existing SHA-bound
  // checks are the only checks that can authorize it.
  if (await ctx.git.isAncestor(baseSha, entry.headSha)) {
    emit(ctx, entry, "candidate_selected", {
      candidateKind: "head",
      candidateSha: entry.headSha,
      baseSha,
      policyFingerprint: ctx.policy.getFingerprint(),
      ...(prevEntry ? { dependsOn: prevEntry.id } : {}),
    });
    ctx.store.transition(entry.id, "validating", {
      baseSha,
      ...CLEAN_CI,
      candidateKind: "head",
      candidatePolicyFingerprint: ctx.policy.getFingerprint(),
      candidateRef: null,
      candidateSha: entry.headSha,
      candidateBasedOn: isHead ? null : prevEntry!.id,
      waitDetail: null,
    }, `head candidate ${entry.headSha.slice(0, 12)} selected on ${baseSha.slice(0, 12)}`);
    return;
  }

  const specName = candidateRefName(ctx.baseBranch, entry.prNumber);
  emit(ctx, entry, "integration_build_started", { candidateRef: specName, baseSha, ...(prevEntry ? { dependsOn: prevEntry.id } : {}) });

  const branchSuffix = entry.branch.replace(/^.*\//, "").replace(/-/g, " ");
  const mergeMessage = `Merge PR #${entry.prNumber}: ${branchSuffix}`;

  let result: MergeResult;
  try {
    result = await ctx.specBuilder.buildSpeculative(entry.branch, base, specName, mergeMessage);
  } catch (err) {
    if (isHead) {
      const detail = `git error during candidate build: ${err instanceof Error ? err.message : String(err)}`;
      emit(ctx, entry, "branch_unreachable", { baseSha, detail });
      await evictEntry(ctx, entry, "branch_local");
    } else {
      emit(ctx, entry, "invalidated", { detail: "stale integration candidate, rebuilding" });
      ctx.store.transition(prevEntry!.id, "preparing_head", { ...CLEAN_CI, ...CLEAR_CANDIDATE }, "candidate ref missing, rebuilding");
      ctx.store.transition(entry.id, "preparing_head", { ...CLEAN_CI, ...CLEAR_CANDIDATE }, "stale dependency, rebuilding");
    }
    return;
  }

  if (!result.success) {
    emit(ctx, entry, "integration_build_conflict", { baseSha, conflictFiles: result.conflictFiles });
    // buildSpeculative deliberately leaves the local workspace ref at the
    // prospective base. Publish it so PatchRelay can derive the repair from
    // GitHub ancestry alone and add a merge commit with a non-force push.
    await ctx.git.push(specName, true);
    ctx.store.transition(entry.id, "validating", {
      baseSha,
      ...CLEAN_CI,
      candidateKind: "integration",
      candidatePolicyFingerprint: ctx.policy.getFingerprint(),
      candidateRef: specName,
      candidateSha: baseSha,
      candidateBasedOn: isHead ? null : prevEntry!.id,
      lastFailedBaseSha: baseSha,
      waitDetail: `integration conflict; workspace awaits repair${result.conflictFiles?.length ? ` in ${result.conflictFiles.join(", ")}` : ""}`,
    }, `integration workspace published at ${baseSha.slice(0, 12)} for conflict repair`);
    return;
  }

  const candidateSha = result.sha ?? entry.headSha;
  emit(ctx, entry, "integration_build_succeeded", {
    candidateRef: specName,
    candidateKind: "integration",
    candidateSha: candidateSha,
    baseSha,
    policyFingerprint: ctx.policy.getFingerprint(),
    ...(prevEntry ? { dependsOn: prevEntry.id } : {}),
  });
  emit(ctx, entry, "candidate_selected", {
    candidateRef: specName,
    candidateKind: "integration",
    candidateSha: candidateSha,
    baseSha,
    policyFingerprint: ctx.policy.getFingerprint(),
    ...(prevEntry ? { dependsOn: prevEntry.id } : {}),
  });

  await ctx.git.push(specName, true);

  const runId = await ctx.ci.triggerRun(specName, candidateSha);
  emit(ctx, entry, "ci_triggered", { ciRunId: runId, candidateRef: specName });

  ctx.store.transition(entry.id, "validating", {
    baseSha,
    candidateKind: "integration",
    candidatePolicyFingerprint: ctx.policy.getFingerprint(),
    ciRunId: runId,
    lastFailedBaseSha: null,
    candidateRef: specName,
    candidateSha,
    candidateBasedOn: isHead ? null : prevEntry!.id,
  }, `integration candidate ready, CI ${runId.slice(0, 12)}`);
}
