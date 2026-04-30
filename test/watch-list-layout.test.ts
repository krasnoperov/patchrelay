import assert from "node:assert/strict";
import test from "node:test";
import { computeIssueListLayout, computeVisibleIssueParts } from "../src/cli/watch/list-layout.ts";

test("issue list layout drops help and blank spacer before the focused row on tiny screens", () => {
  assert.deepEqual(computeIssueListLayout(4), {
    bodyRows: 3,
    showBodyGap: false,
    showHelp: false,
  });
});

test("issue list layout only shows help once the body still has useful space", () => {
  assert.deepEqual(computeIssueListLayout(8), {
    bodyRows: 4,
    showBodyGap: true,
    showHelp: true,
  });
});

test("issue list visibility always keeps the selected issue in a one-row body", () => {
  assert.deepEqual(computeVisibleIssueParts(10, 5, 1), {
    start: 5,
    end: 6,
    showAbove: false,
    showBelow: false,
  });
});

test("issue list visibility uses overflow indicators only after reserving the selected issue", () => {
  assert.deepEqual(computeVisibleIssueParts(10, 5, 3), {
    start: 5,
    end: 6,
    showAbove: true,
    showBelow: true,
  });
});
