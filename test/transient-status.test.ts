import assert from "node:assert/strict";
import test from "node:test";
import { clearTransientStatus, setPersistentStatus, showTransientStatus, type TimerApi, type TransientStatusController } from "../src/cli/watch/transient-status.ts";

function createFakeTimers() {
  let nextId = 1;
  const callbacks = new Map<number, () => void>();
  const cleared: number[] = [];

  const timers: TimerApi<number> = {
    setTimeout(callback) {
      const id = nextId++;
      callbacks.set(id, callback);
      return id;
    },
    clearTimeout(timer) {
      cleared.push(timer);
      callbacks.delete(timer);
    },
  };

  return {
    timers,
    cleared,
    run(timer: number) {
      callbacks.get(timer)?.();
    },
  };
}

test("showTransientStatus cancels the previous timer before scheduling a new clear", () => {
  const updates: Array<string | null> = [];
  const controller: TransientStatusController<number> = { timer: null };
  const fake = createFakeTimers();

  showTransientStatus(controller, "sending...", (value) => updates.push(value), fake.timers);
  const firstTimer = controller.timer;
  showTransientStatus(controller, "delivered", (value) => updates.push(value), fake.timers);
  const secondTimer = controller.timer;

  assert.equal(firstTimer, 1);
  assert.equal(secondTimer, 2);
  assert.deepEqual(fake.cleared, [1]);
  fake.run(1);
  assert.deepEqual(updates, ["sending...", "delivered"]);
  fake.run(2);
  assert.deepEqual(updates, ["sending...", "delivered", null]);
  assert.equal(controller.timer, null);
});

test("clearTransientStatus clears any pending timer and resets the controller", () => {
  const controller: TransientStatusController<number> = { timer: null };
  const fake = createFakeTimers();

  showTransientStatus(controller, "sending...", () => undefined, fake.timers);
  assert.equal(controller.timer, 1);

  clearTransientStatus(controller, fake.timers);

  assert.equal(controller.timer, null);
  assert.deepEqual(fake.cleared, [1]);
});

test("setPersistentStatus clears old timers without scheduling a new one", () => {
  const updates: Array<string | null> = [];
  const controller: TransientStatusController<number> = { timer: null };
  const fake = createFakeTimers();

  showTransientStatus(controller, "queued", (value) => updates.push(value), fake.timers);
  assert.equal(controller.timer, 1);

  setPersistentStatus(controller, "sending...", (value) => updates.push(value), fake.timers);

  assert.equal(controller.timer, null);
  assert.deepEqual(fake.cleared, [1]);
  fake.run(1);
  assert.deepEqual(updates, ["queued", "sending..."]);
});
