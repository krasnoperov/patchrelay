import assert from "node:assert/strict";
import test from "node:test";
import type { QueueEntry, QueueEntryStatus, QueueWatchSnapshot } from "../src/types.ts";
import {
  buildDashboard,
  buildQueueSummary,
  clipSummary,
  stepRepo,
  type DashboardRepoState,
} from "../src/watch/dashboard-model.ts";

const NOW = Date.parse("2026-04-17T12:00:00.000Z");

function minutesAgo(n: number): string {
  return new Date(NOW - n * 60_000).toISOString();
}

function makeEntry(overrides: Partial<QueueEntry> & { prNumber: number; position: number; status: QueueEntryStatus }): QueueEntry {
  return {
    id: `qe-${overrides.prNumber}-${overrides.position}`,
    repoId: "repo-a",
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
    postMergeStatus: null,
    postMergeSha: null,
    postMergeSummary: null,
    postMergeCheckedAt: null,
    enqueuedAt: minutesAgo(10),
    updatedAt: minutesAgo(5),
    ...overrides,
  };
}

function makeSnapshot(entries: QueueEntry[], queueBlock: QueueWatchSnapshot["queueBlock"] = null): QueueWatchSnapshot {
  return {
    repoId: "repo-a",
    repoFullName: "owner/repo-a",
    baseBranch: "main",
    githubPolicy: {
      requiredChecks: [],
      fetchedAt: null,
      lastRefreshReason: null,
      lastRefreshChanged: null,
    },
    summary: buildQueueSummary(entries),
    runtime: {
      tickInProgress: false,
      lastTickStartedAt: null,
      lastTickCompletedAt: minutesAgo(1),
      lastTickOutcome: "succeeded",
      lastTickError: null,
    },
    queueBlock,
    entries,
    recentEvents: [],
  };
}

function makeRepo(snapshot: QueueWatchSnapshot): DashboardRepoState {
  return {
    repoId: snapshot.repoId,
    repoFullName: snapshot.repoFullName,
    baseBranch: snapshot.baseBranch,
    serviceState: "ready",
    serviceMessage: null,
    snapshot,
    error: null,
    lastSnapshotReceivedAt: NOW,
  };
}

test("PR token color matches glyph color across queue kinds", () => {
  const snapshot = makeSnapshot([
    makeEntry({ prNumber: 1, position: 1, status: "validating" }),
    makeEntry({ prNumber: 2, position: 2, status: "queued" }),
    makeEntry({ prNumber: 3, position: 3, status: "merged", postMergeStatus: "pass", updatedAt: minutesAgo(30) }),
    makeEntry({ prNumber: 4, position: 4, status: "evicted", updatedAt: minutesAgo(20) }),
  ]);
  const model = buildDashboard([makeRepo(snapshot)], { now: NOW });
  const tokens = model.repos[0]?.tokens ?? [];
  const byPr = new Map(tokens.map((token) => [token.prNumber, token]));
  assert.equal(byPr.get(1)?.color, "yellow");
  assert.equal(byPr.get(1)?.glyph, "\u25cf");
  assert.equal(byPr.get(2)?.color, "gray");
  assert.equal(byPr.get(2)?.glyph, "\u25cb");
  assert.equal(byPr.get(3)?.color, "green");
  assert.equal(byPr.get(3)?.glyph, "\u2713");
  assert.equal(byPr.get(4)?.color, "red");
  assert.equal(byPr.get(4)?.glyph, "\u26a0");
});

test("running entries come first then queued then decided newest-first", () => {
  const snapshot = makeSnapshot([
    makeEntry({ prNumber: 10, position: 1, status: "merged", postMergeStatus: "pass", updatedAt: minutesAgo(90) }),
    makeEntry({ prNumber: 11, position: 2, status: "merged", postMergeStatus: "pass", updatedAt: minutesAgo(60) }),
    makeEntry({ prNumber: 12, position: 3, status: "queued", updatedAt: minutesAgo(10) }),
    makeEntry({ prNumber: 13, position: 4, status: "validating", updatedAt: minutesAgo(5) }),
  ]);
  const model = buildDashboard([makeRepo(snapshot)], { now: NOW });
  assert.deepEqual(
    model.repos[0]?.tokens.map((t) => t.prNumber),
    [13, 12, 11, 10],
  );
});

test("decided PRs older than the time window are dropped", () => {
  const snapshot = makeSnapshot([
    makeEntry({ prNumber: 20, position: 1, status: "merged", postMergeStatus: "pass", updatedAt: minutesAgo(60 * 48) }),
    makeEntry({ prNumber: 21, position: 2, status: "validating", updatedAt: minutesAgo(5) }),
  ]);
  const model = buildDashboard([makeRepo(snapshot)], { now: NOW });
  assert.deepEqual(
    model.repos[0]?.tokens.map((t) => t.prNumber),
    [21],
  );
});

test("queue block re-labels the head PR as main broken with red glyph", () => {
  const snapshot = makeSnapshot(
    [
      makeEntry({ prNumber: 30, position: 1, status: "merging" }),
      makeEntry({ prNumber: 31, position: 2, status: "queued" }),
    ],
    {
      reason: "main_broken",
      entryId: "qe-30-1",
      headPrNumber: 30,
      baseSha: "base",
      baseBranch: "main",
      observedAt: new Date().toISOString(),
      failingChecks: [{ name: "ci", conclusion: "failure" }],
      pendingChecks: [],
      missingRequiredChecks: [],
    },
  );
  const model = buildDashboard([makeRepo(snapshot)], { now: NOW });
  const head = model.repos[0]?.entries.find((entry) => entry.prNumber === 30);
  assert.equal(head?.kind, "error");
  assert.equal(head?.glyph, "\u26a0");
  assert.equal(head?.phrase, "main broken");
});

