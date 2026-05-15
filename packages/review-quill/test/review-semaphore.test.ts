import assert from "node:assert/strict";
import test from "node:test";
import { ReviewSemaphore } from "../src/review-semaphore.ts";

test("ReviewSemaphore admits up to capacity without waiting", async () => {
  const semaphore = new ReviewSemaphore(2);
  const a = await semaphore.acquire();
  const b = await semaphore.acquire();
  assert.equal(semaphore.inFlightCount, 2);
  a();
  b();
  assert.equal(semaphore.inFlightCount, 0);
});

test("ReviewSemaphore queues callers beyond capacity until a slot is released", async () => {
  const semaphore = new ReviewSemaphore(1);
  const first = await semaphore.acquire();
  let secondAcquired = false;
  const secondPromise = semaphore.acquire().then((release) => {
    secondAcquired = true;
    return release;
  });
  await Promise.resolve();
  assert.equal(secondAcquired, false, "second acquire should not resolve while slot is held");

  first();
  const secondRelease = await secondPromise;
  assert.equal(secondAcquired, true);
  assert.equal(semaphore.inFlightCount, 1);
  secondRelease();
  assert.equal(semaphore.inFlightCount, 0);
});

test("ReviewSemaphore wakes queued waiters in FIFO order", async () => {
  const semaphore = new ReviewSemaphore(1);
  const order: number[] = [];
  const first = await semaphore.acquire();
  const waiterA = semaphore.acquire().then((release) => {
    order.push(1);
    return release;
  });
  const waiterB = semaphore.acquire().then((release) => {
    order.push(2);
    return release;
  });
  first();
  const releaseA = await waiterA;
  releaseA();
  const releaseB = await waiterB;
  releaseB();
  assert.deepEqual(order, [1, 2]);
});

test("ReviewSemaphore notifies onCountChange for every acquire and release", async () => {
  const counts: number[] = [];
  const semaphore = new ReviewSemaphore(2, (inFlight) => counts.push(inFlight));
  const a = await semaphore.acquire();
  const b = await semaphore.acquire();
  a();
  b();
  assert.deepEqual(counts, [1, 2, 1, 0]);
});
