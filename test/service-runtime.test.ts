import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import pino from "pino";
import { ServiceRuntime, type RuntimeIssueQueueItem } from "../src/service-runtime.ts";

class FakeCodexClient {
  started = false;
  startCalls = 0;
  stopCalls = 0;
  failStartWith?: Error;

  isStarted(): boolean {
    return this.started;
  }

  async start(): Promise<void> {
    this.startCalls += 1;
    if (this.failStartWith) {
      throw this.failStartWith;
    }
    this.started = true;
  }

  async stop(): Promise<void> {
    this.stopCalls += 1;
    this.started = false;
  }
}

async function flushQueue(): Promise<void> {
  await delay(0);
  await delay(0);
}

test("service runtime starts codex, reconciles active runs, seeds ready issues, and reports ready", async () => {
  const codex = new FakeCodexClient();
  const calls: string[] = [];
  const processedIssues: RuntimeIssueQueueItem[] = [];

  const runtime = new ServiceRuntime(
    codex as never,
    pino({ enabled: false }),
    {
      async reconcileActiveStageRuns() {
        calls.push("reconcile");
      },
    },
    {
      listIssuesReadyForExecution() {
        calls.push("ready-issues");
        return [
          { projectId: "app", linearIssueId: "issue-1" },
          { projectId: "app", linearIssueId: "issue-2" },
        ];
      },
    },
    {
      async processWebhookEvent() {
        calls.push("webhook");
      },
    },
    {
      async processIssue(item) {
        processedIssues.push(item);
      },
    },
  );

  assert.deepEqual(runtime.getReadiness(), { ready: false, codexStarted: false });

  await runtime.start();
  await flushQueue();

  assert.equal(codex.startCalls, 1);
  assert.deepEqual(calls, ["reconcile", "ready-issues"]);
  assert.deepEqual(processedIssues, [
    { projectId: "app", issueId: "issue-1" },
    { projectId: "app", issueId: "issue-2" },
  ]);
  assert.deepEqual(runtime.getReadiness(), { ready: true, codexStarted: true });
  runtime.stop();
});

test("service runtime processes enqueued webhook and deduplicates identical issue queue keys", async () => {
  const codex = new FakeCodexClient();
  const processedWebhooks: number[] = [];
  const processedIssues: RuntimeIssueQueueItem[] = [];

  const runtime = new ServiceRuntime(
    codex as never,
    pino({ enabled: false }),
    async () => undefined,
    () => [],
    async (eventId) => {
      processedWebhooks.push(eventId);
    },
    async (item) => {
      processedIssues.push(item);
    },
  );

  runtime.enqueueWebhookEvent(41);
  runtime.enqueueIssue("app", "issue-1");
  runtime.enqueueIssue("app", "issue-1");
  runtime.enqueueIssue("app", "issue-2");
  await flushQueue();

  assert.deepEqual(processedWebhooks, [41]);
  assert.deepEqual(processedIssues, [
    { projectId: "app", issueId: "issue-1" },
    { projectId: "app", issueId: "issue-2" },
  ]);
});

test("service runtime prioritizes urgent webhook items without introducing a second processing lane", async () => {
  const codex = new FakeCodexClient();
  const processedWebhooks: number[] = [];

  const runtime = new ServiceRuntime(
    codex as never,
    pino({ enabled: false }),
    async () => undefined,
    () => [],
    async (eventId) => {
      processedWebhooks.push(eventId);
    },
    async () => undefined,
  );

  runtime.enqueueWebhookEvent(41);
  runtime.enqueueWebhookEvent(99, { priority: true });
  runtime.enqueueWebhookEvent(42);
  await flushQueue();

  assert.deepEqual(processedWebhooks, [99, 41, 42]);
});

test("service runtime clears ready state on stop and preserves codex status in readiness", async () => {
  const codex = new FakeCodexClient();
  const runtime = new ServiceRuntime(
    codex as never,
    pino({ enabled: false }),
    async () => undefined,
    () => [],
    async () => undefined,
    async () => undefined,
  );

  await runtime.start();
  assert.deepEqual(runtime.getReadiness(), { ready: true, codexStarted: true });

  runtime.stop();
  await flushQueue();

  assert.equal(codex.stopCalls, 1);
  assert.deepEqual(runtime.getReadiness(), { ready: false, codexStarted: false });
});

test("service runtime records startup error when codex start fails", async () => {
  const codex = new FakeCodexClient();
  codex.failStartWith = new Error("codex offline");
  let reconciled = false;

  const runtime = new ServiceRuntime(
    codex as never,
    pino({ enabled: false }),
    async () => {
      reconciled = true;
    },
    () => [],
    async () => undefined,
    async () => undefined,
  );

  await assert.rejects(runtime.start(), /codex offline/);

  assert.equal(reconciled, false);
  assert.deepEqual(runtime.getReadiness(), {
    ready: false,
    codexStarted: false,
    startupError: "codex offline",
  });
});

test("service runtime records startup error when reconciliation fails after codex starts", async () => {
  const codex = new FakeCodexClient();
  let readyIssuesCalled = false;

  const runtime = new ServiceRuntime(
    codex as never,
    pino({ enabled: false }),
    async () => {
      throw new Error("reconcile failed");
    },
    () => {
      readyIssuesCalled = true;
      return [];
    },
    async () => undefined,
    async () => undefined,
  );

  await assert.rejects(runtime.start(), /reconcile failed/);

  assert.equal(readyIssuesCalled, false);
  assert.deepEqual(runtime.getReadiness(), {
    ready: false,
    codexStarted: true,
    startupError: "reconcile failed",
  });
});

test("service runtime continues reconciling active runs after startup", async () => {
  const codex = new FakeCodexClient();
  let reconcileCalls = 0;

  const runtime = new ServiceRuntime(
    codex as never,
    pino({ enabled: false }),
    async () => {
      reconcileCalls += 1;
    },
    () => [],
    async () => undefined,
    async () => undefined,
    { reconcileIntervalMs: 5 },
  );

  await runtime.start();
  await delay(20);

  assert.ok(reconcileCalls >= 2);
  runtime.stop();
});

test("service runtime recovers after a background reconciliation timeout", async () => {
  const codex = new FakeCodexClient();
  let reconcileCalls = 0;

  const runtime = new ServiceRuntime(
    codex as never,
    pino({ enabled: false }),
    async () => {
      reconcileCalls += 1;
      if (reconcileCalls === 2) {
        await delay(50);
      }
    },
    () => [],
    async () => undefined,
    async () => undefined,
    { reconcileIntervalMs: 5, reconcileTimeoutMs: 10 },
  );

  await runtime.start();
  await delay(80);

  assert.ok(reconcileCalls >= 2);
  runtime.stop();
});
