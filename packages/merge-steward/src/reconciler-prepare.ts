import type { MergeResult, QueueEntry } from "./types.ts";
import type { ReconcileContext } from "./reconciler-core.ts";
import { CLEAN_CI, CLEAN_SPEC, emit, isBudgetExhausted, isRetryGated, ref, specBranchName } from "./reconciler-core.ts";
import { evictEntry } from "./reconciler-evict.ts";

function summarizeCheckNames(checks: Array<{ name: string }>, limit = 3): string {
  const names = [...new Set(checks.map((check) => check.name))];
  if (names.length <= limit) {
    return names.join(", ");
  }
  return `${names.slice(0, limit).join(", ")} +${names.length - limit} more`;
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

function describeMainBroken(
  failingChecks: Array<{ name: string }>,
  pendingChecks: Array<{ name: string }>,
  missingRequiredChecks: string[],
): string {
  const parts: string[] = [];
  if (missingRequiredChecks.length > 0) {
    parts.push(`missing required ${missingRequiredChecks.join(", ")}`);
  }
  if (failingChecks.length > 0) {
    parts.push(`failing ${summarizeCheckNames(failingChecks)}`);
  }
  if (pendingChecks.length > 0) {
    parts.push(`pending ${summarizeCheckNames(pendingChecks)}`);
  }
  return parts.length > 0 ? `main checks unhealthy: ${parts.join("; ")}` : "main checks unhealthy";
}

export async function prepareEntry(
  ctx: ReconcileContext,
  entry: QueueEntry,
  isHead: boolean,
  prevEntry: QueueEntry | null,
): Promise<void> {
  emit(ctx, entry, "fetch_started");
  await ctx.git.fetch();

  const base = isHead ? ref(ctx, ctx.baseBranch) : prevEntry?.specBranch ?? null;
  if (!base) return;

  const baseSha = await ctx.git.headSha(base);

  const currentRef = await ctx.git.headSha(ref(ctx, entry.branch));
  if (currentRef !== entry.headSha) {
    emit(ctx, entry, "branch_mismatch", { detail: `expected ${entry.headSha.slice(0, 8)}, got ${currentRef.slice(0, 8)}` });
    ctx.store.updateHead(entry.id, currentRef);
    return;
  }

  if (isHead) {
    if (ctx.ci.getMainStatus) {
      const mainStatus = await ctx.ci.getMainStatus(ctx.baseBranch);
      if (mainStatus !== "pass") {
        let mainChecks: Array<{ name: string; conclusion: "success" | "failure" | "pending"; url?: string | undefined }> = [];
        try {
          mainChecks = await ctx.github.listChecksForRef(ref(ctx, ctx.baseBranch));
        } catch {
          mainChecks = [];
        }
        const failingChecks = mainChecks.filter((check) => check.conclusion === "failure");
        const pendingChecks = mainChecks.filter((check) => check.conclusion === "pending");
        let missingRequiredChecks = getMissingRequiredChecks(ctx.policy.getRequiredChecks(), mainChecks);
        if (missingRequiredChecks.length > 0) {
          try {
            const refresh = await ctx.policy.refreshOnIssue("main_missing_required_checks");
            if (refresh.attempted && refresh.changed) {
              missingRequiredChecks = getMissingRequiredChecks(ctx.policy.getRequiredChecks(), mainChecks);
              emit(ctx, entry, "policy_changed", {
                detail: `GitHub required checks changed from [${refresh.previousRequiredChecks.join(", ") || "(none)"}] to [${refresh.requiredChecks.join(", ") || "(none)"}]`,
              });
              if (missingRequiredChecks.length === 0 && failingChecks.length === 0 && pendingChecks.length === 0) {
                return;
              }
            }
          } catch {
            // Keep using the last known GitHub policy and surface the current block.
          }
        }
        emit(ctx, entry, "main_broken", {
          baseSha,
          failingChecks,
          pendingChecks,
          missingRequiredChecks,
          detail: describeMainBroken(failingChecks, pendingChecks, missingRequiredChecks),
        });
        return;
      }
    }

    if (isBudgetExhausted(entry) && entry.lastFailedBaseSha !== null) {
      emit(ctx, entry, "budget_exhausted", { baseSha });
      await evictEntry(ctx, entry, "integration_conflict");
      return;
    }

    if (isRetryGated(entry, baseSha)) {
      try {
        const prStatus = await ctx.github.getStatus(entry.prNumber);
        if (prStatus.mergeStateStatus === "DIRTY") {
          emit(ctx, entry, "budget_exhausted", {
            baseSha,
            detail: "retry gated and GitHub still reports merge conflict",
          });
          await evictEntry(ctx, entry, "integration_conflict");
          return;
        }
        emit(ctx, entry, "retry_gated", { baseSha, detail: "local conflict but GitHub reports CLEAN, retrying" });
        ctx.store.transition(entry.id, "preparing_head", {
          lastFailedBaseSha: null,
          ...CLEAN_CI,
          ...CLEAN_SPEC,
        }, "GitHub reports CLEAN, clearing retry gate");
      } catch {
        emit(ctx, entry, "retry_gated", { baseSha, detail: "base unchanged since last conflict" });
      }
      return;
    }
  }

  const specName = specBranchName(entry.id);
  emit(ctx, entry, "spec_build_started", { specBranch: specName, baseSha, ...(prevEntry ? { dependsOn: prevEntry.id } : {}) });

  const branchSuffix = entry.branch.replace(/^.*\//, "").replace(/-/g, " ");
  const mergeMessage = `Merge PR #${entry.prNumber}: ${branchSuffix}`;

  let result: MergeResult;
  try {
    result = await ctx.specBuilder.buildSpeculative(entry.branch, base, specName, mergeMessage);
  } catch (err) {
    if (isHead) {
      const detail = `git error during spec build: ${err instanceof Error ? err.message : String(err)}`;
      emit(ctx, entry, "branch_unreachable", { baseSha, detail });
      await evictEntry(ctx, entry, "branch_local");
    } else {
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
        ...CLEAN_CI,
        ...CLEAN_SPEC,
      }, `conflict on ${baseSha.slice(0, 8)}, retry ${entry.retryAttempts + 1}/${entry.maxRetries}`);
    }
    return;
  }

  const specSha = result.sha ?? entry.headSha;
  emit(ctx, entry, "spec_build_succeeded", { specBranch: specName, ...(prevEntry ? { dependsOn: prevEntry.id } : {}) });

  await ctx.git.push(specName, true);

  const runId = await ctx.ci.triggerRun(specName, specSha);
  emit(ctx, entry, "ci_triggered", { ciRunId: runId, specBranch: specName });
  ctx.store.transition(entry.id, "validating", {
    baseSha,
    ciRunId: runId,
    lastFailedBaseSha: null,
    specBranch: specName,
    specSha,
    specBasedOn: isHead ? null : prevEntry!.id,
  }, `spec ready, CI ${runId.slice(0, 12)}`);
}
