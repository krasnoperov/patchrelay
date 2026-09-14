import assert from "node:assert/strict";
import test from "node:test";
import { resolveRetryTarget } from "../src/manual-issue-actions.ts";

test("manual retry keeps approved awaiting_queue PRs in candidate integration", () => {
  const retryTarget = resolveRetryTarget({
    prNumber: 1125,
    prState: "open",
    prReviewState: "approved",
    prCheckStatus: "pending",
    workflowOutcome: undefined,
    lastRunType: "implementation",
    lastGitHubFailureSource: undefined,
  });

  assert.deepEqual(retryTarget, {
    runType: "integration_repair",
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

test("manual retry repairs red branch CI before freezing an approved PR", () => {
  const retryTarget = resolveRetryTarget({
    prNumber: 13,
    prState: "open",
    prReviewState: "approved",
    prCheckStatus: "failed",
    runnableTaskRunType: "ci_repair",
    lastRunType: "implementation",
    lastGitHubFailureSource: "branch_ci",
  });

  assert.deepEqual(retryTarget, { runType: "ci_repair" });
});
