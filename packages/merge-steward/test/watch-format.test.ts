import assert from "node:assert/strict";
import test from "node:test";
import { formatEventNarrative, formatRepoTokenText, humanStatus, nextStepLabel, statusColor } from "../src/watch/format.ts";

test("summary token marks a speculatively stacked entry with a connector", () => {
  const base = { prNumber: 1805, glyph: "●", eventAt: Date.now() };
  assert.ok(!formatRepoTokenText(base).startsWith("↳"), "unstacked entry has no connector");
  assert.ok(formatRepoTokenText({ ...base, prNumber: 1806, stackedOnPr: 1805 }).startsWith("↳"), "stacked entry leads with the connector");
});

test("summary token shows duration·recency for finished and duration-only while in flight", () => {
  const eventAt = Date.now();
  const finished = formatRepoTokenText({ prNumber: 10, glyph: "✓", eventAt, durationMs: 7 * 60_000, recencyAt: Date.now() - 3 * 60_000 });
  assert.match(finished, /#10 ✓ 7m·\d/, "finished entry shows took·ago");
  const running = formatRepoTokenText({ prNumber: 11, glyph: "●", eventAt, durationMs: 2 * 60_000, recencyAt: null });
  assert.equal(running, "#11 ● 2m", "in-flight entry shows only running duration");
});

test("merge wait detail renders approval-blocked merging clearly", () => {
  const entry = {
    lastFailedBaseSha: null,
    specBranch: "mq-spec-123",
    specBasedOn: null,
    waitDetail: "blocking review present, waiting for approval",
  };

  assert.equal(humanStatus("merging", entry), "waiting for approval");
  assert.equal(nextStepLabel("merging", entry), "waiting for GitHub approval before landing on main");
  assert.equal(statusColor("merging", entry), "yellow");
});

test("merge wait detail renders main-verification waits clearly", () => {
  const entry = {
    lastFailedBaseSha: null,
    specBranch: "mq-spec-123",
    specBasedOn: null,
    waitDetail: "main checks still pending, holding merge",
  };

  assert.equal(humanStatus("merging", entry), "waiting for main");
  assert.equal(nextStepLabel("merging", entry), "waiting for main checks to settle before landing");
  assert.equal(statusColor("merging", entry), "yellow");
});

test("merge event narrative describes approval and main waits", () => {
  assert.match(
    formatEventNarrative({
      entryId: "entry-1",
      at: "2026-04-16T19:44:30.029Z",
      fromStatus: "merging",
      toStatus: "merging",
      detail: "blocking review present, waiting for approval",
    }, { prNumber: 139 }),
    /waiting for approval before merging to main/i,
  );

  assert.match(
    formatEventNarrative({
      entryId: "entry-1",
      at: "2026-04-16T19:44:30.029Z",
      fromStatus: "merging",
      toStatus: "merging",
      detail: "main checks still pending, holding merge",
    }, { prNumber: 139 }),
    /waiting for main verification before merging/i,
  );
});
