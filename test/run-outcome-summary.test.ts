import assert from "node:assert/strict";
import test from "node:test";
import { buildRunOutcomeSummary } from "../src/run-outcome-summary.ts";

test("run outcome summary reports published implementation outcome without assistant prose", () => {
  assert.equal(
    buildRunOutcomeSummary({
      runType: "implementation",
      facts: {
        prNumber: 42,
        postRunState: "pr_open",
        latestAssistantSummary: "I inspected files, ran tests, and pushed the branch.",
      },
    }),
    "Ready for review.",
  );
});

test("run outcome summary uses structured wake facts for repair outcomes", () => {
  assert.equal(
    buildRunOutcomeSummary({
      runType: "review_fix",
      facts: {
        prNumber: 42,
        reviewerName: "@Ada",
        reviewSummary: "Please tighten the publishing summary.",
      },
    }),
    "Publishing summary tightened.",
  );

  assert.equal(
    buildRunOutcomeSummary({
      runType: "ci_repair",
      facts: {
        prNumber: 43,
        failingCheckName: "test / unit",
        failureSummary: "unused assistant-facing detail",
      },
    }),
    "test / unit fixed.",
  );
});
