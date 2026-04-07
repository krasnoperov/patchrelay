import assert from "node:assert/strict";
import test from "node:test";
import { detectIssueKeys } from "../src/prompt-context/issue-keys.ts";

test("detectIssueKeys collects issue references from title, body, and branch name", () => {
  const keys = detectIssueKeys({
    title: "TST-28 Tighten review prompt",
    body: "Related follow-up: ABC-9 and TST-28.",
    headRefName: "feature/use-tst-28-context",
  });

  assert.deepEqual(keys, ["TST-28", "ABC-9"]);
});

test("detectIssueKeys returns an empty list when no issue keys are present", () => {
  assert.deepEqual(detectIssueKeys({
    title: "Refactor review prompt",
    body: "No external tracker references here.",
    headRefName: "feature/review-context",
  }), []);
});
