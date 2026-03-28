import assert from "node:assert/strict";
import type { QueueEntry, QueueEntryStatus } from "../src/types.ts";
import { TERMINAL_STATUSES } from "../src/types.ts";

const TERMINAL = TERMINAL_STATUSES;
const ACTIVE: QueueEntryStatus[] = [
  "queued",
  "preparing_head",
  "validating",
  "merging",
];

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
  assertBoundedRetries(entries);
  assertMonotonicProgress(entries);
}

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

function assertSingleHead(entries: QueueEntry[]): void {
  const headStatuses: QueueEntryStatus[] = ["preparing_head", "validating", "merging"];
  const heads = entries.filter((e) => headStatuses.includes(e.status));
  assert.ok(
    heads.length <= 1,
    `Multiple heads active: ${heads.map((h) => `PR #${h.prNumber} (${h.status})`).join(", ")}`,
  );
}

function assertBoundedRetries(entries: QueueEntry[]): void {
  for (const entry of entries) {
    assert.ok(
      entry.retryAttempts <= entry.maxRetries,
      `PR #${entry.prNumber} exceeded retry budget: ${entry.retryAttempts} > ${entry.maxRetries}`,
    );
  }
}

function assertMonotonicProgress(entries: QueueEntry[]): void {
  const active = entries.filter((e) => ACTIVE.includes(e.status));
  if (active.length === 0) return;

  const processing = active.filter((e) =>
    ["preparing_head", "validating", "merging"].includes(e.status),
  );
  const waitingInLine = active.filter((e) =>
    e.status === "queued",
  );

  // Valid: at least one entry is processing, or all are freshly queued.
  const headActive = processing.length > 0;
  const allInLine = active.length === waitingInLine.length;

  assert.ok(
    headActive || allInLine,
    `Queue stuck: ${active.length} active entries but none progressing: ${active.map((e) => `PR #${e.prNumber} (${e.status})`).join(", ")}`,
  );
}
