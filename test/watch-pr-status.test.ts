import assert from "node:assert/strict";
import test from "node:test";
import { arePrChecksCompleteAndGreen, hasDisplayPrBlocker, isRereviewNeeded, prChecksFact } from "../src/cli/watch/pr-status.ts";
import type { WatchIssue } from "../src/cli/watch/watch-state.ts";

function makeIssue(overrides?: Partial<WatchIssue>): WatchIssue {
  return {
    projectId: "test-project",
    factoryState: "changes_requested",
    blockedByCount: 0,
    blockedByKeys: [],
    readyForExecution: false,
    updatedAt: "2026-04-08T10:00:00.000Z",
    ...overrides,
  };
}

test("pending full check summary blocks rereview even when gate status is success", () => {
  const issue = makeIssue({
    prNumber: 26,
    readyForExecution: true,
    prReviewState: "changes_requested",
    prCheckStatus: "success",
    prChecksSummary: {
      total: 3,
      completed: 2,
      passed: 2,
      failed: 0,
      pending: 1,
      overall: "success",
    },
  });

  assert.equal(arePrChecksCompleteAndGreen(issue), false);
  assert.equal(isRereviewNeeded(issue), false);
  assert.equal(hasDisplayPrBlocker(issue), true);
  assert.deepEqual(prChecksFact(issue), { text: "checks 2/3", color: "yellow" });
});

test("completed green checks allow rereview once all checks settle", () => {
  const issue = makeIssue({
    prNumber: 26,
    readyForExecution: true,
    prReviewState: "changes_requested",
    prCheckStatus: "success",
    prChecksSummary: {
      total: 3,
      completed: 3,
      passed: 3,
      failed: 0,
      pending: 0,
      overall: "success",
    },
  });

  assert.equal(arePrChecksCompleteAndGreen(issue), true);
  assert.equal(isRereviewNeeded(issue), true);
  assert.deepEqual(prChecksFact(issue), { text: "checks passed", color: "green" });
});
