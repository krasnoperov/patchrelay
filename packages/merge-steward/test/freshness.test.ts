import assert from "node:assert/strict";
import test from "node:test";
import { describeSnapshotFreshness } from "../src/watch/freshness.ts";

test("merge-steward snapshot freshness reports fresh, delayed, and stale states", () => {
  const now = 2_000_000;
  const expectedFreshMs = 3_000;

  assert.equal(
    describeSnapshotFreshness(true, now - 1_000, expectedFreshMs, undefined, now).label,
    "fresh 1s",
  );
  assert.match(
    describeSnapshotFreshness(true, now - 4_000, expectedFreshMs, undefined, now).label,
    /refresh delayed 4s/,
  );
  assert.match(
    describeSnapshotFreshness(true, now - 10_000, expectedFreshMs, undefined, now).label,
    /snapshot lag\?/,
  );
  assert.match(
    describeSnapshotFreshness(false, now - 10_000, expectedFreshMs, undefined, now).label,
    /disconnected/,
  );
  assert.match(
    describeSnapshotFreshness(false, null, expectedFreshMs, "fetch failed", now).label,
    /gateway offline · fetch failed/,
  );
});
