import type { FailureClass, EvictionContext, QueueEntry } from "./types.ts";
import { randomUUID } from "node:crypto";
import { selectDownstream } from "./invalidation.ts";
import type { ReconcileContext } from "./reconciler-core.ts";
import { CLEAN_CANDIDATE_REF, emit, ref } from "./reconciler-core.ts";
import { INVALIDATION_PATCH } from "./invalidation.ts";

export async function cleanupCandidate(ctx: ReconcileContext, entry: QueueEntry): Promise<void> {
  if (entry.candidateRef) {
    await ctx.specBuilder.deleteSpeculative(entry.candidateRef).catch(() => {
      // Best-effort cleanup — branch may not exist.
    });
  }
}

export async function invalidateDownstream(ctx: ReconcileContext, allActive: QueueEntry[], afterIndex: number): Promise<void> {
  const targets = selectDownstream(allActive, allActive[afterIndex]!.id);
  for (const downstream of targets) {
    emit(ctx, downstream, "invalidated", { detail: `base changed after position ${afterIndex}` });
    await cleanupCandidate(ctx, downstream);
    ctx.store.transition(downstream.id, "preparing_head", INVALIDATION_PATCH, "invalidated: base changed");
  }
}

/** Retire the immutable admission when GitHub exposes a different PR head. */
export async function supersedeAdmittedHead(
  ctx: ReconcileContext,
  entry: QueueEntry,
  newHeadSha: string,
): Promise<void> {
  const allActive = ctx.store.listActive(ctx.repoId);
  const index = allActive.findIndex((candidate) => candidate.id === entry.id);
  emit(ctx, entry, "branch_mismatch", {
    detail: `admitted head ${entry.headSha.slice(0, 12)} superseded by ${newHeadSha.slice(0, 12)}`,
  });
  await cleanupCandidate(ctx, entry);
  ctx.store.transition(
    entry.id,
    "superseded",
    {
      ...CLEAN_CANDIDATE_REF,
      candidateKind: null,
      candidatePolicyFingerprint: null,
      candidateSha: null,
      ciRunId: null,
      ciRetries: 0,
      waitDetail: null,
    },
    `admitted head ${entry.headSha.slice(0, 12)} superseded by ${newHeadSha.slice(0, 12)}; new head must pass admission`,
  );
  if (index >= 0) await invalidateDownstream(ctx, allActive, index);
}

export async function evictEntry(
  ctx: ReconcileContext,
  entry: QueueEntry,
  failureClass: FailureClass,
  extra?: {
    conflictFiles?: string[];
    failedChecks?: Array<{ name: string; conclusion: string; url?: string }>;
    openPrAncestors?: Array<{ prNumber: number; branch: string; headSha: string; sharedAncestorSha: string }>;
  },
): Promise<void> {
  await cleanupCandidate(ctx, entry);

  let baseSha = entry.baseSha;
  if (!baseSha) {
    try {
      baseSha = await ctx.git.headSha(ref(ctx, ctx.baseBranch));
    } catch {
      baseSha = "unknown";
    }
  }

  const events = ctx.store.listEvents(entry.id);
  const retryHistory: EvictionContext["retryHistory"] = [];
  for (const event of events) {
    const eventBaseSha = event.baseSha || "unknown";
    const detail = event.detail ?? "";
    if (event.fromStatus === "preparing_head" && event.toStatus === "validating") {
      retryHistory.push({ at: event.at, baseSha: eventBaseSha, outcome: "passed_to_validation" });
    } else if (event.fromStatus === "validating" && event.toStatus === "preparing_head") {
      const outcome = detail.startsWith("invalidated:")
        ? "invalidated"
        : detail.toLowerCase().includes("ci failed")
          ? "ci_failed_retry"
          : "validation_reset";
      retryHistory.push({ at: event.at, baseSha: eventBaseSha, outcome });
    } else if (event.fromStatus === "merging" && event.toStatus === "preparing_head") {
      retryHistory.push({ at: event.at, baseSha: eventBaseSha, outcome: "push_failed_retry" });
    } else if (event.fromStatus === "preparing_head" && event.toStatus === "preparing_head") {
      retryHistory.push({ at: event.at, baseSha: eventBaseSha, outcome: "conflict_retry" });
    }
  }

  const context: EvictionContext = {
    version: 1,
    failureClass,
    baseSha,
    prHeadSha: entry.headSha,
    queuePosition: entry.position,
    conflictFiles: extra?.conflictFiles,
    failedChecks: extra?.failedChecks,
    openPrAncestors: extra?.openPrAncestors,
    baseBranch: ctx.baseBranch,
    branch: entry.branch,
    issueKey: entry.issueKey,
    retryHistory,
  };

  const incident = {
    id: randomUUID(),
    entryId: entry.id,
    at: new Date().toISOString(),
    failureClass,
    context,
    outcome: "open" as const,
  };

  ctx.store.insertIncident(incident);
  emit(ctx, entry, "evicted", { failureClass });
  ctx.store.transition(entry.id, "evicted", CLEAN_CANDIDATE_REF, `evicted: ${failureClass}`);
  await ctx.eviction.reportEviction(entry, incident);
}
