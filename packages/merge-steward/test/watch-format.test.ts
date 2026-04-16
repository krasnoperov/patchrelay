import assert from "node:assert/strict";
import test from "node:test";
import { formatEventNarrative, humanStatus, nextStepLabel, statusColor } from "../src/watch/format.ts";

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
