import assert from "node:assert/strict";
import test from "node:test";
import { buildRunOutcomeSummary } from "../src/run-outcome-summary.ts";

test("run outcome summary keeps useful implementation assistant recap", () => {
  assert.equal(
    buildRunOutcomeSummary({
      runType: "implementation",
      facts: {
        prNumber: 42,
        postRunState: "pr_open",
        latestAssistantSummary: "Implemented the Lyria provider, exposed it in web and CLI, and verified the audio tests.",
      },
    }),
    "Implemented the Lyria provider, exposed it in web and CLI, and verified the audio tests.",
  );
});

test("run outcome summary falls back for generic implementation assistant recap", () => {
  assert.equal(
    buildRunOutcomeSummary({
      runType: "implementation",
      facts: {
        prNumber: 42,
        postRunState: "pr_open",
        latestAssistantSummary: "Ready for review.",
      },
    }),
    "Ready for review.",
  );
});

test("run outcome summary uses structured workflowTask facts for repair outcomes", () => {
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

test("run outcome summary extracts the operator-facing blocker from review-quill bodies", () => {
  assert.equal(
    buildRunOutcomeSummary({
      runType: "review_fix",
      facts: {
        prNumber: 45,
        reviewerName: "review-quill[bot]",
        reviewSummary: [
          "**Verdict: 🛑 Request changes** — Request changes because website video generation currently records usage against the image billing meter.",
          "",
          "## Context",
          "The prior blocker appears resolved.",
        ].join("\n"),
      },
    }),
    "Website video generation currently records usage against the image billing meter.",
  );
});
