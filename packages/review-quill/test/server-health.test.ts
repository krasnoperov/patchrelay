import assert from "node:assert/strict";
import test from "node:test";
import { buildReviewQuillHealth } from "../src/server.ts";
import type { GitHubAuthRuntimeStatus } from "../src/github-auth.ts";
import type { ReviewQuillRuntimeStatus } from "../src/types.ts";

function authStatus(overrides: Partial<GitHubAuthRuntimeStatus> = {}): GitHubAuthRuntimeStatus {
  return {
    ready: true,
    lastRefreshAt: "2026-05-23T10:34:34.059Z",
    lastRefreshError: null,
    recentAuthFailureCount: 0,
    lastAuthFailureAt: null,
    installations: [],
    ...overrides,
  };
}

function runtimeStatus(overrides: Partial<ReviewQuillRuntimeStatus> = {}): ReviewQuillRuntimeStatus {
  return {
    lastReconcileStartedAt: "2026-05-23T10:34:33.000Z",
    lastReconcileCompletedAt: "2026-05-23T10:34:35.000Z",
    lastReconcileOutcome: "succeeded",
    lastReconcileError: null,
    inFlightReviews: 0,
    repoLastReconciledAt: {},
    repoLastReconcileErrors: {},
    codexLimitedUntil: null,
    ...overrides,
  };
}

test("health stays ok after a recovered GitHub auth failure", () => {
  const health = buildReviewQuillHealth({
    repos: ["krasnoperov/blog"],
    authStatus: authStatus({
      recentAuthFailureCount: 1,
      lastAuthFailureAt: "2026-05-23T10:34:33.896Z",
    }),
    runtime: runtimeStatus(),
  });

  assert.equal(health.ok, true);
  assert.equal(health.status, "ok");
  assert.equal(health.auth.recentAuthFailureCount, 1);
});

test("health fails when live auth is not ready", () => {
  const health = buildReviewQuillHealth({
    repos: ["krasnoperov/blog"],
    authStatus: authStatus({
      ready: false,
      lastRefreshError: "GitHub API 401: Bad credentials",
    }),
    runtime: runtimeStatus(),
  });

  assert.equal(health.ok, false);
  assert.equal(health.status, "failed");
});

test("health degrades when the current reconcile is partially failing", () => {
  const health = buildReviewQuillHealth({
    repos: ["krasnoperov/blog"],
    authStatus: authStatus(),
    runtime: runtimeStatus({
      lastReconcileOutcome: "degraded",
      lastReconcileError: "krasnoperov/blog: GitHub API 500",
    }),
  });

  assert.equal(health.ok, false);
  assert.equal(health.status, "degraded");
});

test("health degrades and exposes the deadline while a Codex capacity pause is active", () => {
  const health = buildReviewQuillHealth({
    repos: ["krasnoperov/blog"],
    authStatus: authStatus(),
    runtime: runtimeStatus({
      codexLimitedUntil: "2026-06-11T03:23:42.000Z",
    }),
  });

  assert.equal(health.ok, false);
  assert.equal(health.status, "degraded");
  assert.equal(health.runtime.codexLimitedUntil, "2026-06-11T03:23:42.000Z");
});

test("health reports a null codexLimitedUntil when reviews run normally", () => {
  const health = buildReviewQuillHealth({
    repos: ["krasnoperov/blog"],
    authStatus: authStatus(),
    runtime: runtimeStatus(),
  });

  assert.equal(health.ok, true);
  assert.equal(health.runtime.codexLimitedUntil, null);
});
