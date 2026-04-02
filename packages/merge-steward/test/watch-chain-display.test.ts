import assert from "node:assert/strict";
import test from "node:test";
import type { QueueEntry, QueueEntryStatus } from "../src/types.ts";
import { TERMINAL_STATUSES } from "../src/types.ts";
import { ciStatusIcon, specChainLabel } from "../src/watch/format.ts";

function makeEntry(overrides: Partial<QueueEntry> & { prNumber: number; position: number; status: QueueEntryStatus }): QueueEntry {
  return {
    id: `qe-${overrides.prNumber}`,
    repoId: "repo-1",
    branch: `feat-${overrides.prNumber}`,
    headSha: `head-${overrides.prNumber}`,
    baseSha: "base-sha",
    priority: 0,
    generation: 0,
    ciRunId: null,
    ciRetries: 0,
    retryAttempts: 0,
    maxRetries: 2,
    lastFailedBaseSha: null,
    issueKey: null,
    specBranch: null,
    specSha: null,
    specBasedOn: null,
    enqueuedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

/** Mirror the chain-building logic from QueueListView. */
function buildChain(entries: QueueEntry[], recentlyCompleted: QueueEntry[]): QueueEntry[] {
  const seenPR = new Set<number>();
  const all: QueueEntry[] = [];
  for (const e of entries) {
    if (!TERMINAL_STATUSES.includes(e.status) && !seenPR.has(e.prNumber)) {
      all.push(e);
      seenPR.add(e.prNumber);
    }
  }
  for (const e of recentlyCompleted) {
    if (!seenPR.has(e.prNumber)) {
      all.push(e);
      seenPR.add(e.prNumber);
    }
  }
  return all.sort((a, b) => a.position - b.position);
}

// ─── Spec chain includes recently-completed entries ─────────────

test("chain includes active + recently merged entries sorted by position", () => {
  const merged = makeEntry({ prNumber: 1, position: 1, status: "merged", updatedAt: new Date().toISOString() });
  const active1 = makeEntry({ prNumber: 2, position: 2, status: "validating", ciRunId: "ci-2" });
  const active2 = makeEntry({ prNumber: 3, position: 3, status: "queued" });

  const chain = buildChain([active1, active2], [merged]);

  assert.strictEqual(chain.length, 3, "chain should include merged + 2 active");
  assert.strictEqual(chain[0]!.prNumber, 1, "merged entry first by position");
  assert.strictEqual(chain[1]!.prNumber, 2);
  assert.strictEqual(chain[2]!.prNumber, 3);
});

test("chain deduplicates by prNumber: re-admitted PR shows active entry, not terminal", () => {
  // PR #1 was evicted (terminal), then re-admitted with a new entry ID
  const evictedOld = makeEntry({
    prNumber: 1, position: 1, status: "evicted",
    id: "qe-old-1" as string,
    updatedAt: new Date().toISOString(),
  });
  const reAdmittedNew = makeEntry({
    prNumber: 1, position: 4, status: "validating",
    id: "qe-new-1" as string,
    ciRunId: "ci-new",
  });
  const active2 = makeEntry({ prNumber: 2, position: 2, status: "validating", ciRunId: "ci-2" });

  const chain = buildChain([reAdmittedNew, active2], [evictedOld]);

  // Should have 2 entries, not 3 — the old evicted #1 is superseded by re-admitted #1
  assert.strictEqual(chain.length, 2, "no duplicate PR in chain");
  const pr1 = chain.find((e) => e.prNumber === 1);
  assert.ok(pr1, "PR #1 should be in chain");
  assert.strictEqual(pr1!.id, "qe-new-1", "active re-admitted entry wins over terminal");
  assert.strictEqual(pr1!.status, "validating", "should show active status, not evicted");
});

// ─── Recently-completed filter ages out ─────────────────────────

test("recently-completed excludes entries older than 60 seconds", () => {
  const recent = makeEntry({
    prNumber: 1, position: 1, status: "merged",
    updatedAt: new Date(Date.now() - 30_000).toISOString(), // 30s ago
  });
  const old = makeEntry({
    prNumber: 2, position: 2, status: "merged",
    updatedAt: new Date(Date.now() - 90_000).toISOString(), // 90s ago
  });

  const allEntries = [recent, old];
  const cutoff = Date.now() - 60_000;
  const recentlyCompleted = allEntries.filter(
    (e) => TERMINAL_STATUSES.includes(e.status) && new Date(e.updatedAt).getTime() > cutoff,
  );

  assert.strictEqual(recentlyCompleted.length, 1, "only the 30s-old entry");
  assert.strictEqual(recentlyCompleted[0]!.prNumber, 1);
});

// ─── CI status icons ────────────────────────────────────────────

test("ciStatusIcon returns correct icons for each status", () => {
  assert.strictEqual(ciStatusIcon({ status: "merged", ciRunId: null }).icon, "\u2713");
  assert.strictEqual(ciStatusIcon({ status: "merged", ciRunId: null }).color, "green");
  assert.strictEqual(ciStatusIcon({ status: "merging", ciRunId: null }).icon, "\u2713");
  assert.strictEqual(ciStatusIcon({ status: "validating", ciRunId: "ci-1" }).icon, "\u25cf");  // ●
  assert.strictEqual(ciStatusIcon({ status: "validating", ciRunId: "ci-1" }).color, "cyan");
  assert.strictEqual(ciStatusIcon({ status: "validating", ciRunId: null }).icon, "\u25cb");     // ○
  assert.strictEqual(ciStatusIcon({ status: "queued", ciRunId: null }).icon, "\u25cb");
  assert.strictEqual(ciStatusIcon({ status: "evicted", ciRunId: null }).icon, "\u2717");
  assert.strictEqual(ciStatusIcon({ status: "evicted", ciRunId: null }).color, "red");
});

// ─── Spec chain label ───────────────────────────────────────────

test("specChainLabel shows main as base for head entry", () => {
  const entry = { specBranch: "mq-spec-1", specBasedOn: null, specSha: "abc1234567" };
  const label = specChainLabel(entry, []);
  assert.strictEqual(label, "abc1234 \u2190 main");
});

test("specChainLabel shows parent PR number for non-head entry", () => {
  const entries = [
    { id: "qe-1", prNumber: 110, specBranch: "mq-spec-1" },
  ];
  const entry = { specBranch: "mq-spec-2", specBasedOn: "qe-1", specSha: "def5678901" };
  const label = specChainLabel(entry, entries);
  assert.strictEqual(label, "def5678 \u2190 #110");
});

test("specChainLabel returns 'no spec yet' when no spec branch", () => {
  const entry = { specBranch: null, specBasedOn: null, specSha: null };
  assert.strictEqual(specChainLabel(entry, []), "no spec yet");
});
