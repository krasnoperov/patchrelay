import assert from "node:assert/strict";
import test from "node:test";
import { ReviewRunInterruptedError, ReviewRunner } from "../src/review-runner.ts";
import {
  CodexJsonRpcError,
  type CodexAppServerNotification,
  type StartTurnOptions,
} from "../src/codex-app-server.ts";
import { CodexCapacityError } from "../src/codex-capacity.ts";
import { REVIEW_VERDICT_JSON_SCHEMA } from "../src/review-verdict-schema.ts";
import type { ReviewQuillConfig } from "../src/types.ts";

function minimalConfig(): ReviewQuillConfig {
  return {
    server: { bind: "127.0.0.1", port: 8788 },
    database: { path: ":memory:", wal: true },
    logging: { level: "info" },
    reconciliation: {
      pollIntervalMs: 1_000,
      heartbeatIntervalMs: 1_000,
      staleQueuedAfterMs: 60_000,
      staleRunningAfterMs: 60_000,
    },
    codex: {
      bin: "codex",
      args: ["app-server"],
      approvalPolicy: "never",
      sandboxMode: "danger-full-access",
    },
    prompting: { replaceSections: {} },
    repositories: [],
    secretSources: {},
  };
}

const validReviewMessage = JSON.stringify({
  walkthrough: "The patch is straightforward.",
  architectural_concerns: [],
  findings: [],
  verdict: "approve",
  verdict_reason: "No blocking issues found.",
});

