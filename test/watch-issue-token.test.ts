import assert from "node:assert/strict";
import test from "node:test";
import { issueTokenFor, prTokenFor } from "../src/cli/watch/issue-token.ts";
import type { WatchIssue } from "../src/cli/watch/watch-state.ts";

function makeIssue(overrides?: Partial<WatchIssue>): WatchIssue {
  return {
    projectId: "test-project",
    delegatedToPatchRelay: true,
    factoryState: "implementing",
    blockedByCount: 0,
    blockedByKeys: [],
    readyForExecution: false,
    updatedAt: "2026-04-18T10:00:00.000Z",
    ...overrides,
  };
}

test("issueTokenFor renders undelegated paused local work explicitly", () => {
  const token = issueTokenFor(makeIssue({
    delegatedToPatchRelay: false,
    factoryState: "implementing",
  }));

  assert.deepEqual(token, {
    glyph: "\u25cb",
    color: "gray",
    kind: "queued",
    phrase: "paused impl",
  });
});

test("issueTokenFor keeps delegated implementation work visibly active", () => {
  const token = issueTokenFor(makeIssue({
    delegatedToPatchRelay: true,
    factoryState: "implementing",
  }));

  assert.deepEqual(token, {
    glyph: "\u25cf",
    color: "yellow",
    kind: "running",
    phrase: "implementing",
  });
});

test("prTokenFor exposes a readable review phrase", () => {
  const token = prTokenFor(makeIssue({
    prNumber: 218,
    prState: "open",
    prReviewState: "changes_requested",
    prCheckStatus: "failure",
  }));

  assert.deepEqual(token, {
    prNumber: 218,
    glyph: "\u2717",
    color: "red",
    kind: "declined",
    phrase: "changes req",
  });
});

test("prTokenFor falls back to checks text when review state is not decisive", () => {
  const token = prTokenFor(makeIssue({
    prNumber: 226,
    prState: "open",
    prCheckStatus: "success",
  }));

  assert.deepEqual(token, {
    prNumber: 226,
    glyph: "\u2713",
    color: "green",
    kind: "approved",
    phrase: "checks passed",
  });
});

test("prTokenFor shows replacement work for closed PRs on active delegated issues", () => {
  const token = prTokenFor(makeIssue({
    prNumber: 260,
    prState: "closed",
    factoryState: "implementing",
    delegatedToPatchRelay: true,
  }));

  assert.deepEqual(token, {
    prNumber: 260,
    glyph: "\u25cb",
    color: "gray",
    kind: "queued",
    phrase: "replace pr",
  });
});
