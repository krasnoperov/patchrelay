import assert from "node:assert/strict";
import test from "node:test";
import { issueTokenFor } from "../src/cli/watch/issue-token.ts";
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
