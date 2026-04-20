import assert from "node:assert/strict";
import test from "node:test";
import { formatIssueAge } from "../src/cli/watch/format-utils.ts";
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

test("formatIssueAge renders a fixed-width relative age for the issue row", () => {
  const originalNow = Date.now;
  Date.now = () => Date.parse("2026-04-20T12:00:00.000Z");
  try {
    assert.equal(formatIssueAge("2026-04-20T11:58:00.000Z"), "  2m");
  } finally {
    Date.now = originalNow;
  }
});
