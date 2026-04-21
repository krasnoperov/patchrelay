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

/** Select non-terminal entries after `entryId` from an already ordered active queue list. */
export function selectDownstream(allActive: QueueEntry[], entryId: string): QueueEntry[] {
  const index = allActive.findIndex((entry) => entry.id === entryId);
  if (index < 0) return [];
  return allActive.slice(index + 1).filter(
    (entry) => !TERMINAL_STATUSES.includes(entry.status as QueueEntryStatus),
  );
}
