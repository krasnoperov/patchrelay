import assert from "node:assert/strict";
import test from "node:test";
import type { QueueEntry, QueueEntryStatus } from "../src/types.ts";
import { ciStatusIcon, specChainLabel } from "../src/watch/format.ts";
import { buildChainEntries, buildDisplayEntries } from "../src/watch/display-filter.ts";

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

// ─── Display filter ─────────────────────────────────────────────

test("active filter includes active entries and recently-merged entries", () => {
  const merged = makeEntry({ prNumber: 1, position: 1, status: "merged", updatedAt: new Date().toISOString() });
  const active1 = makeEntry({ prNumber: 2, position: 2, status: "validating", ciRunId: "ci-2" });
  const active2 = makeEntry({ prNumber: 3, position: 3, status: "queued" });

  const result = buildDisplayEntries([merged, active1, active2], "active");

  assert.strictEqual(result.length, 3);
  assert.strictEqual(result[0]!.prNumber, 1, "merged first by position");
  assert.strictEqual(result[1]!.prNumber, 2);
  assert.strictEqual(result[2]!.prNumber, 3);
});

test("active filter excludes terminal entries older than 60 seconds", () => {
  const old = makeEntry({
    prNumber: 1, position: 1, status: "merged",
    updatedAt: new Date(Date.now() - 90_000).toISOString(),
  });
  const active = makeEntry({ prNumber: 2, position: 2, status: "validating", ciRunId: "ci-2" });

  const result = buildDisplayEntries([old, active], "active");

  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0]!.prNumber, 2);
});

test("active filter keeps old evicted entries visible because they still need repair", () => {
  const oldEvicted = makeEntry({
    prNumber: 1, position: 1, status: "evicted",
    updatedAt: new Date(Date.now() - 90_000).toISOString(),
  });
  const active = makeEntry({ prNumber: 2, position: 2, status: "validating", ciRunId: "ci-2" });

  const result = buildDisplayEntries([oldEvicted, active], "active");

  assert.strictEqual(result.length, 2);
  assert.strictEqual(result[0]!.prNumber, 1);
  assert.strictEqual(result[0]!.status, "evicted");
  assert.strictEqual(result[1]!.prNumber, 2);
});

test("re-admitted PR shows active entry, not terminal", () => {
  const evicted = makeEntry({
    prNumber: 1, position: 1, status: "evicted",
    id: "qe-old-1" as string,
    updatedAt: new Date().toISOString(),
  });
  const reAdmitted = makeEntry({
    prNumber: 1, position: 4, status: "validating",
    id: "qe-new-1" as string,
    ciRunId: "ci-new",
  });
  const active2 = makeEntry({ prNumber: 2, position: 2, status: "validating", ciRunId: "ci-2" });

  const result = buildDisplayEntries([evicted, reAdmitted, active2], "active");

  assert.strictEqual(result.length, 2, "no duplicate PR");
  const pr1 = result.find((e) => e.prNumber === 1);
  assert.ok(pr1);
  assert.strictEqual(pr1!.id, "qe-new-1", "active wins over terminal");
  assert.strictEqual(pr1!.status, "validating");
});

test("active filter hides old evicted attempts when a newer merged attempt exists for the same PR", () => {
  const evicted = makeEntry({
    prNumber: 1,
    position: 1,
    status: "evicted",
    id: "qe-old-1" as string,
    updatedAt: new Date(Date.now() - 90_000).toISOString(),
  });
  const merged = makeEntry({
    prNumber: 1,
    position: 4,
    status: "merged",
    id: "qe-new-1" as string,
    updatedAt: new Date().toISOString(),
  });
  const active = makeEntry({ prNumber: 2, position: 5, status: "validating", ciRunId: "ci-2" });

  const result = buildDisplayEntries([evicted, merged, active], "active");

  assert.strictEqual(result.length, 2, "superseded evicted row hidden");
  const pr1 = result.find((entry) => entry.prNumber === 1);
  assert.ok(pr1);
  assert.strictEqual(pr1!.id, "qe-new-1");
  assert.strictEqual(pr1!.status, "merged");
});

test("all filter returns everything unfiltered", () => {
  const merged = makeEntry({ prNumber: 1, position: 1, status: "merged" });
  const active = makeEntry({ prNumber: 2, position: 2, status: "validating", ciRunId: "ci-2" });

  const result = buildDisplayEntries([merged, active], "all");

  assert.strictEqual(result.length, 2);
});

