import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import pino from "pino";
import { MergeStewardRuntime } from "../src/service-runtime.ts";
import type { StewardConfig } from "../src/config.ts";

function makeConfig(overrides: Partial<StewardConfig> = {}): StewardConfig {
  return {
    repoId: "app",
    repoFullName: "owner/app",
    baseBranch: "main",
    clonePath: "/tmp/app",
    gitBin: "git",
    maxRetries: 2,
    flakyRetries: 1,
    speculativeDepth: 1,
    pollIntervalMs: 30_000,
    reconcileStaleAfterMs: 1_000,
    server: { bind: "127.0.0.1", port: 8790 },
    database: { path: "/tmp/queue.sqlite", wal: true },
    logging: { level: "info" },
    admissionLabel: "queue",
    priorityQueueLabel: "queue:priority",
    mergeQueueCheckName: "merge-steward/queue",
    evictionCheckName: "merge-steward/queue",
    specReadyCheckName: "merge-steward/spec-ready",
    specBranchPrefix: "mq-spec-",
    excludeBranches: [],
    autoResolvePatterns: [],
    ...overrides,
  };
}

test("triggerReconcile reports already_running while a tick is active", async () => {
  let releaseTick: (() => void) | undefined;
  let tickStarted = false;
  const beforeTick = async () => {
    tickStarted = true;
    await new Promise<void>((resolve) => {
      releaseTick = resolve;
    });
  };
  const runtime = new MergeStewardRuntime(
    makeConfig(),
    { getSnapshot: () => ({ requiredChecks: [], requireAllChecksOnEmptyRequiredSet: false, fetchedAt: null, lastRefreshReason: null, lastRefreshChanged: null }) } as never,
    { listActive: () => [] } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    pino({ enabled: false }),
    beforeTick,
  );

  const first = runtime.triggerReconcile();
  while (!tickStarted) await delay(0);

  const second = await runtime.triggerReconcile();
  assert.equal(second.started, false);
  assert.equal(second.reason, "already_running");
  assert.equal(second.runtime.tickInProgress, true);
  assert.equal(typeof second.runtime.tickAgeMs, "number");
  assert.equal(second.runtime.staleTick, false);

  releaseTick?.();
  await first;
});

test("runtime marks a long active tick stale", async () => {
  let releaseTick: (() => void) | undefined;
  let tickStarted = false;
  const runtime = new MergeStewardRuntime(
    makeConfig({ reconcileStaleAfterMs: 5 }),
    { getSnapshot: () => ({ requiredChecks: [], requireAllChecksOnEmptyRequiredSet: false, fetchedAt: null, lastRefreshReason: null, lastRefreshChanged: null }) } as never,
    { listActive: () => [] } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    pino({ enabled: false }),
    async () => {
      tickStarted = true;
      await new Promise<void>((resolve) => {
        releaseTick = resolve;
      });
    },
  );

  const tick = runtime.triggerReconcile();
  while (!tickStarted) await delay(0);
  await delay(20);

  const status = runtime.getRuntimeStatus();
  assert.equal(status.tickInProgress, true);
  assert.equal(status.staleTick, true);
  assert.ok((status.tickAgeMs ?? 0) >= 5);

  releaseTick?.();
  await tick;
});
