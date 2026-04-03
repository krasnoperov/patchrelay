import type { QueueEntry, QueueEntryStatus } from "./types.ts";
import { TERMINAL_STATUSES } from "./types.ts";

/** The transition patch applied to each invalidated entry — resets CI, spec, and retry state. */
export const INVALIDATION_PATCH = {
  ciRunId: null,
  ciRetries: 0,
  specBranch: null,
  specSha: null,
  specBasedOn: null,
  retryAttempts: 0,
  lastFailedBaseSha: null,
} as const satisfies Partial<Pick<QueueEntry, "ciRunId" | "ciRetries" | "specBranch" | "specSha" | "specBasedOn" | "retryAttempts" | "lastFailedBaseSha">>;

/** Select non-terminal entries after `afterPosition` from a position-sorted list. */
export function selectDownstream(allActive: QueueEntry[], afterPosition: number): QueueEntry[] {
  return allActive.filter(
    (e) => e.position > afterPosition && !TERMINAL_STATUSES.includes(e.status as QueueEntryStatus),
  );
}
