import assert from "node:assert/strict";
import test from "node:test";
import { formatRepoTokenText, formatTokenAge } from "../src/watch/format.ts";
import type { DashboardToken } from "../src/watch/dashboard-model.ts";

test("merge-steward repo strip tokens include relative age", () => {
  const originalNow = Date.now;
  Date.now = () => Date.parse("2026-04-20T12:00:00.000Z");
  try {
    const token: DashboardToken = {
      prNumber: 84,
      glyph: "\u25cf",
      color: "yellow",
      kind: "running",
      eventAt: Date.parse("2026-04-20T11:58:00.000Z"),
    };
    assert.equal(formatRepoTokenText(token), "#84 ● 2m");
  } finally {
    Date.now = originalNow;
  }
});

test("merge-steward detail rows show a fixed-width relative age", () => {
  const originalNow = Date.now;
  Date.now = () => Date.parse("2026-04-20T12:00:00.000Z");
  try {
    assert.equal(formatTokenAge(Date.parse("2026-04-20T11:58:00.000Z")), "  2m");
  } finally {
    Date.now = originalNow;
  }
});
