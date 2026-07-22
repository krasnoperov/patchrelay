import assert from "node:assert/strict";
import test from "node:test";
import {
  deriveReactiveWorkflowIntent,
} from "../src/reactive-workflow-intent.ts";

test("reactive intent classifies actionable GitHub facts without declaring readiness", () => {
  assert.deepEqual(
    deriveReactiveWorkflowIntent({
      prNumber: 7,
      prState: "open",
      prHeadSha: "reviewed-head",
      prReviewState: "changes_requested",
      lastBlockingReviewHeadSha: "reviewed-head",
    }),
    {
      runType: "review_fix",
      workflowReason: "review_changes_requested",
    },
  );
  assert.deepEqual(
    deriveReactiveWorkflowIntent({
      prNumber: 8,
      prState: "open",
      prCheckStatus: "failed",
    }),
    {
      runType: "ci_repair",
      workflowReason: "settled_red_ci",
    },
  );
  assert.deepEqual(
    deriveReactiveWorkflowIntent({
      prNumber: 9,
      prState: "open",
      mergeConflictDetected: true,
      downstreamOwned: true,
    }),
    {
      runType: "queue_repair",
      workflowReason: "merge_steward_incident",
    },
  );
});
