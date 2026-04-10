import assert from "node:assert/strict";
import test from "node:test";
import type { QueueEntry, QueueWatchSnapshot, QueueEntryStatus } from "../src/types.ts";
import { buildQueueSummary, getRepoHealth, projectStatsSummary, type DashboardRepoState } from "../src/watch/dashboard-model.ts";

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

test("queue summary counts active and terminal entries by latest queue state", () => {
  const queued = makeEntry({
    prNumber: 60,
    position: 1,
    status: "queued",
  });
  const merged = makeEntry({
    prNumber: 61,
    position: 2,
    status: "merged",
  });
  const evicted = makeEntry({
    prNumber: 62,
    position: 3,
    status: "evicted",
  });

  const summary = buildQueueSummary([queued, merged, evicted]);

  assert.equal(summary.total, 3);
  assert.equal(summary.active, 1);
  assert.equal(summary.queued, 1);
  assert.equal(summary.merged, 1);
  assert.equal(summary.evicted, 1);
  assert.equal(summary.headPrNumber, 60);
});

test("idle repo health reports the most recent activity instead of the oldest queue history", () => {
  const oldMerged = makeEntry({
    prNumber: 10,
    position: 1,
    status: "merged",
    updatedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1_000).toISOString(),
  });
  const recentMerged = makeEntry({
    prNumber: 53,
    position: 2,
    status: "merged",
    updatedAt: new Date(Date.now() - 30_000).toISOString(),
  });
  const snapshot = makeSnapshot([oldMerged, recentMerged]);

  const health = getRepoHealth(makeRepo(snapshot));

  assert.equal(health.kind, "idle");
  assert.match(health.detail, /Last activity was 30s ago\./);
  assert.doesNotMatch(health.detail, /2d ago/);
});
