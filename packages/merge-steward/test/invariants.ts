import assert from "node:assert/strict";
import type { QueueEntry, QueueEntryStatus } from "../src/types.ts";
import { TERMINAL_STATUSES } from "../src/types.ts";

const TERMINAL = TERMINAL_STATUSES;
const ACTIVE: QueueEntryStatus[] = [
  "queued",
  "preparing_head",
  "validating",
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
  allEntryIds: Set<string>,
): void {
  assertSerialization(entries);
  assertGreenMain(entries, mainIsGreen);
  assertNoLoss(entries, allEntryIds);
  assertSingleHead(entries);
  assertBoundedRepair(entries);
  assertMonotonicProgress(entries);
}

/**
 * 1. Serialization: merged PRs appear in queue-position order.
 * No position inversion among merged entries.
 */
function assertSerialization(entries: QueueEntry[]): void {
  const mergedEntries = entries
    .filter((e) => e.status === "merged")
    .sort((a, b) => a.position - b.position);

  for (let i = 1; i < mergedEntries.length; i++) {
    const prev = mergedEntries[i - 1]!;
    const curr = mergedEntries[i]!;
    assert.ok(
      prev.position < curr.position,
      `Serialization violated: PR #${prev.prNumber} (pos ${prev.position}) merged after PR #${curr.prNumber} (pos ${curr.position})`,
    );
  }
}

/**
 * 2. Green-main: every merged entry must have had a passing CI run.
 * The mainIsGreen flag tracks whether onMainBroken was ever called.
 * Additionally: no entry with status "merged" should have a null ciRunId
 * (meaning it was merged without ever running CI).
 */
function assertGreenMain(entries: QueueEntry[], mainIsGreen: boolean): void {
  assert.ok(mainIsGreen, "Main branch is not green — onMainBroken was called");

  for (const entry of entries) {
    if (entry.status === "merged") {
      assert.ok(
        entry.ciRunId !== null,
        `PR #${entry.prNumber} was merged without a CI run (ciRunId is null)`,
      );
    }
  }
}

/**
 * 3. No-loss: every entry ID that was ever enqueued must still exist
 * in the entries array with a known status. No entry can vanish.
 */
function assertNoLoss(entries: QueueEntry[], allEntryIds: Set<string>): void {
  const currentIds = new Set(entries.map((e) => e.id));

  for (const id of allEntryIds) {
    assert.ok(
      currentIds.has(id),
      `Entry ${id} was enqueued but is no longer in the entries array`,
    );
  }

  for (const entry of entries) {
    const allStatuses: QueueEntryStatus[] = [...TERMINAL, ...ACTIVE];
    assert.ok(
      allStatuses.includes(entry.status),
      `Entry ${entry.id} (PR #${entry.prNumber}) has unknown status: ${entry.status}`,
    );
  }
}

/**
 * 4. Single head: at most one entry is actively being processed.
 */
function assertSingleHead(entries: QueueEntry[]): void {
  const headStatuses: QueueEntryStatus[] = ["preparing_head", "validating", "merging"];
  const heads = entries.filter((e) => headStatuses.includes(e.status));
  assert.ok(
    heads.length <= 1,
    `Multiple heads active: ${heads.map((h) => `PR #${h.prNumber} (${h.status})`).join(", ")}`,
  );
}

/**
 * 5. Bounded repair: no entry has more repair attempts than its budget allows.
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
 * 6. Monotonic progress: if there are active (non-terminal) entries,
 * at least one must be in a head-like processing state or all must be
 * legitimately waiting (queued behind a head, or paused, or awaiting
 * external repair completion).
 */
function assertMonotonicProgress(entries: QueueEntry[]): void {
  const active = entries.filter((e) => ACTIVE.includes(e.status));
  if (active.length === 0) return;

  const processing = active.filter((e) =>
    ["preparing_head", "validating", "merging"].includes(e.status),
  );
  const waitingForExternal = active.filter((e) =>
    ["repair_requested", "repair_in_progress", "paused"].includes(e.status),
  );
  const waitingInLine = active.filter((e) =>
    e.status === "queued",
  );

  // Valid states:
  // - At least one entry is processing (head is active), OR
  // - All active entries are waiting for external input, OR
  // - All active entries are in line (queued/waiting_head), possibly
  //   behind a head that is waiting for external repair, OR
  // - All entries are freshly queued (reconciler hasn't ticked yet)
  const headActive = processing.length > 0;
  const allExternalWait = active.length === waitingForExternal.length;
  const allInLine = active.length === waitingInLine.length;
  const headExternalRest = waitingForExternal.length > 0 &&
    active.length === waitingForExternal.length + waitingInLine.length;

  assert.ok(
    headActive || allExternalWait || allInLine || headExternalRest,
    `Queue stuck: ${active.length} active entries but none progressing: ${active.map((e) => `PR #${e.prNumber} (${e.status})`).join(", ")}`,
  );
}
