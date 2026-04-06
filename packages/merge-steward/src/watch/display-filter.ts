import type { QueueEntry } from "../types.ts";
import { TERMINAL_STATUSES } from "../types.ts";

const RECENTLY_COMPLETED_MS = 60_000;

function isActiveFilterVisible(entry: QueueEntry, cutoff: number): boolean {
  if (!TERMINAL_STATUSES.includes(entry.status)) {
    return true;
  }
  return new Date(entry.updatedAt).getTime() > cutoff;
}

function isLaterEntry(left: QueueEntry, right: QueueEntry): boolean {
  if (left.position !== right.position) {
    return left.position > right.position;
  }
  return new Date(left.updatedAt).getTime() >= new Date(right.updatedAt).getTime();
}

function pickLatestPerPR(entries: QueueEntry[]): QueueEntry[] {
  const byPR = new Map<number, QueueEntry>();
  for (const entry of entries) {
    const existing = byPR.get(entry.prNumber);
    if (!existing || isLaterEntry(entry, existing)) {
      byPR.set(entry.prNumber, entry);
    }
  }
  return [...byPR.values()];
}

/**
 * Build the display row list for the queue watch. In "active" mode,
 * includes active entries plus recently-terminal entries (within 60s),
 * deduplicated by prNumber (active wins over terminal for re-admissions).
 * In "all" mode, returns all entries as-is.
 */
export function buildDisplayEntries(entries: QueueEntry[], filter: "active" | "all"): QueueEntry[] {
  if (filter !== "active") return entries;
  const cutoff = Date.now() - RECENTLY_COMPLETED_MS;
  return pickLatestPerPR(entries)
    .filter((entry) => {
      const isActive = !TERMINAL_STATUSES.includes(entry.status);
      return isActive || isActiveFilterVisible(entry, cutoff);
    })
    .sort((a, b) => a.position - b.position);
}

/**
 * Build the spec chain header entries. Always shows the current live
 * chain: active entries plus recently-merged entries (for cascade
 * visibility), regardless of the display filter. One entry per PR.
 */
export function buildChainEntries(entries: QueueEntry[]): QueueEntry[] {
  const cutoff = Date.now() - RECENTLY_COMPLETED_MS;
  return pickLatestPerPR(entries)
    .filter((entry) => {
      const isActive = !TERMINAL_STATUSES.includes(entry.status);
      const isRecent = !isActive && new Date(entry.updatedAt).getTime() > cutoff;
      return isActive || isRecent;
    })
    .sort((a, b) => a.position - b.position);
}
