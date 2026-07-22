import assert from "node:assert/strict";
import test from "node:test";
import { resolveRetryTarget } from "../src/manual-issue-actions.ts";

test("manual retry treats approved awaiting_queue PRs as queue repair", () => {
  const retryTarget = resolveRetryTarget({
    prNumber: 1125,
    prState: "open",
    prReviewState: "approved",
    prCheckStatus: "pending",
    workflowOutcome: undefined,
    lastRunType: "queue_repair",
    lastGitHubFailureSource: undefined,
  });

  assert.deepEqual(retryTarget, {
    runType: "queue_repair",
  });
});

test("manual retry keeps ordinary open PRs on implementation retry", () => {
  const retryTarget = resolveRetryTarget({
    prNumber: 12,
    prState: "open",
    prReviewState: "review_required",
    prCheckStatus: "pending",
    workflowOutcome: undefined,
    lastRunType: "implementation",
    lastGitHubFailureSource: undefined,
  });

  assert.deepEqual(retryTarget, {
    runType: "implementation",
  });
});