test("stale queue block does not relabel a conflicting head as main broken", () => {
  const snapshot = makeSnapshot(
    [
      makeEntry({
        id: "entry-current",
        prNumber: 31,
        position: 2,
        status: "preparing_head",
        lastFailedBaseSha: "base-after-conflict",
      }),
    ],
    {
      reason: "main_broken",
      entryId: "entry-old",
      headPrNumber: 30,
      baseBranch: "main",
      baseSha: "base-before-conflict",
      observedAt: new Date().toISOString(),
      failingChecks: [{ name: "Tests", conclusion: "failure" }],
      pendingChecks: [],
      missingRequiredChecks: [],
    },
  );

  const model = buildDashboard([makeRepo(snapshot)], { now: NOW });
  const head = model.repos[0]?.entries.find((entry) => entry.prNumber === 31);
  assert.equal(head?.kind, "running");
  assert.equal(head?.glyph, "\u25cf");
  assert.equal(head?.phrase, "has conflicts");
});

test("merged PR with failed post-merge CI becomes a red declined token", () => {
  const snapshot = makeSnapshot([
    makeEntry({
      prNumber: 40,
      position: 1,
      status: "merged",
      postMergeStatus: "fail",
      postMergeSummary: "required check `integration` failed on main",
      updatedAt: minutesAgo(30),
    }),
  ]);
  const entry = buildDashboard([makeRepo(snapshot)], { now: NOW }).repos[0]?.entries[0];
  assert.equal(entry?.kind, "declined");
  assert.equal(entry?.color, "red");
  assert.equal(entry?.phrase, "post-merge failed");
  assert.equal(entry?.summary, "required check `integration` failed on main");
});

test("dequeued entries do not appear in the dashboard", () => {
  const snapshot = makeSnapshot([
    makeEntry({ prNumber: 50, position: 1, status: "dequeued", updatedAt: minutesAgo(10) }),
    makeEntry({ prNumber: 51, position: 2, status: "queued", updatedAt: minutesAgo(5) }),
  ]);
  const model = buildDashboard([makeRepo(snapshot)], { now: NOW });
  const prs = model.repos[0]?.tokens.map((t) => t.prNumber) ?? [];
  assert.deepEqual(prs, [51]);
});

test("queued non-head entry gets a 'behind head' phrase", () => {
  const snapshot = makeSnapshot([
    makeEntry({ prNumber: 60, position: 1, status: "validating" }),
    makeEntry({ prNumber: 61, position: 2, status: "queued" }),
  ]);
  const entries = buildDashboard([makeRepo(snapshot)], { now: NOW }).repos[0]?.entries ?? [];
  const second = entries.find((entry) => entry.prNumber === 61);
  assert.equal(second?.phrase, "behind head");
});

test("offline repo renders an offline message instead of tokens", () => {
  const repos: DashboardRepoState[] = [
    {
      repoId: "repo-a",
      repoFullName: "owner/repo-a",
      baseBranch: "main",
      serviceState: "offline",
      serviceMessage: null,
      snapshot: null,
      error: "gateway unreachable",
      lastSnapshotReceivedAt: null,
    },
  ];
  const model = buildDashboard(repos, { now: NOW });
  assert.equal(model.repos.length, 1);
  assert.equal(model.repos[0]?.offlineMessage, "gateway unreachable");
  assert.equal(model.repos[0]?.tokens.length, 0);
});

test("stepRepo cycles through repos", () => {
  const repos = [
    { repoId: "a", repoFullName: "a", tokens: [], entries: [], latestActivityAt: 0, hasActivity: true, offlineMessage: null },
    { repoId: "b", repoFullName: "b", tokens: [], entries: [], latestActivityAt: 0, hasActivity: true, offlineMessage: null },
    { repoId: "c", repoFullName: "c", tokens: [], entries: [], latestActivityAt: 0, hasActivity: true, offlineMessage: null },
  ];
  assert.equal(stepRepo(repos, "a", 1), "b");
  assert.equal(stepRepo(repos, "c", 1), "a");
  assert.equal(stepRepo(repos, "a", -1), "c");
});

test("clipSummary cuts on a sentence boundary and never appends an ellipsis", () => {
  const summary = "Required check `integration` failed on main. Follow-up rollback opened. Further context that definitely will not fit.";
  const clipped = clipSummary(summary, { maxLines: 2, width: 40 });
  assert.ok(!clipped.includes("\u2026"));
  assert.ok(!clipped.endsWith("..."));
  assert.ok(clipped.length > 0);
  assert.ok(clipped.split("\n").length <= 2);
});

test("buildQueueSummary counts each PR once by queue state", () => {
  const queued = makeEntry({ prNumber: 100, position: 1, status: "queued" });
  const merged = makeEntry({ prNumber: 101, position: 2, status: "merged" });
  const evicted = makeEntry({ prNumber: 102, position: 3, status: "evicted" });
  const summary = buildQueueSummary([queued, merged, evicted]);
  assert.equal(summary.total, 3);
  assert.equal(summary.active, 1);
  assert.equal(summary.queued, 1);
  assert.equal(summary.merged, 1);
  assert.equal(summary.evicted, 1);
  assert.equal(summary.headPrNumber, 100);
});
