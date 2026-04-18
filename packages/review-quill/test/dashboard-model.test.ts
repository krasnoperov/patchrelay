import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDashboard,
  clipSummary,
  stepRepo,
} from "../src/watch/dashboard-model.ts";
import type {
  ReviewAttemptRecord,
  ReviewQuillPendingReview,
  ReviewQuillRepoSummary,
  ReviewQuillWatchSnapshot,
} from "../src/types.ts";

const NOW = Date.parse("2026-04-17T12:00:00.000Z");

function fakeAttempt(overrides: Partial<ReviewAttemptRecord> = {}): ReviewAttemptRecord {
  return {
    id: 1,
    repoFullName: "owner/repo-a",
    prNumber: 55,
    headSha: "head-sha",
    status: "completed",
    conclusion: "approved",
    createdAt: "2026-04-17T11:00:00.000Z",
    updatedAt: "2026-04-17T11:30:00.000Z",
    ...overrides,
  };
}

function fakeRepo(overrides: Partial<ReviewQuillRepoSummary> = {}): ReviewQuillRepoSummary {
  return {
    repoId: "repo-a",
    repoFullName: "owner/repo-a",
    baseBranch: "main",
    totalAttempts: 0,
    queuedAttempts: 0,
    runningAttempts: 0,
    completedAttempts: 0,
    failedAttempts: 0,
    latestAttemptAt: null,
    latestConclusion: null,
    ...overrides,
  };
}

function fakeSnapshot(params: {
  repos?: ReviewQuillRepoSummary[];
  attempts?: ReviewAttemptRecord[];
  pendingReviews?: ReviewQuillPendingReview[];
} = {}): ReviewQuillWatchSnapshot {
  return {
    summary: {
      totalRepos: params.repos?.length ?? 1,
      totalAttempts: params.attempts?.length ?? 0,
      queuedAttempts: 0,
      runningAttempts: 0,
      completedAttempts: 0,
      failedAttempts: 0,
    },
    runtime: {
      reconcileInProgress: false,
      lastReconcileStartedAt: null,
      lastReconcileCompletedAt: null,
      lastReconcileOutcome: "idle",
      lastReconcileError: null,
    },
    repos: params.repos ?? [fakeRepo()],
    attempts: params.attempts ?? [],
    recentWebhooks: [],
    pendingReviews: params.pendingReviews ?? [],
  };
}

test("PR token color matches glyph color for each kind", () => {
  const repo = fakeRepo();
  const snapshot = fakeSnapshot({
    repos: [repo],
    attempts: [
      fakeAttempt({ id: 1, prNumber: 1, status: "completed", conclusion: "approved", updatedAt: "2026-04-17T11:50:00.000Z" }),
      fakeAttempt({ id: 2, prNumber: 2, status: "completed", conclusion: "declined", updatedAt: "2026-04-17T11:51:00.000Z" }),
      fakeAttempt({ id: 3, prNumber: 3, status: "running", conclusion: undefined, updatedAt: "2026-04-17T11:55:00.000Z" }),
    ],
  });

  const model = buildDashboard(snapshot, { now: NOW });
  const [only] = model.repos;
  assert.ok(only);
  const byPr = new Map(only!.tokens.map((token) => [token.prNumber, token]));
  assert.equal(byPr.get(1)?.color, "green");
  assert.equal(byPr.get(1)?.glyph, "\u2713");
  assert.equal(byPr.get(2)?.color, "red");
  assert.equal(byPr.get(2)?.glyph, "\u2717");
  assert.equal(byPr.get(3)?.color, "yellow");
  assert.equal(byPr.get(3)?.glyph, "\u25cf");
});

test("tokens order: running then queued then decided, newest decided first", () => {
  const repo = fakeRepo();
  const snapshot = fakeSnapshot({
    repos: [repo],
    attempts: [
      fakeAttempt({ id: 10, prNumber: 10, status: "completed", conclusion: "approved", updatedAt: "2026-04-17T11:00:00.000Z" }),
      fakeAttempt({ id: 11, prNumber: 11, status: "completed", conclusion: "declined", updatedAt: "2026-04-17T11:30:00.000Z" }),
      fakeAttempt({ id: 12, prNumber: 12, status: "queued", conclusion: undefined, updatedAt: "2026-04-17T11:40:00.000Z" }),
      fakeAttempt({ id: 13, prNumber: 13, status: "running", conclusion: undefined, updatedAt: "2026-04-17T11:45:00.000Z" }),
    ],
  });

  const model = buildDashboard(snapshot, { now: NOW });
  const [only] = model.repos;
  assert.deepEqual(only?.tokens.map((t) => t.prNumber), [13, 12, 11, 10]);
});

test("decided PRs outside the time window are dropped but running/queued always stay", () => {
  const repo = fakeRepo();
  const snapshot = fakeSnapshot({
    repos: [repo],
    attempts: [
      fakeAttempt({ id: 1, prNumber: 1, status: "completed", conclusion: "approved", updatedAt: "2026-04-14T00:00:00.000Z" }),
      fakeAttempt({ id: 2, prNumber: 2, status: "queued", conclusion: undefined, updatedAt: "2026-04-10T00:00:00.000Z" }),
    ],
  });

  const model = buildDashboard(snapshot, { now: NOW, windowMs: 24 * 60 * 60 * 1000 });
  const tokens = model.repos[0]?.tokens ?? [];
  assert.deepEqual(tokens.map((t) => t.prNumber), [2]);
  assert.equal(tokens[0]?.kind, "queued");
});

