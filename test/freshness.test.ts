import assert from "node:assert/strict";
import test from "node:test";
import { describePatchRelayFreshness } from "../src/cli/watch/freshness.ts";

test("patchrelay freshness reports fresh, quiet, and stale/disconnected states", () => {
  const now = 1_000_000;

  assert.equal(
    describePatchRelayFreshness(true, now - 5_000, now).label,
    "fresh 5s",
  );
  assert.match(
    describePatchRelayFreshness(true, now - 25_000, now).label,
    /quiet 25s/,
  );
  assert.match(
    describePatchRelayFreshness(true, now - 45_000, now).label,
    /stream stalled\?/,
  );
  assert.match(
    describePatchRelayFreshness(false, now - 45_000, now).label,
    /disconnected/,
  );
});
