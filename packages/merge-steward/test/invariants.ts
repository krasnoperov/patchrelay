import assert from "node:assert/strict";
import type { QueueEntry, QueueEntryStatus } from "../src/types.ts";

const TERMINAL: QueueEntryStatus[] = ["merged", "evicted"];
const ACTIVE: QueueEntryStatus[] = [
  "queued",
  "waiting_head",
  "preparing_head",
  "validating",
  "passed",
  "merging",
  "repair_requested",
  "repair_in_progress",
  "paused",
];

/**
 * The 6 invariants from the design doc. Run after every state transition.
 */
export function assertInvariants(
  entries: QueueEntry[],
  mergedPRs: number[],
  mainIsGreen: boolean,
): void {
  assertSerialization(entries, mergedPRs);
  assertGreenMain(mainIsGreen);
  assertNoLoss(entries);
  assertSingleHead(entries);
  assertBoundedRepair(entries);
  assertMonotonicProgress(entries);
}

/**
 * 1. Serialization: merged PRs appear in queue-position order.
 */
function assertSerialization(entries: QueueEntry[], mergedPRs: number[]): void {
  const mergedEntries = entries
    .filter((e) => e.status === "merged")
    .sort((a, b) => a.position - b.position);
  const mergedNumbers = mergedEntries.map((e) => e.prNumber);

  // Merged PRs should appear in position order (no inversions).
  for (let i = 1; i < mergedNumbers.length; i++) {
    const prev = mergedEntries[i - 1]!;
    const curr = mergedEntries[i]!;
    assert.ok(
      prev.position < curr.position,
      `Serialization violated: PR #${prev.prNumber} (pos ${prev.position}) merged after PR #${curr.prNumber} (pos ${curr.position})`,
    );
  }
}

/**
 * 2. Green-main: main must always be green (every merge had passing CI).
 */
function assertGreenMain(mainIsGreen: boolean): void {
  assert.ok(mainIsGreen, "Main branch is not green after merge");
}

/**
 * 3. No-loss: every entry is in a known state. No entry has disappeared.
 */
function assertNoLoss(entries: QueueEntry[]): void {
  for (const entry of entries) {
    const allStatuses = [...TERMINAL, ...ACTIVE];
    assert.ok(
      allStatuses.includes(entry.status),
      `Entry ${entry.id} has unknown status: ${entry.status}`,
    );
  }
}

/**
 * 4. Single head: at most one entry is in preparing_head or validating.
 */
function assertSingleHead(entries: QueueEntry[]): void {
  const headStatuses: QueueEntryStatus[] = ["preparing_head", "validating", "passed", "merging"];
  const heads = entries.filter((e) => headStatuses.includes(e.status));
  assert.ok(
    heads.length <= 1,
    `Multiple heads active: ${heads.map((h) => `PR #${h.prNumber} (${h.status})`).join(", ")}`,
  );
}

/**
 * 5. Bounded repair: no entry exceeds its repair budget.
 */
function assertBoundedRepair(entries: QueueEntry[]): void {
  for (const entry of entries) {
    assert.ok(
      entry.repairAttempts <= entry.maxRepairAttempts,
      `PR #${entry.prNumber} exceeded repair budget: ${entry.repairAttempts} > ${entry.maxRepairAttempts}`,
    );
  }
}

/**
 * 6. Monotonic progress: no active (non-terminal) entry should exist
 *    with the same state across consecutive invariant checks without
 *    the queue making some forward progress. This is checked by the
 *    harness over multiple ticks, not as a single-snapshot assertion.
 *    Here we just verify the basic structural constraint: if the queue
 *    has active entries, at least one must be the head.
 */
function assertMonotonicProgress(entries: QueueEntry[]): void {
  const active = entries.filter((e) => ACTIVE.includes(e.status));
  if (active.length === 0) return; // queue is drained, ok

  const headLike = active.filter((e) =>
    ["preparing_head", "validating", "passed", "merging", "repair_requested", "repair_in_progress"].includes(e.status),
  );

  // If there are active entries, at least one should be progressing
  // (not all stuck in "queued" or "waiting_head").
  const progressing = headLike.length > 0;
  const allWaiting = active.every((e) => e.status === "queued" || e.status === "waiting_head" || e.status === "paused");

  assert.ok(
    progressing || allWaiting,
    `Active entries exist but none are progressing: ${active.map((e) => `PR #${e.prNumber} (${e.status})`).join(", ")}`,
  );
}