function notificationHarness(): {
  emit(notification: CodexAppServerNotification): void;
  listenerCount(): number;
  subscribeNotifications(listener: (notification: CodexAppServerNotification) => void): () => void;
} {
  const listeners = new Set<(notification: CodexAppServerNotification) => void>();
  return {
    emit: (notification) => {
      for (const listener of listeners) listener(notification);
    },
    listenerCount: () => listeners.size,
    subscribeNotifications: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function completedTurns(messages: string[]): { id: string; turns: Array<Record<string, unknown>> } {
  return {
    id: "thread-structured",
    turns: messages.map((text, index) => ({
      id: `turn-${index + 1}`,
      status: "completed",
      items: [{ type: "agentMessage", text }],
    })),
  };
}

function withNativeReview<T extends {
  startReview?: (...args: never[]) => unknown;
  startTurn: (...args: never[]) => unknown;
  readThread: (...args: never[]) => unknown;
  subscribeNotifications?: (listener: (notification: CodexAppServerNotification) => void) => () => void;
}>(fake: T): T {
  if (fake.startReview) return fake;
  let normalizing = false;
  let reviewThreadId = "native-review-thread";
  const notificationListeners = new Set<(notification: CodexAppServerNotification) => void>();
  return {
    ...fake,
    startReview: async (options: { threadId: string }) => {
      reviewThreadId = options.threadId;
      for (const listener of notificationListeners) {
        listener({ method: "turn/completed", params: { threadId: reviewThreadId, turn: { id: "native-review-turn" } } });
      }
      return { turnId: "native-review-turn", status: "running", reviewThreadId };
    },
    ...(fake.subscribeNotifications
      ? {
        subscribeNotifications: (listener: (notification: CodexAppServerNotification) => void) => {
          notificationListeners.add(listener);
          const unsubscribe = fake.subscribeNotifications!(listener);
          return () => {
            notificationListeners.delete(listener);
            unsubscribe();
          };
        },
      }
      : {}),
    startTurn: async (...args: never[]) => {
      normalizing = true;
      return await fake.startTurn(...args);
    },
    readThread: async (...args: never[]) => {
      if (!normalizing) {
        return {
          id: reviewThreadId,
          turns: [{
            id: "native-review-turn",
            status: "completed",
            items: [{ type: "exitedReviewMode", id: "native-review-turn", review: "Native review completed." }],
          }],
        };
      }
      return await fake.readThread(...args);
    },
  } as T;
}

test("ReviewRunner performs native review before schema-constrained normalization", async () => {
  const config = minimalConfig();
  const threadStarts: unknown[] = [];
  const reviewStarts: unknown[] = [];
  const turnStarts: StartTurnOptions[] = [];
  const rawReview = "[P1] Name the new tab stop — src/card.tsx:12\nThe empty button has no accessible name.";
  const fakeCodex = {
    start: async () => {},
    stop: async () => {},
    startThread: async (options: unknown) => {
      threadStarts.push(options);
      return { id: "native-thread", turns: [] };
    },
    startReview: async (options: unknown) => {
      reviewStarts.push(options);
      return { turnId: "review-turn", status: "running", reviewThreadId: "native-thread" };
    },
    startTurn: async (options: StartTurnOptions) => {
      turnStarts.push(options);
      return { turnId: "normalization-turn", status: "running" };
    },
    readThread: async () => ({
      id: "native-thread",
      turns: [
        {
          id: "review-turn",
          status: "completed",
          items: [{ type: "exitedReviewMode", id: "review-turn", review: rawReview }],
        },
        ...(turnStarts.length > 0
          ? [{
              id: "normalization-turn",
              status: "completed",
              items: [{ type: "agentMessage", id: "message-1", text: validReviewMessage }],
            }]
          : []),
      ],
    }),
  };
  const runner = new ReviewRunner(
    config,
    { warn() {}, info() {}, child: () => ({}) } as never,
    withNativeReview(fakeCodex) as never,
    async () => {},
  );

  const result = await runner.review({
    developerInstructions: "stable review policy",
    reviewPrompt: "review exact base..HEAD",
    workspace: { worktreePath: "/tmp/native-review" },
    pr: { headSha: "head-sha" },
    diff: { inventory: [], patches: [] },
    promptContext: { guidanceDocs: [] },
  } as never);

  assert.deepEqual(threadStarts, [{ cwd: "/tmp/native-review", developerInstructions: "stable review policy" }]);
  assert.deepEqual(reviewStarts, [{ threadId: "native-thread", instructions: "review exact base..HEAD" }]);
  assert.equal(turnStarts.length, 1);
  assert.match(turnStarts[0]?.input ?? "", /normalization only/i);
  assert.deepEqual(turnStarts[0]?.outputSchema, REVIEW_VERDICT_JSON_SCHEMA);
  assert.equal(result.reviewTurnId, "review-turn");
  assert.equal(result.turnId, "normalization-turn");
  assert.equal(result.rawReview, rawReview);
  assert.equal(result.verdict.verdict, "approve");
});

test("ReviewRunner correlates native review completion emitted from the reviewer child thread", async () => {
  const config = minimalConfig();
  const notifications = notificationHarness();
  let normalizationStarted = false;
  const fakeCodex = {
    start: async () => {},
    stop: async () => {},
    startThread: async () => ({ id: "parent-thread", turns: [] }),
    startReview: async () => {
      queueMicrotask(() => notifications.emit({
        method: "item/completed",
        params: {
          threadId: "reviewer-child-thread",
          item: {
            type: "exitedReviewMode",
            id: "unrelated-review-turn",
            review: "An unrelated concurrent review.",
          },
        },
      }));
      queueMicrotask(() => notifications.emit({
        method: "item/completed",
        params: {
          threadId: "parent-thread",
          item: {
            type: "exitedReviewMode",
            id: "protocol-review-item",
            review: "One concrete blocking concern.",
          },
        },
      }));
      return { turnId: "review-turn", status: "running", reviewThreadId: "parent-thread" };
    },
    startTurn: async () => {
      normalizationStarted = true;
      queueMicrotask(() => notifications.emit({
        method: "turn/completed",
        params: { threadId: "parent-thread", turn: { id: "normalization-turn" } },
      }));
      return { turnId: "normalization-turn", status: "running" };
    },
    readThread: async () => ({
      id: "parent-thread",
      turns: [{
        id: "normalization-turn",
        status: "completed",
        items: [{ type: "agentMessage", id: "message-1", text: validReviewMessage }],
      }],
    }),
    subscribeNotifications: notifications.subscribeNotifications,
  };
  const runner = new ReviewRunner(
    config,
    { warn() {}, info() {}, child: () => ({}) } as never,
    withNativeReview(fakeCodex) as never,
    async () => {},
  );

  const result = await runner.review({
    developerInstructions: "policy",
    reviewPrompt: "review",
    workspace: { worktreePath: "/tmp/native-review" },
    pr: { headSha: "head" },
    diff: { inventory: [], patches: [] },
    promptContext: { guidanceDocs: [] },
  } as never);

  assert.equal(normalizationStarted, true);
  assert.equal(result.rawReview, "One concrete blocking concern.");
  assert.equal(notifications.listenerCount(), 0);
});

test("ReviewRunner classifies a failed native review as soon as its turn completes", async () => {
  const config = minimalConfig();
  const notifications = notificationHarness();
  const sleeps: number[] = [];
  let readCalls = 0;
  let normalizationStarted = false;
  const fakeCodex = {
    start: async () => {},
    stop: async () => {},
    startThread: async () => ({ id: "native-thread", turns: [] }),
    startReview: async () => {
      queueMicrotask(() => notifications.emit({
        method: "turn/completed",
        params: { threadId: "native-thread", turn: { id: "review-turn" } },
      }));
      return { turnId: "review-turn", status: "running", reviewThreadId: "native-thread" };
    },
    startTurn: async () => {
      normalizationStarted = true;
      return { turnId: "normalization-turn", status: "running" };
    },
    readThread: async () => {
      readCalls += 1;
      if (readCalls === 1) throw new Error("Codex app-server request timed out after 30000ms");
      return {
        id: "native-thread",
        turns: [{
          id: "review-turn",
          status: "failed",
          items: [],
          error: { message: USAGE_LIMIT_MESSAGE },
        }],
      };
    },
    subscribeNotifications: notifications.subscribeNotifications,
  };
  const runner = new ReviewRunner(
    config,
    { warn() {}, info() {}, child: () => ({}) } as never,
    withNativeReview(fakeCodex) as never,
    async (ms) => { sleeps.push(ms); },
  );

  await assert.rejects(
    () => runner.review({
      developerInstructions: "policy",
      reviewPrompt: "review",
      workspace: { worktreePath: "/tmp/native-review" },
      pr: { headSha: "head" },
      diff: { inventory: [], patches: [] },
      promptContext: { guidanceDocs: [] },
    } as never),
    (error: unknown) => error instanceof CodexCapacityError,
  );
  assert.equal(normalizationStarted, false);
  assert.equal(readCalls, 2);
  assert.deepEqual(sleeps, [1_500]);
  assert.equal(notifications.listenerCount(), 0);
});

test("ReviewRunner forks once, sends the bounded follow-up prompt, and keeps a corrective turn on the fork", async () => {
  const config = minimalConfig();
  config.codex.forkPriorReviewThread = true;
  const forkCalls: unknown[] = [];
  const starts: StartTurnOptions[] = [];
  const progress: Array<{ threadId: string; turnId: string }> = [];
  const promptLogs: Array<Record<string, unknown>> = [];
  const fakeCodex = {
    start: async () => {},
    stop: async () => {},
    startThread: async () => { throw new Error("fresh thread must not start"); },
    forkThread: async (options: unknown) => {
      forkCalls.push(options);
      return { id: "forked-thread", turns: [{ id: "source-turn", status: "completed", items: [] }] };
    },
    startReview: async (options: { threadId: string }) => ({
      turnId: "fork-review-turn",
      status: "running",
      reviewThreadId: options.threadId,
    }),
    startTurn: async (options: StartTurnOptions) => {
      starts.push(options);
      return { turnId: `fork-turn-${starts.length}`, status: "running" };
    },
    readThread: async () => ({
      id: "forked-thread",
      turns: [
        { id: "source-turn", status: "completed", items: [] },
        { id: "fork-review-turn", status: "completed", items: [{ type: "exitedReviewMode", id: "fork-review-turn", review: "Review completed." }] },
        { id: "fork-turn-1", status: "completed", items: [{ type: "agentMessage", text: "not json" }] },
        ...(starts.length === 2
          ? [{ id: "fork-turn-2", status: "completed", items: [{ type: "agentMessage", text: validReviewMessage }] }]
          : []),
      ],
    }),
  };
  const runner = new ReviewRunner(
    config,
    { warn() {}, info: (fields: Record<string, unknown>) => promptLogs.push(fields), debug() {}, child: () => ({}) } as never,
    withNativeReview(fakeCodex) as never,
    async () => {},
  );

  const result = await runner.review({
    developerInstructions: "stable review policy",
    reviewPrompt: "FULL CURRENT REVIEW PROMPT",
    followUpReviewPrompt: "BOUNDED FOLLOW-UP REVIEW PROMPT",
    workspace: { worktreePath: "/tmp/current-head" },
    pr: { headSha: "current-head" },
    diff: {
      inventory: [{ path: "src/one.ts" }, { path: "src/two.ts" }],
      patches: [{ patch: "PATCH BODY SENTINEL" }],
    },
  } as never, {
    onThreadProgress: (value) => progress.push(value),
  }, {
    sourceAttemptId: 17,
    threadId: "source-thread",
    lastTurnId: "source-turn",
    priorHeadSha: "prior-head",
    promptFingerprint: "prompt-1",
  });

  assert.deepEqual(forkCalls, [{ threadId: "source-thread", lastTurnId: "source-turn", cwd: "/tmp/current-head", developerInstructions: "stable review policy" }]);
  assert.match(starts[0]?.input ?? "", /normalization only/i);
  assert.match(starts[1]?.input ?? "", /previous response could not be parsed/i);
  assert.deepEqual(starts.map((entry) => entry.threadId), ["forked-thread", "forked-thread"]);
  assert.equal(result.threadId, "forked-thread");
  assert.equal(result.turnId, "fork-turn-2");
  assert.deepEqual(progress, [
    { threadId: "forked-thread", turnId: "fork-review-turn" },
    { threadId: "forked-thread", turnId: "fork-turn-1" },
    { threadId: "forked-thread", turnId: "fork-turn-2" },
  ]);
  assert.deepEqual(promptLogs[0], {
    reviewMode: "native-two-pass",
    threadStartMode: "forked",
    promptMode: "follow_up",
    threadId: "forked-thread",
    sourceAttemptId: 17,
    sourceThreadId: "source-thread",
    sourceTurnId: "source-turn",
    priorHeadSha: "prior-head",
    currentHeadSha: "current-head",
    inventoryCount: 2,
    guidancePathCount: 0,
    omittedPatchCount: 1,
    omittedPatchChars: "PATCH BODY SENTINEL".length,
    promptChars: "BOUNDED FOLLOW-UP REVIEW PROMPT".length,
  });
});

test("ReviewRunner keeps the fresh path when thread forking is disabled", async () => {
  let forkCalls = 0;
  let freshCalls = 0;
  const starts: StartTurnOptions[] = [];
  const fakeCodex = {
    start: async () => {}, stop: async () => {},
    forkThread: async () => { forkCalls += 1; return { id: "wrong", turns: [] }; },
    startThread: async () => { freshCalls += 1; return { id: "thread-structured", turns: [] }; },
    startTurn: async (options: StartTurnOptions) => {
      starts.push(options);
      return { turnId: "turn-1", status: "running" };
    },
    readThread: async () => completedTurns([validReviewMessage]),
  };
  const runner = new ReviewRunner(minimalConfig(), { warn() {}, child: () => ({}) } as never, withNativeReview(fakeCodex) as never, async () => {});

  await runner.review({ reviewPrompt: "Review", workspace: { worktreePath: "/tmp/current" } } as never, {}, {
    sourceAttemptId: 1, threadId: "source", lastTurnId: "turn", priorHeadSha: "prior-head", promptFingerprint: "prompt-1",
  });
  assert.equal(forkCalls, 0);
  assert.equal(freshCalls, 1);
  assert.match(starts[0]?.input ?? "", /normalization only/i);
});

test("ReviewRunner sends the byte-identical full prompt after a fork source fallback", async () => {
  const config = minimalConfig();
  config.codex.forkPriorReviewThread = true;
  const starts: StartTurnOptions[] = [];
  const reviewStarts: Array<{ instructions: string }> = [];
  const promptLogs: Array<Record<string, unknown>> = [];
  const fakeCodex = {
    start: async () => {}, stop: async () => {},
    forkThread: async () => { throw new CodexJsonRpcError(-32600, "No rollout found for thread id source", null); },
    startThread: async () => ({ id: "fresh-thread", turns: [] }),
    startReview: async (options: { instructions: string }) => {
      reviewStarts.push(options);
      return { turnId: "review-turn", status: "running", reviewThreadId: "fresh-thread" };
    },
    startTurn: async (options: StartTurnOptions) => {
      starts.push(options);
      return { turnId: "turn-1", status: "running" };
    },
    readThread: async () => ({
      id: "fresh-thread",
      turns: [
        { id: "review-turn", status: "completed", items: [{ type: "exitedReviewMode", id: "review-turn", review: "Review completed." }] },
        { id: "turn-1", status: "completed", items: [{ type: "agentMessage", text: validReviewMessage }] },
      ],
    }),
  };
  const runner = new ReviewRunner(config, {
    warn() {}, debug() {}, info: (fields: Record<string, unknown>) => promptLogs.push(fields), child: () => ({}),
  } as never, withNativeReview(fakeCodex) as never, async () => {});
  const fullPrompt = "FULL PROMPT WITH PATCH BODY SENTINEL";

  await runner.review({
    reviewPrompt: fullPrompt,
    followUpReviewPrompt: "FOLLOW-UP MUST NOT BE SENT",
    workspace: { worktreePath: "/tmp/current" },
    pr: { headSha: "current-head" },
    diff: { inventory: [], patches: [{ patch: "PATCH BODY SENTINEL" }] },
  } as never, {}, {
    sourceAttemptId: 1,
    threadId: "source",
    lastTurnId: "source-turn",
    priorHeadSha: "prior-head",
    promptFingerprint: "prompt-1",
  });

  assert.equal(reviewStarts[0]?.instructions, fullPrompt);
  assert.equal(promptLogs[0]?.threadStartMode, "fresh_fallback");
  assert.equal(promptLogs[0]?.promptMode, "full");
  assert.equal(promptLogs[0]?.guidancePathCount, 0);
  assert.equal(promptLogs[0]?.omittedPatchCount, 1);
  assert.equal(promptLogs[0]?.omittedPatchChars, "PATCH BODY SENTINEL".length);
  assert.equal(promptLogs[0]?.promptChars, fullPrompt.length);
});

test("ReviewRunner disables unsupported thread/fork once across concurrent starts", async () => {
  const config = minimalConfig();
  config.codex.forkPriorReviewThread = true;
  let forkCalls = 0;
  let freshCalls = 0;
  const warnings: string[] = [];
  let release!: () => void;
  const bothStarted = new Promise<void>((resolve) => { release = resolve; });
  const fakeCodex = {
    start: async () => {}, stop: async () => {}, startTurn: async () => ({ turnId: "unused", status: "running" }),
    readThread: async () => ({ id: "unused", turns: [] }),
    forkThread: async () => {
      forkCalls += 1;
      if (forkCalls === 2) release();
      await bothStarted;
      throw new CodexJsonRpcError(-32601, "Method not found", null);
    },
    startThread: async () => ({ id: `fresh-${++freshCalls}`, turns: [] }),
  };
  const runner = new ReviewRunner(config, {
    warn: (...args: unknown[]) => warnings.push(String(args.at(-1))), debug() {}, child: () => ({}),
  } as never, withNativeReview(fakeCodex) as never, async () => {});
  const start = (runner as unknown as {
    startReviewThread(cwd: string, candidate: unknown, signal?: AbortSignal): Promise<{ thread: { id: string }; mode: string }>;
  }).startReviewThread.bind(runner);
  const candidate = { sourceAttemptId: 1, threadId: "source", lastTurnId: "turn", priorHeadSha: "prior-head", promptFingerprint: "prompt-1" };

  const first = await Promise.all([start("/tmp/one", candidate), start("/tmp/two", candidate)]);
  const third = await start("/tmp/three", candidate);
  assert.deepEqual(first.map((result) => result.thread.id), ["fresh-1", "fresh-2"]);
  assert.equal(third.thread.id, "fresh-3");
  assert.ok([...first, third].every((result) => result.mode === "fresh_fallback"));
  assert.equal(forkCalls, 2);
  assert.equal(warnings.length, 1);
});

test("ReviewRunner falls back for the real missing source rollout payload without disabling forks", async () => {
  const config = minimalConfig();
  config.codex.forkPriorReviewThread = true;
  let forkCalls = 0;
  let freshCalls = 0;
  const fakeCodex = {
    start: async () => {}, stop: async () => {}, startTurn: async () => ({ turnId: "unused", status: "running" }),
    readThread: async () => ({ id: "unused", turns: [] }),
    forkThread: async () => {
      forkCalls += 1;
      throw new CodexJsonRpcError(-32600, "No rollout found for thread id source-1", null);
    },
    startThread: async () => ({ id: `fresh-${++freshCalls}`, turns: [] }),
  };
  const runner = new ReviewRunner(config, { warn() {}, debug() {}, child: () => ({}) } as never, withNativeReview(fakeCodex) as never, async () => {});
  const start = (runner as unknown as {
    startReviewThread(cwd: string, candidate: unknown, signal?: AbortSignal): Promise<{ thread: { id: string }; mode: string }>;
  }).startReviewThread.bind(runner);
  const candidate = { sourceAttemptId: 1, threadId: "source", lastTurnId: "turn", priorHeadSha: "prior-head", promptFingerprint: "prompt-1" };

  assert.equal((await start("/tmp/one", candidate)).thread.id, "fresh-1");
  assert.equal((await start("/tmp/two", candidate)).thread.id, "fresh-2");
  assert.equal(forkCalls, 2, "source misses must not disable the capability");
});

test("ReviewRunner propagates unsafe fork failures without starting fresh", async () => {
  const failures = [
    new CodexJsonRpcError(-32602, "Invalid params", { field: "model" }),
    new Error("Codex app-server request timed out after 30000ms"),
    new CodexJsonRpcError(-32001, "Authentication required", null),
    new CodexJsonRpcError(-32000, "Source thread source-1 not found", null),
    new CodexJsonRpcError(-32000, "No rollout found for thread id source-1", null),
    new CodexJsonRpcError(-32600, "No rollout found for thread", null),
    new Error("socket disconnected"),
  ];
  for (const failure of failures) {
    const config = minimalConfig();
    config.codex.forkPriorReviewThread = true;
    let freshCalls = 0;
    const runner = new ReviewRunner(config, { warn() {}, debug() {}, child: () => ({}) } as never, {
      start: async () => {}, stop: async () => {}, startTurn: async () => ({ turnId: "unused", status: "running" }),
      readThread: async () => ({ id: "unused", turns: [] }),
      forkThread: async () => { throw failure; },
      startThread: async () => { freshCalls += 1; return { id: "fresh", turns: [] }; },
    } as never, async () => {});
    const start = (runner as unknown as {
      startReviewThread(cwd: string, candidate: unknown): Promise<unknown>;
    }).startReviewThread.bind(runner);
    await assert.rejects(start("/tmp", {
      sourceAttemptId: 1, threadId: "source", lastTurnId: "turn", priorHeadSha: "prior-head", promptFingerprint: "prompt-1",
    }), (error) => error === failure);
    assert.equal(freshCalls, 0);
  }
});

test("ReviewRunner does not fresh-fallback after cancellation during a fork", async () => {
  const config = minimalConfig();
  config.codex.forkPriorReviewThread = true;
  const controller = new AbortController();
  let freshCalls = 0;
  const runner = new ReviewRunner(config, { warn() {}, debug() {}, child: () => ({}) } as never, {
    start: async () => {}, stop: async () => {}, startTurn: async () => ({ turnId: "unused", status: "running" }),
    readThread: async () => ({ id: "unused", turns: [] }),
    forkThread: async () => {
      controller.abort("Superseded head");
      throw new CodexJsonRpcError(-32600, "No rollout found for thread id source", null);
    },
    startThread: async () => { freshCalls += 1; return { id: "fresh", turns: [] }; },
  } as never, async () => {});
  const start = (runner as unknown as {
    startReviewThread(cwd: string, candidate: unknown, signal: AbortSignal): Promise<unknown>;
  }).startReviewThread.bind(runner);

  await assert.rejects(
    start("/tmp", {
      sourceAttemptId: 1, threadId: "source", lastTurnId: "turn", priorHeadSha: "prior-head", promptFingerprint: "prompt-1",
    }, controller.signal),
    ReviewRunInterruptedError,
  );
  assert.equal(freshCalls, 0);
});

test("ReviewRunner keeps waiting when a Codex thread read times out", async () => {
  let readCalls = 0;
  const sleeps: number[] = [];
  const progress: Array<{ threadId: string; turnId: string }> = [];
  const fakeCodex = {
    start: async () => {},
    stop: async () => {},
    startThread: async () => ({ id: "thread-1", turns: [] }),
    startTurn: async () => ({ turnId: "turn-1", status: "running" }),
    readThread: async () => {
      readCalls += 1;
      if (readCalls === 1) {
        throw new Error("Codex app-server request timed out after 30000ms");
      }
      return {
        id: "thread-1",
        turns: [
          {
            id: "turn-1",
            status: "completed",
            items: [
              {
                type: "agentMessage",
                text: JSON.stringify({
                  walkthrough: "The patch is straightforward.",
                  architectural_concerns: [],
                  findings: [],
                  verdict: "approve",
                  verdict_reason: "No blocking issues found.",
                }),
              },
            ],
          },
        ],
      };
    },
  };
  const runner = new ReviewRunner(
    minimalConfig(),
    { warn: () => {}, child: () => ({}) } as never,
    withNativeReview(fakeCodex) as never,
    async (ms) => {
      sleeps.push(ms);
    },
  );

  const result = await runner.review({
    reviewPrompt: "Review this PR.",
    workspace: { worktreePath: "/tmp/review-quill-test" },
  } as never, { onThreadProgress: (value) => progress.push(value) });

  assert.equal(result.threadId, "thread-1");
  assert.equal(result.turnId, "turn-1");
  assert.equal(result.verdict.verdict, "approve");
  assert.equal(readCalls, 2);
  assert.deepEqual(sleeps, [1_500]);
  assert.deepEqual(progress, [
    { threadId: "thread-1", turnId: "native-review-turn" },
    { threadId: "thread-1", turnId: "turn-1" },
  ]);
});

test("ReviewRunner buffers an early matching completion and ignores unrelated or duplicate notifications", async () => {
  const notifications = notificationHarness();
  let readCalls = 0;
  const sleeps: number[] = [];
  const fakeCodex = {
    start: async () => {},
    stop: async () => {},
    startThread: async () => ({ id: "thread-1", turns: [] }),
    subscribeNotifications: notifications.subscribeNotifications,
    startTurn: async () => {
      notifications.emit({ method: "turn/completed", params: { threadId: "other-thread", turn: { id: "turn-1" } } });
      notifications.emit({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "old-turn" } } });
      notifications.emit({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1" } } });
      notifications.emit({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1" } } });
      return { turnId: "turn-1", status: "running" };
    },
    readThread: async () => {
      readCalls += 1;
      return completedTurns([validReviewMessage]);
    },
  };
  const runner = new ReviewRunner(
    minimalConfig(),
    { warn() {}, info() {}, child: () => ({}) } as never,
    withNativeReview(fakeCodex) as never,
    async (ms) => { sleeps.push(ms); },
  );

  const result = await runner.review({
    reviewPrompt: "Review this PR.",
    workspace: { worktreePath: "/tmp/review-quill-test" },
  } as never);

  assert.equal(result.verdict.verdict, "approve");
  assert.equal(readCalls, 1);
  assert.deepEqual(sleeps, []);
  assert.equal(notifications.listenerCount(), 0);
});

test("ReviewRunner falls back to polling after the notification watchdog", async () => {
  const notifications = notificationHarness();
  let readCalls = 0;
  const sleeps: number[] = [];
  const fakeCodex = {
    start: async () => {},
    stop: async () => {},
    startThread: async () => ({ id: "thread-structured", turns: [] }),
    subscribeNotifications: notifications.subscribeNotifications,
    startTurn: async () => ({ turnId: "turn-1", status: "running" }),
    readThread: async () => {
      readCalls += 1;
      return readCalls === 1
        ? { id: "thread-structured", turns: [{ id: "turn-1", status: "inProgress", items: [] }] }
        : completedTurns([validReviewMessage]);
    },
  };
  const runner = new ReviewRunner(
    minimalConfig(),
    { warn() {}, info() {}, child: () => ({}) } as never,
    withNativeReview(fakeCodex) as never,
    async (ms) => { sleeps.push(ms); },
    0,
  );

  const result = await runner.review({
    reviewPrompt: "Review this PR.",
    workspace: { worktreePath: "/tmp/review-quill-test" },
  } as never);

  assert.equal(result.verdict.verdict, "approve");
  assert.equal(readCalls, 2);
  assert.deepEqual(sleeps, [1_500]);
  assert.equal(notifications.listenerCount(), 0);
});

test("ReviewRunner applies terminal error classification after a completion notification", async () => {
  const notifications = notificationHarness();
  const fakeCodex = {
    start: async () => {},
    stop: async () => {},
    startThread: async () => ({ id: "thread-failed", turns: [] }),
    subscribeNotifications: notifications.subscribeNotifications,
    startTurn: async () => {
      notifications.emit({ method: "turn/completed", params: { threadId: "thread-failed", turn: { id: "turn-failed" } } });
      return { turnId: "turn-failed", status: "running" };
    },
    readThread: async () => ({
      id: "thread-failed",
      turns: [{ id: "turn-failed", status: "failed", items: [], error: { message: "sandbox denied write access" } }],
    }),
  };
  const runner = new ReviewRunner(
    minimalConfig(),
    { warn() {}, child: () => ({}) } as never,
    withNativeReview(fakeCodex) as never,
    async () => {},
  );

  await assert.rejects(
    runner.review({ reviewPrompt: "Review", workspace: { worktreePath: "/tmp/review-quill-test" } } as never),
    /Review turn ended with status failed: sandbox denied write access/,
  );
  assert.equal(notifications.listenerCount(), 0);
});

test("ReviewRunner retries Codex thread start when rollout jsonl is empty", async () => {
  let startThreadCalls = 0;
  const sleeps: number[] = [];
  const fakeCodex = {
    start: async () => {},
    stop: async () => {},
    startThread: async () => {
      startThreadCalls += 1;
      if (startThreadCalls === 1) {
        throw new Error("rollout-2026-05-24T03-31-22-thread-1.jsonl is empty");
      }
      return { id: "thread-1", turns: [] };
    },
    startTurn: async () => ({ turnId: "turn-1", status: "running" }),
    readThread: async () => ({
      id: "thread-1",
      turns: [
        {
          id: "turn-1",
          status: "completed",
          items: [
            {
              type: "agentMessage",
              text: JSON.stringify({
                walkthrough: "",
                architectural_concerns: [],
                findings: [],
                verdict: "approve",
                verdict_reason: "No blocking issues found.",
              }),
            },
          ],
        },
      ],
    }),
  };
  const runner = new ReviewRunner(
    minimalConfig(),
    { warn: () => {}, child: () => ({}) } as never,
    withNativeReview(fakeCodex) as never,
    async (ms) => {
      sleeps.push(ms);
    },
  );

  const result = await runner.review({
    reviewPrompt: "Review this PR.",
    workspace: { worktreePath: "/tmp/review-quill-test" },
  } as never);

  assert.equal(result.threadId, "thread-1");
  assert.equal(startThreadCalls, 2);
  assert.deepEqual(sleeps, [750]);
});

test("ReviewRunner continues when bounded thread progress recording fails", async () => {
  const warnings: string[] = [];
  const fakeCodex = {
    start: async () => {},
    stop: async () => {},
    startThread: async () => ({ id: "thread-1", turns: [] }),
    startTurn: async () => ({ turnId: "turn-1", status: "running" }),
    readThread: async () => ({
      id: "thread-1",
      turns: [{
        id: "turn-1",
        status: "completed",
        items: [{
          type: "agentMessage",
          text: JSON.stringify({
            walkthrough: "The patch is straightforward.",
            architectural_concerns: [],
            findings: [],
            verdict: "approve",
            verdict_reason: "No blocking issues found.",
          }),
        }],
      }],
    }),
  };
  const runner = new ReviewRunner(
    minimalConfig(),
    {
      warn: (_data: unknown, message: string) => warnings.push(message),
      child: () => ({}),
    } as never,
    withNativeReview(fakeCodex) as never,
    async () => {},
  );

  const result = await runner.review({
    reviewPrompt: "Review this PR.",
    workspace: { worktreePath: "/tmp/review-quill-test" },
  } as never, {
    onThreadProgress: () => { throw new Error("database is read-only"); },
  });

  assert.equal(result.verdict.verdict, "approve");
  assert.deepEqual(warnings, [
    "Failed to record Codex thread progress; continuing review",
    "Failed to record Codex thread progress; continuing review",
  ]);
});

test("ReviewRunner records bounded progress once when a turn starts", async () => {
  let readCalls = 0;
  const progress: Array<{ threadId: string; turnId: string }> = [];
  const inProgressThread = {
    id: "thread-progress",
    turns: [{
      id: "turn-progress",
      status: "inProgress",
      items: [{ type: "agentMessage", id: "partial", text: "Inspecting the changed files." }],
    }],
  };
  const fakeCodex = {
    start: async () => {},
    stop: async () => {},
    startThread: async () => ({ id: "thread-progress", turns: [] }),
    startTurn: async () => ({ turnId: "turn-progress", status: "running" }),
    readThread: async () => {
      readCalls += 1;
      if (readCalls <= 2) return structuredClone(inProgressThread);
      return {
        id: "thread-progress",
        turns: [{
          id: "turn-progress",
          status: "completed",
          items: [{
            type: "agentMessage",
            id: "final",
            text: JSON.stringify({
              walkthrough: "The patch is straightforward.",
              architectural_concerns: [],
              findings: [],
              verdict: "approve",
              verdict_reason: "No blocking issues found.",
            }),
          }],
        }],
      };
    },
  };
  const runner = new ReviewRunner(
    minimalConfig(),
    { warn: () => {}, child: () => ({}) } as never,
    withNativeReview(fakeCodex) as never,
    async () => {},
  );

  const result = await runner.review({
    reviewPrompt: "Review this PR.",
    workspace: { worktreePath: "/tmp/review-quill-test" },
  } as never, { onThreadProgress: (value) => progress.push(value) });

  assert.equal(result.verdict.verdict, "approve");
  assert.equal(readCalls, 3);
  assert.deepEqual(progress, [
    { threadId: "thread-progress", turnId: "native-review-turn" },
    { threadId: "thread-progress", turnId: "turn-progress" },
  ]);
});

test("ReviewRunner retries Codex turn start when rollout jsonl is empty", async () => {
  let startTurnCalls = 0;
  const sleeps: number[] = [];
  const fakeCodex = {
    start: async () => {},
    stop: async () => {},
    startThread: async () => ({ id: "thread-1", turns: [] }),
    startTurn: async () => {
      startTurnCalls += 1;
      if (startTurnCalls === 1) {
        throw new Error("rollout-2026-05-24T04-05-43-thread-1.jsonl is empty");
      }
      return { turnId: "turn-1", status: "running" };
    },
    readThread: async () => ({
      id: "thread-1",
      turns: [
        {
          id: "turn-1",
          status: "completed",
          items: [
            {
              type: "agentMessage",
              text: JSON.stringify({
                walkthrough: "",
                architectural_concerns: [],
                findings: [],
                verdict: "approve",
                verdict_reason: "No blocking issues found.",
              }),
            },
          ],
        },
      ],
    }),
  };
  const runner = new ReviewRunner(
    minimalConfig(),
    { warn: () => {}, child: () => ({}) } as never,
    withNativeReview(fakeCodex) as never,
    async (ms) => {
      sleeps.push(ms);
    },
  );

  const result = await runner.review({
    reviewPrompt: "Review this PR.",
    workspace: { worktreePath: "/tmp/review-quill-test" },
  } as never);

  assert.equal(result.turnId, "turn-1");
  assert.equal(startTurnCalls, 2);
  assert.deepEqual(sleeps, [750]);
});

test("ReviewRunner retries normalization while the native review turn is closing", async () => {
  let startTurnCalls = 0;
  const sleeps: number[] = [];
  const fakeCodex = {
    start: async () => {},
    stop: async () => {},
    startThread: async () => ({ id: "thread-1", turns: [] }),
    startTurn: async () => {
      startTurnCalls += 1;
      if (startTurnCalls === 1) {
        throw new CodexJsonRpcError(
          -32603,
          "failed to submit turn input: ActiveTurnNotSteerable { turn_kind: Review }",
          undefined,
        );
      }
      return { turnId: "turn-1", status: "running" };
    },
    readThread: async () => completedTurns([validReviewMessage]),
  };
  const runner = new ReviewRunner(
    minimalConfig(),
    { warn() {}, child: () => ({}) } as never,
    withNativeReview(fakeCodex) as never,
    async (ms) => { sleeps.push(ms); },
  );

  const result = await runner.review({
    reviewPrompt: "Review this PR.",
    workspace: { worktreePath: "/tmp/review-quill-test" },
  } as never);

  assert.equal(result.verdict.verdict, "approve");
  assert.equal(startTurnCalls, 2);
  assert.deepEqual(sleeps, [750]);
});

test("ReviewRunner interrupts a running Codex turn when the review signal aborts", async () => {
  const controller = new AbortController();
  let readCalls = 0;
  let interruptCalls = 0;
  const sleeps: number[] = [];
  const progress: Array<{ threadId: string; turnId: string }> = [];
  const fakeCodex = {
    start: async () => {},
    stop: async () => {},
    startThread: async () => ({ id: "thread-1", turns: [] }),
    startTurn: async () => ({ turnId: "turn-1", status: "running" }),
    interruptTurn: async (options: { threadId: string; turnId: string }) => {
      interruptCalls += 1;
      assert.deepEqual(options, { threadId: "thread-1", turnId: "turn-1" });
    },
    readThread: async () => {
      readCalls += 1;
      if (readCalls === 1) {
        controller.abort("Superseded by newer head new-head before review completed.");
      }
      return {
        id: "thread-1",
        turns: [
          {
            id: "turn-1",
            status: interruptCalls > 0 ? "interrupted" : "inProgress",
            items: [],
          },
        ],
      };
    },
  };
  const runner = new ReviewRunner(
    minimalConfig(),
    { warn: () => {}, child: () => ({}) } as never,
    withNativeReview(fakeCodex) as never,
    async (ms) => {
      sleeps.push(ms);
    },
  );

  await assert.rejects(
    () => runner.review({
      reviewPrompt: "Review this PR.",
      workspace: { worktreePath: "/tmp/review-quill-test" },
    } as never, { signal: controller.signal, onThreadProgress: (value) => progress.push(value) }),
    (error: unknown) => {
      assert.ok(error instanceof ReviewRunInterruptedError);
      assert.equal(error.threadId, "thread-1");
      assert.equal(error.turnId, "turn-1");
      assert.match(error.message, /Superseded by newer head new-head/);
      return true;
    },
  );

  assert.equal(interruptCalls, 1);
  assert.equal(readCalls, 1);
  assert.deepEqual(sleeps, []);
  assert.deepEqual(progress, [
    { threadId: "thread-1", turnId: "native-review-turn" },
    { threadId: "thread-1", turnId: "turn-1" },
  ]);
});

test("ReviewRunner interrupts once when cancellation arrives before startTurn responds and removes its listener", async () => {
  const controller = new AbortController();
  const notifications = notificationHarness();
  let interruptCalls = 0;
  const fakeCodex = {
    start: async () => {},
    stop: async () => {},
    startThread: async () => ({ id: "thread-1", turns: [] }),
    subscribeNotifications: notifications.subscribeNotifications,
    startTurn: async () => {
      controller.abort("New head arrived.");
      notifications.emit({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1" } } });
      return { turnId: "turn-1", status: "running" };
    },
    interruptTurn: async () => { interruptCalls += 1; },
    readThread: async () => ({
      id: "thread-1",
      turns: [{ id: "turn-1", status: "interrupted", items: [] }],
    }),
  };
  const runner = new ReviewRunner(
    minimalConfig(),
    { warn() {}, child: () => ({}) } as never,
    withNativeReview(fakeCodex) as never,
    async () => {},
  );

  await assert.rejects(
    runner.review(
      { reviewPrompt: "Review", workspace: { worktreePath: "/tmp/review-quill-test" } } as never,
      { signal: controller.signal },
    ),
    (error: unknown) => error instanceof ReviewRunInterruptedError && error.turnId === "turn-1",
  );
  assert.equal(interruptCalls, 1);
  assert.equal(notifications.listenerCount(), 0);
});

test("ReviewRunner fails fast when the Codex app-server reports a failed turn", async () => {
  const sleeps: number[] = [];
  const progress: Array<{ threadId: string; turnId: string }> = [];
  const fakeCodex = {
    start: async () => {},
    stop: async () => {},
    startThread: async () => ({ id: "thread-failed", turns: [] }),
    startTurn: async () => ({ turnId: "turn-failed", status: "running" }),
    readThread: async () => ({
      id: "thread-failed",
      turns: [
        {
          id: "turn-failed",
          status: "failed",
          items: [
            {
              type: "agentMessage",
              text: "partial output before app-server failure",
            },
          ],
        },
      ],
    }),
  };
  const runner = new ReviewRunner(
    minimalConfig(),
    { warn: () => {}, child: () => ({}) } as never,
    withNativeReview(fakeCodex) as never,
    async (ms) => {
      sleeps.push(ms);
    },
  );

  await assert.rejects(
    () => runner.review({
      reviewPrompt: "Review this PR.",
      workspace: { worktreePath: "/tmp/review-quill-test" },
    } as never, { onThreadProgress: (value) => progress.push(value) }),
    /Review turn ended with status failed/,
  );
  assert.deepEqual(sleeps, []);
  assert.deepEqual(progress, [
    { threadId: "thread-failed", turnId: "native-review-turn" },
    { threadId: "thread-failed", turnId: "turn-failed" },
  ]);
});

test("ReviewRunner does not retry non-materialization app-server start failures", async () => {
  let startThreadCalls = 0;
  const sleeps: number[] = [];
  const fakeCodex = {
    start: async () => {},
    stop: async () => {},
    startThread: async () => {
      startThreadCalls += 1;
      throw new Error("Codex app-server exited before accepting the review thread");
    },
    startTurn: async () => ({ turnId: "turn-never-started", status: "running" }),
    readThread: async () => ({ id: "thread-never-started", turns: [] }),
  };
  const runner = new ReviewRunner(
    minimalConfig(),
    { warn: () => {}, child: () => ({}) } as never,
    withNativeReview(fakeCodex) as never,
    async (ms) => {
      sleeps.push(ms);
    },
  );

  await assert.rejects(
    () => runner.review({
      reviewPrompt: "Review this PR.",
      workspace: { worktreePath: "/tmp/review-quill-test" },
    } as never),
    /exited before accepting/,
  );
  assert.equal(startThreadCalls, 1);
  assert.deepEqual(sleeps, []);
});

const USAGE_LIMIT_MESSAGE = "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), "
  + "visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 3:23 AM.";

function runnerWithCompletedTurn(turn: Record<string, unknown>): ReviewRunner {
  const fakeCodex = {
    start: async () => {},
    stop: async () => {},
    startThread: async () => ({ id: "thread-1", turns: [] }),
    startTurn: async () => ({ turnId: "turn-1", status: "running" }),
    readThread: async () => ({ id: "thread-1", turns: [turn] }),
  };
  return new ReviewRunner(
    minimalConfig(),
    { warn: () => {}, child: () => ({}) } as never,
    withNativeReview(fakeCodex) as never,
    async () => {},
  );
}

test("ReviewRunner throws a typed capacity error when the turn completed with a usage-limit error and no message", async () => {
  const runner = runnerWithCompletedTurn({
    id: "turn-1",
    status: "completed",
    items: [],
    error: { message: USAGE_LIMIT_MESSAGE },
  });

  await assert.rejects(
    () => runner.review({
      reviewPrompt: "Review this PR.",
      workspace: { worktreePath: "/tmp/review-quill-test" },
    } as never),
    (error: unknown) => {
      assert.ok(error instanceof CodexCapacityError);
      assert.equal(error.name, "CodexCapacityError");
      assert.equal(error.detail, USAGE_LIMIT_MESSAGE);
      assert.ok(error.retryAtIso, "retryAtIso must be parsed from the 'try again at' clause");
      assert.match(error.message, /usage limit/i);
      return true;
    },
  );
});

test("ReviewRunner surfaces the real turn error text when there is no assistant message", async () => {
  const runner = runnerWithCompletedTurn({
    id: "turn-1",
    status: "completed",
    items: [],
    error: { message: "stream disconnected before completion" },
  });

  await assert.rejects(
    () => runner.review({
      reviewPrompt: "Review this PR.",
      workspace: { worktreePath: "/tmp/review-quill-test" },
    } as never),
    /Review run completed without an assistant message: stream disconnected before completion/,
  );
});

test("ReviewRunner keeps the generic message when the empty turn carries no error", async () => {
  const runner = runnerWithCompletedTurn({
    id: "turn-1",
    status: "completed",
    items: [],
  });

  await assert.rejects(
    () => runner.review({
      reviewPrompt: "Review this PR.",
      workspace: { worktreePath: "/tmp/review-quill-test" },
    } as never),
    /Review run completed without an assistant message$/,
  );
});

test("ReviewRunner classifies a failed turn carrying a usage-limit error as a capacity error", async () => {
  const runner = runnerWithCompletedTurn({
    id: "turn-1",
    status: "failed",
    items: [],
    error: { message: USAGE_LIMIT_MESSAGE },
  });

  await assert.rejects(
    () => runner.review({
      reviewPrompt: "Review this PR.",
      workspace: { worktreePath: "/tmp/review-quill-test" },
    } as never),
    (error: unknown) => error instanceof CodexCapacityError,
  );
});

test("ReviewRunner includes the turn error text when a turn fails for non-capacity reasons", async () => {
  const runner = runnerWithCompletedTurn({
    id: "turn-1",
    status: "failed",
    items: [],
    error: { message: "sandbox denied write access" },
  });

  await assert.rejects(
    () => runner.review({
      reviewPrompt: "Review this PR.",
      workspace: { worktreePath: "/tmp/review-quill-test" },
    } as never),
    /Review turn ended with status failed: sandbox denied write access/,
  );
});
