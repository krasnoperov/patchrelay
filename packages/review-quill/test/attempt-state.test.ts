import assert from "node:assert/strict";
import test from "node:test";

import { describeAttemptState } from "../src/attempt-state.ts";
import type { ReviewAttemptRecord } from "../src/types.ts";

function fakeAttempt(overrides: Partial<ReviewAttemptRecord> = {}): ReviewAttemptRecord {
  return {
    id: 1,
    repoFullName: "krasnoperov/mafia",
    prNumber: 42,
    headSha: "abc123",
    status: "running",
    createdAt: "2026-04-07T20:00:00.000Z",
    updatedAt: "2026-04-07T20:00:00.000Z",
    ...overrides,
  };
}

test("describeAttemptState marks active attempts from before the current service start as stale", () => {
  const result = describeAttemptState(fakeAttempt(), {
    serviceStartedAt: "2026-04-07T20:10:00.000Z",
    now: new Date("2026-04-07T20:12:00.000Z").getTime(),
    policy: {
      queuedAfterMs: 5 * 60_000,
      runningAfterMs: 20 * 60_000,
    },
  });

  assert.equal(result.stale, true);
  assert.match(result.staleReason ?? "", /left running across a review-quill restart/);
});

test("describeAttemptState marks long-running attempts stale after the heartbeat threshold", () => {
  const result = describeAttemptState(fakeAttempt(), {
    now: new Date("2026-04-07T20:30:00.000Z").getTime(),
    policy: {
      queuedAfterMs: 5 * 60_000,
      runningAfterMs: 20 * 60_000,
    },
  });

  assert.equal(result.stale, true);
  assert.match(result.staleReason ?? "", /without a heartbeat for 30m/);
});

test("describeAttemptState leaves fresh active attempts alone", () => {
  const result = describeAttemptState(fakeAttempt({
    updatedAt: "2026-04-07T20:18:00.000Z",
  }), {
    now: new Date("2026-04-07T20:20:00.000Z").getTime(),
    policy: {
      queuedAfterMs: 5 * 60_000,
      runningAfterMs: 20 * 60_000,
    },
  });

  assert.equal(result.stale, false);
});