test("pending reviews render as checks tokens and are shadowed by an existing running attempt", () => {
  const repo = fakeRepo();
  const snapshot = fakeSnapshot({
    repos: [repo],
    attempts: [
      fakeAttempt({ id: 1, prNumber: 7, status: "running", conclusion: undefined, updatedAt: "2026-04-17T11:50:00.000Z" }),
    ],
    pendingReviews: [
      {
        repoId: repo.repoId,
        repoFullName: repo.repoFullName,
        prNumber: 7,
        headSha: "sha",
        headRefName: "feature/x",
        reason: "checks_running",
        failedChecks: [],
        pendingChecks: ["ci"],
        updatedAt: "2026-04-17T11:55:00.000Z",
      },
      {
        repoId: repo.repoId,
        repoFullName: repo.repoFullName,
        prNumber: 9,
        headSha: "sha9",
        headRefName: "feature/y",
        reason: "checks_running",
        failedChecks: [],
        pendingChecks: ["ci"],
        updatedAt: "2026-04-17T11:56:00.000Z",
      },
    ],
  });

  const model = buildDashboard(snapshot, { now: NOW });
  const tokens = model.repos[0]?.tokens ?? [];
  const byPr = new Map(tokens.map((token) => [token.prNumber, token.kind]));
  assert.equal(byPr.get(7), "running");
  assert.equal(byPr.get(9), "checks_running");
});

test("stale attempt renders as error glyph", () => {
  const repo = fakeRepo();
  const snapshot = fakeSnapshot({
    repos: [repo],
    attempts: [
      fakeAttempt({
        id: 1,
        prNumber: 42,
        status: "running",
        conclusion: undefined,
        stale: true,
        staleReason: "worker restart",
        updatedAt: "2026-04-17T11:50:00.000Z",
      }),
    ],
  });

  const tokens = buildDashboard(snapshot, { now: NOW }).repos[0]?.tokens ?? [];
  assert.equal(tokens[0]?.kind, "error");
  assert.equal(tokens[0]?.glyph, "\u26a0");
  assert.equal(tokens[0]?.color, "red");
});

test("active repos sort before quiet repos; quietCount reflects the quiet ones", () => {
  const active = fakeRepo({ repoId: "active", repoFullName: "owner/active" });
  const quiet = fakeRepo({ repoId: "quiet", repoFullName: "owner/quiet" });
  const snapshot = fakeSnapshot({
    repos: [quiet, active],
    attempts: [
      fakeAttempt({ id: 1, repoFullName: active.repoFullName, prNumber: 1, status: "running", conclusion: undefined, updatedAt: "2026-04-17T11:50:00.000Z" }),
    ],
  });

  const model = buildDashboard(snapshot, { now: NOW });
  assert.equal(model.repos.length, 2);
  assert.equal(model.repos[0]?.repoFullName, active.repoFullName);
  assert.equal(model.repos[0]?.hasActivity, true);
  assert.equal(model.repos[1]?.repoFullName, quiet.repoFullName);
  assert.equal(model.repos[1]?.hasActivity, false);
  assert.equal(model.quietCount, 1);
});

test("cancelled and superseded PRs do not populate the strip", () => {
  const repo = fakeRepo();
  const snapshot = fakeSnapshot({
    repos: [repo],
    attempts: [
      fakeAttempt({ id: 1, prNumber: 1, status: "cancelled", conclusion: undefined, updatedAt: "2026-04-17T11:50:00.000Z" }),
      fakeAttempt({ id: 2, prNumber: 2, status: "superseded", conclusion: undefined, updatedAt: "2026-04-17T11:50:00.000Z" }),
    ],
  });

  const model = buildDashboard(snapshot, { now: NOW });
  assert.equal(model.repos.length, 1);
  assert.equal(model.repos[0]?.tokens.length, 0);
  assert.equal(model.repos[0]?.hasActivity, false);
  assert.equal(model.quietCount, 1);
});

test("stepRepo cycles through repos in both directions", () => {
  const repos = [
    { repoFullName: "a", repoId: "a", tokens: [], entries: [], latestActivityAt: 0, hasActivity: true },
    { repoFullName: "b", repoId: "b", tokens: [], entries: [], latestActivityAt: 0, hasActivity: true },
    { repoFullName: "c", repoId: "c", tokens: [], entries: [], latestActivityAt: 0, hasActivity: true },
  ];
  assert.equal(stepRepo(repos, "a", 1), "b");
  assert.equal(stepRepo(repos, "c", 1), "a");
  assert.equal(stepRepo(repos, "a", -1), "c");
  assert.equal(stepRepo(repos, null, 1), "b");
});

test("clipSummary cuts on a sentence boundary and never appends an ellipsis", () => {
  const summary = "Queue planner refactor. All reconcile tests pass. Extra context about the shape of the change that could not fit.";
  const clipped = clipSummary(summary, { maxLines: 2, width: 40 });
  assert.ok(!clipped.includes("\u2026"));
  assert.ok(!clipped.endsWith("..."));
  assert.ok(clipped.length > 0);
  assert.ok(clipped.length <= summary.length);
  const lines = clipped.split("\n");
  assert.ok(lines.length <= 2, `expected <=2 lines, got ${lines.length}`);
});

test("clipSummary returns empty string when summary is missing or blank", () => {
  assert.equal(clipSummary(undefined, { maxLines: 2, width: 60 }), "");
  assert.equal(clipSummary("   \n\t  ", { maxLines: 2, width: 60 }), "");
});
