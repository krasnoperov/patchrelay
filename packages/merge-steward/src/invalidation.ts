import type { QueueEntry, QueueEntryStatus } from "./types.ts";
import { TERMINAL_STATUSES } from "./types.ts";

/** The transition patch applied to each invalidated entry — resets CI, spec, and retry state. */
export const INVALIDATION_PATCH = {
  ciRunId: null,
  ciRetries: 0,
  candidateRef: null,
  candidateSha: null,
  candidateBasedOn: null,
  candidateKind: null,
  candidatePolicyFingerprint: null,
  retryAttempts: 0,
  lastFailedBaseSha: null,
} as const satisfies Partial<Pick<QueueEntry, "ciRunId" | "ciRetries" | "candidateKind" | "candidatePolicyFingerprint" | "candidateRef" | "candidateSha" | "candidateBasedOn" | "retryAttempts" | "lastFailedBaseSha">>;

/**
 * Select only candidates whose persisted dependency chain contains entryId.
 * Queue position alone is not contamination: an independent candidate rebuilt
 * on main after a blocked stack must remain reusable.
 */
export function selectDownstream(allActive: QueueEntry[], entryId: string): QueueEntry[] {
  const contaminated = new Set([entryId]);
  const selected: QueueEntry[] = [];
  for (const entry of allActive) {
    if (TERMINAL_STATUSES.includes(entry.status as QueueEntryStatus)) continue;
    if (!entry.candidateBasedOn || !contaminated.has(entry.candidateBasedOn)) continue;
    contaminated.add(entry.id);
    selected.push(entry);
  }
  return selected;
}
