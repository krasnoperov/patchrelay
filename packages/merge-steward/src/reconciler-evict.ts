import type { FailureClass, EvictionContext, QueueEntry } from "./types.ts";
import { randomUUID } from "node:crypto";
import { selectDownstream } from "./invalidation.ts";
import type { ReconcileContext } from "./reconciler-core.ts";
import { CLEAN_SPEC, emit, ref } from "./reconciler-core.ts";
import { INVALIDATION_PATCH } from "./invalidation.ts";

export async function cleanupSpec(ctx: ReconcileContext, entry: QueueEntry): Promise<void> {
  if (entry.specBranch) {
    await ctx.specBuilder.deleteSpeculative(entry.specBranch).catch(() => {
      // Best-effort cleanup — branch may not exist.
    });
  }
}

export async function invalidateDownstream(ctx: ReconcileContext, allActive: QueueEntry[], afterIndex: number): Promise<void> {
  const targets = selectDownstream(allActive, allActive[afterIndex]!.id);
  for (const downstream of targets) {
    emit(ctx, downstream, "invalidated", { detail: `base changed after position ${afterIndex}` });
    await cleanupSpec(ctx, downstream);
    ctx.store.transition(downstream.id, "preparing_head", INVALIDATION_PATCH, "invalidated: base changed");
  }
}

export async function evictEntry(
  ctx: ReconcileContext,
  entry: QueueEntry,
  failureClass: FailureClass,
  extra?: { conflictFiles?: string[]; failedChecks?: Array<{ name: string; conclusion: string; url?: string }> },
): Promise<void> {
  await cleanupSpec(ctx, entry);

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
    if (event.fromStatus === "preparing_head" && event.toStatus === "validating") {
      retryHistory.push({ at: event.at, baseSha: eventBaseSha, outcome: "passed_to_validation" });
    } else if (event.fromStatus === "validating" && event.toStatus === "preparing_head") {
      retryHistory.push({ at: event.at, baseSha: eventBaseSha, outcome: "ci_failed_retry" });
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
  ctx.store.transition(entry.id, "evicted", CLEAN_SPEC, `evicted: ${failureClass}`);
  await ctx.eviction.reportEviction(entry, incident);
}
