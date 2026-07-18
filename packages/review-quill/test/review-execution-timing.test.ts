import assert from "node:assert/strict";
import test from "node:test";
import { ReviewExecutionTiming } from "../src/review-execution-timing.ts";

test("ReviewExecutionTiming reports bounded lifecycle durations from an injected clock", () => {
  let now = 1_000;
  const timing = new ReviewExecutionTiming(() => now);

  timing.beginStabilization();
  now += 20;
  timing.endStabilization();
  timing.beginSemaphoreWait();
  now += 7;
  timing.endSemaphoreWait();
  timing.markAttemptCreated();
  now += 13;
  timing.beginCodexReview();
  now += 80;
  timing.endCodexReview();
  now += 5;
  timing.beginPublication();
  now += 11;
  timing.endPublication();

  assert.deepEqual(timing.snapshot(), {
    phase: "completed",
    attemptCreated: true,
    codexStarted: true,
    stabilizationWaitMs: 20,
    semaphoreWaitMs: 7,
    dispatchToCodexStartMs: 40,
    codexReviewMs: 80,
    publicationMs: 11,
    totalExecutionMs: 136,
  });
});

test("ReviewExecutionTiming clamps backwards clock movement instead of reporting negative durations", () => {
  let now = 100;
  const timing = new ReviewExecutionTiming(() => now);
  timing.beginSemaphoreWait();
  now = 90;
  timing.endSemaphoreWait();

  assert.equal(timing.snapshot().semaphoreWaitMs, 0);
  assert.equal(timing.snapshot().totalExecutionMs, 0);
});

test("ReviewExecutionTiming records failed publication time while retaining the failure phase", () => {
  let now = 200;
  const timing = new ReviewExecutionTiming(() => now);
  timing.beginPublication();
  now += 9;
  timing.endPublication(false);

  assert.equal(timing.snapshot().publicationMs, 9);
  assert.equal(timing.snapshot().phase, "publication");
});
