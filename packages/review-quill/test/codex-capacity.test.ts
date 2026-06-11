import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyCodexFailure,
  CodexCapacityError,
  CodexCapacityPause,
} from "../src/codex-capacity.ts";

// The verbatim production error from the motivating incident.
const USAGE_LIMIT_MESSAGE = "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), "
  + "visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 3:23 AM.";

// Construct local-time dates explicitly — the "try again at" parser works in
// the local timezone, so the expectations must too.
const NOON = new Date(2026, 5, 10, 12, 0, 0);

test("classifyCodexFailure parses the real usage-limit message into the next local 3:23 AM", () => {
  const result = classifyCodexFailure(USAGE_LIMIT_MESSAGE, NOON);
  assert.equal(result.kind, "capacity");
  assert.ok(result.kind === "capacity");
  assert.equal(result.detail, USAGE_LIMIT_MESSAGE);
  // 3:23 AM has already passed at noon — next occurrence is tomorrow.
  assert.equal(result.retryAtIso, new Date(2026, 5, 11, 3, 23, 0).toISOString());
});

test("classifyCodexFailure picks the same-day occurrence when the reset time is still ahead", () => {
  const result = classifyCodexFailure("You've hit your usage limit, try again at 3 PM.", NOON);
  assert.ok(result.kind === "capacity");
  assert.equal(result.retryAtIso, new Date(2026, 5, 10, 15, 0, 0).toISOString());
});

test("classifyCodexFailure handles 12 AM and 12 PM correctly", () => {
  const midnight = classifyCodexFailure("usage limit; try again at 12 AM", NOON);
  assert.ok(midnight.kind === "capacity");
  assert.equal(midnight.retryAtIso, new Date(2026, 5, 11, 0, 0, 0).toISOString());

  const halfPastNoon = classifyCodexFailure("usage limit; try again at 12:30 PM", NOON);
  assert.ok(halfPastNoon.kind === "capacity");
  assert.equal(halfPastNoon.retryAtIso, new Date(2026, 5, 10, 12, 30, 0).toISOString());
});

test("classifyCodexFailure matches rate-limit wording without a reset time", () => {
  const result = classifyCodexFailure("Rate limit exceeded for the model. Please slow down.", NOON);
  assert.ok(result.kind === "capacity");
  assert.equal(result.retryAtIso, undefined);
});

test("classifyCodexFailure matches quota wording", () => {
  const result = classifyCodexFailure("You exceeded your current quota, please check your plan and billing details.", NOON);
  assert.ok(result.kind === "capacity");
  assert.equal(result.detail, "You exceeded your current quota, please check your plan and billing details.");
});

test("classifyCodexFailure returns other for unrelated errors", () => {
  assert.deepEqual(classifyCodexFailure("Review turn ended with status failed", NOON), { kind: "other" });
  assert.deepEqual(classifyCodexFailure("stream disconnected before completion", NOON), { kind: "other" });
});

test("classifyCodexFailure returns other for undefined and blank input", () => {
  assert.deepEqual(classifyCodexFailure(undefined, NOON), { kind: "other" });
  assert.deepEqual(classifyCodexFailure("", NOON), { kind: "other" });
  assert.deepEqual(classifyCodexFailure("   ", NOON), { kind: "other" });
});

test("CodexCapacityPause pauses until the advertised reset time and resumes after it", () => {
  const pause = new CodexCapacityPause(() => 0); // jitter 0 for determinism
  const now = Date.parse("2026-06-10T01:00:00.000Z");
  const retryAtIso = "2026-06-10T03:23:00.000Z";

  const entry = pause.enter(new CodexCapacityError("limit", retryAtIso), now);
  assert.equal(entry.entered, true);
  assert.equal(entry.untilIso, retryAtIso);
  assert.equal(pause.isPaused(now), true);
  assert.equal(pause.limitedUntil(now), retryAtIso);

  // Deadline reached — auto-resume, and the state stays cleared.
  const atDeadline = Date.parse(retryAtIso);
  assert.equal(pause.isPaused(atDeadline), false);
  assert.equal(pause.limitedUntil(atDeadline), null);
  assert.equal(pause.isPaused(now), false);
});

test("CodexCapacityPause adds at most 60s of jitter past the reset time", () => {
  const pause = new CodexCapacityPause(() => 0.999_999);
  const now = Date.parse("2026-06-10T01:00:00.000Z");
  const retryAtMs = Date.parse("2026-06-10T03:23:00.000Z");

  const entry = pause.enter(new CodexCapacityError("limit", new Date(retryAtMs).toISOString()), now);
  const untilMs = Date.parse(entry.untilIso);
  assert.ok(untilMs > retryAtMs, "jitter must push past the advertised reset");
  assert.ok(untilMs - retryAtMs <= 60_000, "jitter must be at most 60s");
});

test("CodexCapacityPause falls back to now + 10 minutes when no reset time was parsed", () => {
  const pause = new CodexCapacityPause(() => 0.5);
  const now = Date.parse("2026-06-10T01:00:00.000Z");

  const entry = pause.enter(new CodexCapacityError("rate limited"), now);
  assert.equal(Date.parse(entry.untilIso), now + 10 * 60_000);
});

test("CodexCapacityPause falls back to now + 10 minutes when the advertised reset is already in the past", () => {
  const pause = new CodexCapacityPause(() => 0);
  const now = Date.parse("2026-06-10T05:00:00.000Z");

  const entry = pause.enter(new CodexCapacityError("limit", "2026-06-10T03:23:00.000Z"), now);
  assert.equal(Date.parse(entry.untilIso), now + 10 * 60_000);
});

test("CodexCapacityPause reports entered only on the open→paused transition and only extends forward", () => {
  const pause = new CodexCapacityPause(() => 0);
  const now = Date.parse("2026-06-10T01:00:00.000Z");
  const first = pause.enter(new CodexCapacityError("limit", "2026-06-10T03:00:00.000Z"), now);
  assert.equal(first.entered, true);

  // Earlier reset while paused: no re-entry, deadline unchanged.
  const earlier = pause.enter(new CodexCapacityError("limit", "2026-06-10T02:00:00.000Z"), now);
  assert.equal(earlier.entered, false);
  assert.equal(earlier.untilIso, first.untilIso);

  // Later reset while paused: no re-entry, deadline extended.
  const later = pause.enter(new CodexCapacityError("limit", "2026-06-10T04:00:00.000Z"), now);
  assert.equal(later.entered, false);
  assert.equal(later.untilIso, "2026-06-10T04:00:00.000Z");

  // After the pause expires, the next capacity error re-enters (and may warn again).
  const afterExpiry = Date.parse("2026-06-10T04:00:00.000Z");
  const reentry = pause.enter(new CodexCapacityError("limit"), afterExpiry);
  assert.equal(reentry.entered, true);
});
