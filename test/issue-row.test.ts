import assert from "node:assert/strict";
import test from "node:test";
import { formatIssueAge } from "../src/cli/watch/format-utils.ts";

test("formatIssueAge renders a fixed-width relative age for the issue row", () => {
  const originalNow = Date.now;
  Date.now = () => Date.parse("2026-04-20T12:00:00.000Z");
  try {
    assert.equal(formatIssueAge("2026-04-20T11:58:00.000Z"), "  2m");
  } finally {
    Date.now = originalNow;
  }
});
