import assert from "node:assert/strict";
import test from "node:test";
import type { QueueEntry, QueueWatchSnapshot, QueueEntryStatus } from "../src/types.ts";
import { getRepoHealth, projectStatsSummary, type DashboardRepoState } from "../src/watch/dashboard-model.ts";

function makeEntry(overrides: Partial<QueueEntry> & { prNumber: number; position: number; status: QueueEntryStatus }): QueueEntry {
  return {
    id: `qe-${overrides.prNumber}-${overrides.position}`,
    repoId: "ballony-i-nasosy",
    branch: `feat-${overrides.prNumber}`,
    headSha: `head-${overrides.prNumber}-${overrides.position}`,
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

function makeSnapshot(entries: QueueEntry[]): QueueWatchSnapshot {
  return {
    repoId: "ballony-i-nasosy",
    repoFullName: "krasnoperov/ballony-i-nasosy",
    baseBranch: "main",
    summary: {
      total: entries.length,
      active: entries.filter((entry) => !["merged", "evicted", "dequeued"].includes(entry.status)).length,
      queued: entries.filter((entry) => entry.status === "queued").length,
      preparingHead: entries.filter((entry) => entry.status === "preparing_head").length,
      validating: entries.filter((entry) => entry.status === "validating").length,
      merging: entries.filter((entry) => entry.status === "merging").length,
      merged: entries.filter((entry) => entry.status === "merged").length,
      evicted: entries.filter((entry) => entry.status === "evicted").length,
      dequeued: entries.filter((entry) => entry.status === "dequeued").length,
      headEntryId: null,
      headPrNumber: null,
    },
    runtime: {
      tickInProgress: false,
      lastTickStartedAt: null,
      lastTickCompletedAt: new Date().toISOString(),
      lastTickOutcome: "succeeded",
      lastTickError: null,
    },
    queueBlock: null,
    entries,
    recentEvents: [],
  };
}

function makeRepo(snapshot: QueueWatchSnapshot): DashboardRepoState {
  return {
    repoId: snapshot.repoId,
    repoFullName: snapshot.repoFullName,
    baseBranch: snapshot.baseBranch,
    snapshot,
    error: null,
    lastSnapshotReceivedAt: Date.now(),
  };
}

test("repo health ignores an older evicted attempt when the same PR was later merged", () => {
  const evicted = makeEntry({
    prNumber: 49,
    position: 1,
    status: "evicted",
    updatedAt: new Date(Date.now() - 30_000).toISOString(),
  });
  const merged = makeEntry({
    prNumber: 49,
    position: 2,
    status: "merged",
    updatedAt: new Date().toISOString(),
  });
  const snapshot = makeSnapshot([evicted, merged]);

  const health = getRepoHealth(makeRepo(snapshot));

  assert.equal(health.kind, "idle");
  assert.doesNotMatch(health.detail, /was evicted and needs repair/i);
});

test("project stats only count unresolved latest evictions as need repair", () => {
  const supersededEvicted = makeEntry({
    prNumber: 49,
    position: 1,
    status: "evicted",
    updatedAt: new Date(Date.now() - 30_000).toISOString(),
  });
  const merged = makeEntry({
    prNumber: 49,
    position: 2,
    status: "merged",
    updatedAt: new Date().toISOString(),
  });
  const unresolvedEvicted = makeEntry({
    prNumber: 51,
    position: 3,
    status: "evicted",
    updatedAt: new Date().toISOString(),
  });
  const snapshot = makeSnapshot([supersededEvicted, merged, unresolvedEvicted]);

  const summary = projectStatsSummary(snapshot);

  assert.match(summary, /1 need repair/);
  assert.doesNotMatch(summary, /2 need repair/);
});
