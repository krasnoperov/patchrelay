import assert from "node:assert/strict";
import test from "node:test";
import { resolveRetryTarget } from "../src/manual-issue-actions.ts";

test("manual retry treats approved awaiting_queue PRs as queue repair", () => {
  const retryTarget = resolveRetryTarget({
    prNumber: 1125,
    prState: "open",
    prReviewState: "approved",
    prCheckStatus: "pending",
    factoryState: "awaiting_queue",
    lastRunType: "queue_repair",
    lastGitHubFailureSource: undefined,
  });

  assert.deepEqual(retryTarget, {
    runType: "queue_repair",
    factoryState: "repairing_queue",
  });
});

test("manual retry keeps ordinary open PRs on implementation retry", () => {
  const retryTarget = resolveRetryTarget({
    prNumber: 12,
    prState: "open",
    prReviewState: "review_required",
    prCheckStatus: "pending",
    factoryState: "pr_open",
    lastRunType: "implementation",
    lastGitHubFailureSource: undefined,
  });

  assert.deepEqual(retryTarget, {
    runType: "implementation",
    factoryState: "implementing",
  });
});
