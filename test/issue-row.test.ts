import assert from "node:assert/strict";
import test from "node:test";
import { summarizeIssueStatusNote } from "../src/cli/watch/issue-status-note.ts";

test("summarizeIssueStatusNote keeps the first paragraph and removes markdown noise", () => {
  const summary = summarizeIssueStatusNote(
    "The CI failure was in [OnboardingRoute.tsx](/tmp/app.tsx) after `npm test`.\n\nVerification:\n- step one",
  );

  assert.equal(summary, "The CI failure was in OnboardingRoute.tsx after npm test.");
});

test("summarizeIssueStatusNote returns undefined for empty input", () => {
  assert.equal(summarizeIssueStatusNote(" \n "), undefined);
  assert.equal(summarizeIssueStatusNote(undefined), undefined);
});
