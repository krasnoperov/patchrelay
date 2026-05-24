import assert from "node:assert/strict";
import test from "node:test";
import { withRepoCacheMutation } from "../src/review-workspace/cache-mutex.ts";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test("withRepoCacheMutation serializes mutations for the same cache path", async () => {
  const events: string[] = [];
  let releaseFirst!: () => void;

  const first = withRepoCacheMutation("/tmp/cache-a.git", async () => {
    events.push("first:start");
    await new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    events.push("first:end");
  });

  const second = withRepoCacheMutation("/tmp/cache-a.git", async () => {
    events.push("second:start");
  });

  await tick();
  assert.deepEqual(events, ["first:start"]);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(events, ["first:start", "first:end", "second:start"]);
});

test("withRepoCacheMutation allows different cache paths to run independently", async () => {
  const events: string[] = [];
  let releaseFirst!: () => void;

  const first = withRepoCacheMutation("/tmp/cache-a.git", async () => {
    events.push("first:start");
    await new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
  });

  const second = withRepoCacheMutation("/tmp/cache-b.git", async () => {
    events.push("second:start");
  });

  await tick();
  await second;
  assert.deepEqual(events, ["first:start", "second:start"]);
  releaseFirst();
  await first;
});
