import type { QueueEntry } from "../types.ts";
import { TERMINAL_STATUSES } from "../types.ts";

const RECENTLY_COMPLETED_MS = 60_000;

/**
 * Build the display row list for the queue watch. In "active" mode,
 * includes active entries plus recently-terminal entries (within 60s),
 * deduplicated by prNumber (active wins over terminal for re-admissions).
 * In "all" mode, returns all entries as-is.
 */
export function buildDisplayEntries(entries: QueueEntry[], filter: "active" | "all"): QueueEntry[] {
  if (filter !== "active") return entries;
  const cutoff = Date.now() - RECENTLY_COMPLETED_MS;
  const byPR = new Map<number, QueueEntry>();
  for (const e of entries) {
    const isActive = !TERMINAL_STATUSES.includes(e.status);
    const isRecent = !isActive && new Date(e.updatedAt).getTime() > cutoff;
    if (!isActive && !isRecent) continue;
    const existing = byPR.get(e.prNumber);
    if (!existing || (isActive && TERMINAL_STATUSES.includes(existing.status))) {
      byPR.set(e.prNumber, e);
    }
  }
  return [...byPR.values()].sort((a, b) => a.position - b.position);
}

/**
 * Build the spec chain header entries. Always shows the current live
 * chain: active entries plus recently-merged entries (for cascade
 * visibility), regardless of the display filter. One entry per PR.
 */
export function buildChainEntries(entries: QueueEntry[]): QueueEntry[] {
  const cutoff = Date.now() - RECENTLY_COMPLETED_MS;
  const byPR = new Map<number, QueueEntry>();
  for (const e of entries) {
    const isActive = !TERMINAL_STATUSES.includes(e.status);
    const isRecent = !isActive && new Date(e.updatedAt).getTime() > cutoff;
    if (!isActive && !isRecent) continue;
    const existing = byPR.get(e.prNumber);
    if (!existing || (isActive && TERMINAL_STATUSES.includes(existing.status))) {
      byPR.set(e.prNumber, e);
    }
  }
  return [...byPR.values()].sort((a, b) => a.position - b.position);
}
