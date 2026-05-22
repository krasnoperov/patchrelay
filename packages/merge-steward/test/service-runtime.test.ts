import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import pino from "pino";
import type { QueueStore } from "../src/store.ts";
import type { QueueEntry } from "../src/types.ts";
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

function makeEntry(overrides: Partial<QueueEntry> = {}): QueueEntry {
  return {
    id: "entry-1",
    repoId: "app",
    prNumber: 42,
    branch: "feat/x",
    headSha: "abc123",
    baseSha: "def456",
    status: "queued",
    position: 0,
    priority: 0,
    generation: 0,
    ciRunId: null,
    ciRetries: 0,
    retryAttempts: 0,
    maxRetries: 2,
    lastFailedBaseSha: null,
    issueKey: null,
    specBranch: null,
    specSha: null,
    specBasedOn: null,
    postMergeStatus: null,
    postMergeSha: null,
    postMergeSummary: null,
    postMergeCheckedAt: null,
    baseRefName: null,
    headPatchId: null,
    specTreeId: null,
    enqueuedAt: "2026-05-22T00:00:00.000Z",
    updatedAt: "2026-05-22T00:00:00.000Z",
    ...overrides,
  };
}

function makeStore(entries: QueueEntry[] = []): QueueStore {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  return {
    getHead(repoId) {
      return entries.find((entry) => entry.repoId === repoId);
    },
    getEntry(entryId) {
      return byId.get(entryId);
    },
    getEntryByPR(repoId, prNumber) {
      return entries.find((entry) => entry.repoId === repoId && entry.prNumber === prNumber);
    },
    listActive(repoId) {
      return entries.filter((entry) => entry.repoId === repoId && !["merged", "evicted", "dequeued"].includes(entry.status));
    },
    listAll(repoId) {
      return entries.filter((entry) => entry.repoId === repoId);
    },
    insert() {},
    transition(entryId, to, patch) {
      const entry = byId.get(entryId);
      if (entry) Object.assign(entry, patch, { status: to });
    },
    dequeue() {},
    updateHead() {},
    rebuildSpecHeadEquivalent() {},
    updatePriority() {},
    insertIncident() {},
    listIncidents() { return []; },
    getIncident() { return undefined; },
    listEvents() { return []; },
    listRecentEvents() { return []; },
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

test("runtime clears the previous reconcile event when a new tick starts", async () => {
  let releaseSecondTick: (() => void) | undefined;
  let blockSecondTick = false;
  let secondTickStarted = false;
  const runtime = new MergeStewardRuntime(
    makeConfig(),
    { getSnapshot: () => ({ requiredChecks: [], requireAllChecksOnEmptyRequiredSet: false, fetchedAt: null, lastRefreshReason: null, lastRefreshChanged: null }) } as never,
    makeStore([makeEntry()]),
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    pino({ enabled: false }),
    async () => {
      if (!blockSecondTick) return;
      secondTickStarted = true;
      await new Promise<void>((resolve) => {
        releaseSecondTick = resolve;
      });
    },
  );

  const first = await runtime.triggerReconcile();
  assert.equal(first.runtime.lastReconcileEvent?.action, "promoted");

  blockSecondTick = true;
  const second = runtime.triggerReconcile();
  while (!secondTickStarted) await delay(0);

  const alreadyRunning = await runtime.triggerReconcile();
  assert.equal(alreadyRunning.started, false);
  assert.equal(alreadyRunning.runtime.lastReconcileEvent, null);

  releaseSecondTick?.();
  await second;
});
