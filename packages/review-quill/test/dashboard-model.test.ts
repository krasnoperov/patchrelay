import assert from "node:assert/strict";
import test from "node:test";
import { getLatestAttemptsByPullRequest } from "../src/attempt-summary.ts";
import { getRecentActivity, getRepoHealth, getReviewQueueText, projectStatsSummary } from "../src/watch/dashboard-model.ts";
import type { ReviewAttemptRecord, ReviewQuillRepoSummary, ReviewQuillWatchSnapshot, WebhookEventRecord } from "../src/types.ts";

function fakeAttempt(overrides: Partial<ReviewAttemptRecord> = {}): ReviewAttemptRecord {
  return {
    id: 1,
    repoFullName: "krasnoperov/ballony-i-nasosy",
    prNumber: 55,
    headSha: "head-sha",
    status: "completed",
    conclusion: "approved",
    createdAt: "2026-04-09T20:00:00.000Z",
    updatedAt: "2026-04-09T20:01:00.000Z",
    ...overrides,
  };
}

function fakeRepo(overrides: Partial<ReviewQuillRepoSummary> = {}): ReviewQuillRepoSummary {
  return {
    repoId: "ballony-i-nasosy",
    repoFullName: "krasnoperov/ballony-i-nasosy",
    baseBranch: "main",
    totalAttempts: 1,
    queuedAttempts: 0,
    runningAttempts: 0,
    completedAttempts: 1,
    failedAttempts: 0,
    latestAttemptAt: "2026-04-09T20:01:00.000Z",
    latestConclusion: "approved",
    ...overrides,
  };
}

function fakeWebhook(overrides: Partial<WebhookEventRecord> = {}): WebhookEventRecord {
  return {
    deliveryId: "delivery-1",
    eventType: "check_run",
    repoFullName: "krasnoperov/ballony-i-nasosy",
    receivedAt: "2026-04-09T20:05:00.000Z",
    processedAt: "2026-04-09T20:05:01.000Z",
    ...overrides,
  };
}

function fakeSnapshot(params: {
  repos?: ReviewQuillRepoSummary[];
  attempts?: ReviewAttemptRecord[];
  recentWebhooks?: WebhookEventRecord[];
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
      lastReconcileStartedAt: "2026-04-09T20:05:00.000Z",
      lastReconcileCompletedAt: "2026-04-09T20:05:01.000Z",
      lastReconcileOutcome: "succeeded",
      lastReconcileError: null,
    },
    repos: params.repos ?? [fakeRepo()],
    attempts: params.attempts ?? [],
    recentWebhooks: params.recentWebhooks ?? [],
  };
}

test("getLatestAttemptsByPullRequest keeps only the latest attempt per repo PR", () => {
  const attempts = getLatestAttemptsByPullRequest([
    fakeAttempt({ id: 1, prNumber: 55, status: "failed", conclusion: "error", updatedAt: "2026-04-09T20:00:00.000Z" }),
    fakeAttempt({ id: 2, prNumber: 55, status: "completed", conclusion: "approved", updatedAt: "2026-04-09T20:02:00.000Z" }),
    fakeAttempt({ id: 3, repoFullName: "krasnoperov/blog", prNumber: 12, updatedAt: "2026-04-09T20:01:00.000Z" }),
  ]);

  assert.equal(attempts.length, 2);
  assert.equal(attempts[0]?.id, 2);
  assert.equal(attempts[1]?.id, 3);
});

test("repo health ignores older failed attempts once the same PR was later approved", () => {
  const repo = fakeRepo();
  const snapshot = fakeSnapshot({
    repos: [repo],
    attempts: [
      fakeAttempt({ id: 1, prNumber: 55, status: "failed", conclusion: "error", updatedAt: "2026-04-09T20:00:00.000Z", summary: "older failure" }),
      fakeAttempt({ id: 2, prNumber: 55, status: "completed", conclusion: "approved", updatedAt: "2026-04-09T20:03:00.000Z" }),
    ],
  });

  const health = getRepoHealth(snapshot, repo);
  assert.equal(health.kind, "idle");
  assert.match(health.detail, /approved PR #55/);
});

test("recent activity prefers latest review attempts over raw webhook spam", () => {
  const repo = fakeRepo();
  const snapshot = fakeSnapshot({
    repos: [repo],
    attempts: [fakeAttempt({ id: 22, prNumber: 55, status: "running", updatedAt: "2026-04-09T20:04:00.000Z" })],
    recentWebhooks: [
      fakeWebhook({ deliveryId: "delivery-1", eventType: "check_run" }),
      fakeWebhook({ deliveryId: "delivery-2", eventType: "check_suite", receivedAt: "2026-04-09T20:04:30.000Z" }),
    ],
  });

  const items = getRecentActivity(snapshot, new Map([[repo.repoFullName, repo]]));
  assert.equal(items[0]?.message, "ballony-i-nasosy PR #55 running");
});

test("repo health summarizes webhook bursts when no review attempts exist yet", () => {
  const repo = fakeRepo({
    totalAttempts: 0,
    completedAttempts: 0,
    latestAttemptAt: null,
    latestConclusion: null,
  });
  const snapshot = fakeSnapshot({
    repos: [repo],
    attempts: [],
    recentWebhooks: [
      fakeWebhook({ deliveryId: "delivery-1", eventType: "check_run" }),
      fakeWebhook({ deliveryId: "delivery-2", eventType: "check_run", receivedAt: "2026-04-09T20:04:30.000Z" }),
      fakeWebhook({ deliveryId: "delivery-3", eventType: "check_suite", receivedAt: "2026-04-09T20:04:00.000Z" }),
    ],
  });

  const health = getRepoHealth(snapshot, repo);
  assert.equal(health.kind, "idle");
  assert.match(health.detail, /Recent wakeups: 2 check_run, 1 check_suite/);
});

test("repo health treats webhook activity after the last verdict as waiting on a newer head", () => {
  const repo = fakeRepo({
    latestConclusion: "declined",
    latestAttemptAt: "2026-04-09T20:01:00.000Z",
  });
  const snapshot = fakeSnapshot({
    repos: [repo],
    attempts: [
      fakeAttempt({
        id: 4,
        prNumber: 57,
        conclusion: "declined",
        updatedAt: "2026-04-09T20:01:00.000Z",
      }),
    ],
    recentWebhooks: [
      fakeWebhook({
        deliveryId: "delivery-new-head",
        eventType: "pull_request",
        receivedAt: "2026-04-09T20:02:00.000Z",
      }),
    ],
  });

  const health = getRepoHealth(snapshot, repo);
  assert.equal(health.kind, "idle");
  assert.match(health.detail, /waiting for the latest head to become eligible/i);
});

test("review dashboard does not count stale attempts as active work", () => {
  const repo = fakeRepo({
    runningAttempts: 1,
    latestAttemptAt: "2026-04-09T20:03:00.000Z",
    latestConclusion: null,
  });
  const snapshot = fakeSnapshot({
    repos: [repo],
    attempts: [
      fakeAttempt({
        id: 9,
        prNumber: 15,
        status: "running",
        conclusion: undefined,
        updatedAt: "2026-04-09T20:03:00.000Z",
        stale: true,
        staleReason: "Attempt was left running across a restart.",
      }),
    ],
  });

  assert.equal(projectStatsSummary(snapshot, repo), "0 active · 0 queued · 1 stale");
  assert.match(getReviewQueueText(snapshot, repo), /stale attempt/i);
});