// ─── CI status icons ────────────────────────────────────────────

test("ciStatusIcon returns correct icons for each status", () => {
  assert.strictEqual(ciStatusIcon({ status: "merged", ciRunId: null }).icon, "\u2713");
  assert.strictEqual(ciStatusIcon({ status: "merged", ciRunId: null }).color, "green");
  assert.strictEqual(ciStatusIcon({ status: "merging", ciRunId: null }).icon, "\u2713");
  assert.strictEqual(ciStatusIcon({ status: "validating", ciRunId: "ci-1" }).icon, "\u25cf");
  assert.strictEqual(ciStatusIcon({ status: "validating", ciRunId: "ci-1" }).color, "cyan");
  assert.strictEqual(ciStatusIcon({ status: "validating", ciRunId: null }).icon, "\u25cb");
  assert.strictEqual(ciStatusIcon({ status: "queued", ciRunId: null }).icon, "\u25cb");
  assert.strictEqual(ciStatusIcon({ status: "evicted", ciRunId: null }).icon, "\u2717");
  assert.strictEqual(ciStatusIcon({ status: "evicted", ciRunId: null }).color, "red");
});

// ─── Chain header (always live queue) ────────────────────────────

test("buildChainEntries excludes old terminal entries even when passed all history", () => {
  const oldMerged = makeEntry({
    prNumber: 1, position: 1, status: "merged",
    updatedAt: new Date(Date.now() - 120_000).toISOString(), // 2 min ago
  });
  const active = makeEntry({ prNumber: 2, position: 2, status: "validating", ciRunId: "ci-2" });
  const oldEvicted = makeEntry({
    prNumber: 3, position: 3, status: "evicted",
    updatedAt: new Date(Date.now() - 120_000).toISOString(),
  });

  const chain = buildChainEntries([oldMerged, active, oldEvicted]);

  assert.strictEqual(chain.length, 1, "only active entry in chain");
  assert.strictEqual(chain[0]!.prNumber, 2);
});

test("buildChainEntries includes recently-merged for cascade visibility", () => {
  const recentMerged = makeEntry({
    prNumber: 1, position: 1, status: "merged",
    updatedAt: new Date(Date.now() - 30_000).toISOString(), // 30s ago
  });
  const active = makeEntry({ prNumber: 2, position: 2, status: "validating", ciRunId: "ci-2" });

  const chain = buildChainEntries([recentMerged, active]);

  assert.strictEqual(chain.length, 2, "recent merged + active");
  assert.strictEqual(chain[0]!.prNumber, 1);
  assert.strictEqual(chain[1]!.prNumber, 2);
});

test("buildChainEntries prefers the newest queue attempt for a PR", () => {
  const oldEvicted = makeEntry({
    prNumber: 1,
    position: 1,
    status: "evicted",
    id: "qe-old-1" as string,
    updatedAt: new Date().toISOString(),
  });
  const recentMerged = makeEntry({
    prNumber: 1,
    position: 4,
    status: "merged",
    id: "qe-new-1" as string,
    updatedAt: new Date().toISOString(),
  });
  const active = makeEntry({ prNumber: 2, position: 5, status: "validating", ciRunId: "ci-2" });

  const chain = buildChainEntries([oldEvicted, recentMerged, active]);

  assert.strictEqual(chain.length, 2);
  assert.strictEqual(chain[0]!.id, "qe-new-1");
  assert.strictEqual(chain[0]!.status, "merged");
});

// ─── Spec chain label ───────────────────────────────────────────

test("specChainLabel shows main as base for head entry", () => {
  const entry = { specBranch: "mq-spec-1", specBasedOn: null, specSha: "abc1234567" };
  assert.strictEqual(specChainLabel(entry, []), "abc1234 \u2190 main");
});

test("specChainLabel shows parent PR number for non-head entry", () => {
  const entries = [{ id: "qe-1", prNumber: 110, specBranch: "mq-spec-1" }];
  const entry = { specBranch: "mq-spec-2", specBasedOn: "qe-1", specSha: "def5678901" };
  assert.strictEqual(specChainLabel(entry, entries), "def5678 \u2190 #110");
});

test("specChainLabel returns 'no spec yet' when no spec branch", () => {
  const entry = { specBranch: null, specBasedOn: null, specSha: null };
  assert.strictEqual(specChainLabel(entry, []), "no spec yet");
});
