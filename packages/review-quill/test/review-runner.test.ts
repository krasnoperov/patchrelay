import assert from "node:assert/strict";
import test from "node:test";
import { ReviewRunInterruptedError, ReviewRunner } from "../src/review-runner.ts";
import { isUnsupportedOutputSchemaError } from "../src/review-runner.ts";
import { CodexJsonRpcError, type StartTurnOptions } from "../src/codex-app-server.ts";
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
      outputSchema: true,
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

test("ReviewRunner sends the canonical output schema on initial and corrective turns", async () => {
  const starts: StartTurnOptions[] = [];
  const fakeCodex = {
    start: async () => {},
    stop: async () => {},
    startThread: async () => ({ id: "thread-structured", turns: [] }),
    startTurn: async (options: StartTurnOptions) => {
      starts.push(options);
      return { turnId: `turn-${starts.length}`, status: "running" };
    },
    readThread: async () => completedTurns(starts.length === 1 ? ["not json"] : ["not json", validReviewMessage]),
  };
  const runner = new ReviewRunner(minimalConfig(), { warn() {}, info() {}, child: () => ({}) } as never, fakeCodex as never, async () => {});

  const result = await runner.review({
    prompt: "Review this PR.",
    workspace: { worktreePath: "/tmp/review-quill-test" },
  } as never);

  assert.equal(result.verdict.verdict, "approve");
  assert.equal(starts.length, 2);
  assert.deepEqual(starts[0]?.outputSchema, REVIEW_VERDICT_JSON_SCHEMA);
  assert.deepEqual(starts[1]?.outputSchema, REVIEW_VERDICT_JSON_SCHEMA);
});

test("ReviewRunner downgrades once for an explicit unsupported outputSchema error and remembers it", async () => {
  const starts: StartTurnOptions[] = [];
  let successfulTurns = 0;
  const warnings: string[] = [];
  const fakeCodex = {
    start: async () => {},
    stop: async () => {},
    startThread: async () => ({ id: "thread-structured", turns: [] }),
    startTurn: async (options: StartTurnOptions) => {
      starts.push(options);
      if (starts.length === 1) {
        throw new CodexJsonRpcError(-32602, "Unknown parameter: outputSchema", { parameter: "outputSchema" });
      }
      successfulTurns += 1;
      return { turnId: `turn-${successfulTurns}`, status: "running" };
    },
    readThread: async () => completedTurns(successfulTurns === 1 ? ["not json"] : ["not json", validReviewMessage]),
  };
  const runner = new ReviewRunner(minimalConfig(), {
    warn: (_fields: unknown, message: string) => warnings.push(message),
    info() {},
    child: () => ({}),
  } as never, fakeCodex as never, async () => {});

  const result = await runner.review({
    prompt: "Review this PR.",
    workspace: { worktreePath: "/tmp/review-quill-test" },
  } as never);

  assert.equal(result.verdict.verdict, "approve");
  assert.deepEqual(starts.map((start) => Boolean(start.outputSchema)), [true, false, false]);
  assert.equal(warnings.filter((message) => message.includes("does not support turn outputSchema")).length, 1);
});

test("ReviewRunner never downgrades for other invalid params or non-parameter failures", async () => {
  assert.equal(isUnsupportedOutputSchemaError(new CodexJsonRpcError(-32602, "Model is not allowed", { parameter: "model" })), false);
  assert.equal(isUnsupportedOutputSchemaError(new CodexJsonRpcError(-32000, "Unsupported outputSchema", null)), false);
  assert.equal(isUnsupportedOutputSchemaError(new Error("Codex app-server request timed out after 30000ms")), false);

  const original = new CodexJsonRpcError(-32602, "Model is not allowed", { parameter: "model" });
  let startCalls = 0;
  const runner = new ReviewRunner(minimalConfig(), { warn() {}, child: () => ({}) } as never, {
    start: async () => {},
    stop: async () => {},
    startThread: async () => ({ id: "thread-structured", turns: [] }),
    startTurn: async () => {
      startCalls += 1;
      throw original;
    },
    readThread: async () => completedTurns([]),
  } as never, async () => {});

  await assert.rejects(
    runner.review({ prompt: "Review", workspace: { worktreePath: "/tmp/review-quill-test" } } as never),
    (error: unknown) => error === original,
  );
  assert.equal(startCalls, 1);
});

test("ReviewRunner omits outputSchema when the rollout flag is disabled", async () => {
  const config = minimalConfig();
  config.codex.outputSchema = false;
  const starts: StartTurnOptions[] = [];
  const runner = new ReviewRunner(config, { warn() {}, child: () => ({}) } as never, {
    start: async () => {},
    stop: async () => {},
    startThread: async () => ({ id: "thread-structured", turns: [] }),
    startTurn: async (options: StartTurnOptions) => {
      starts.push(options);
      return { turnId: "turn-1", status: "running" };
    },
    readThread: async () => completedTurns([validReviewMessage]),
  } as never, async () => {});

  await runner.review({ prompt: "Review", workspace: { worktreePath: "/tmp/review-quill-test" } } as never);
  assert.equal(starts[0]?.outputSchema, undefined);
});

test("ReviewRunner keeps waiting when a Codex thread read times out", async () => {
  let readCalls = 0;
  const sleeps: number[] = [];
  const snapshots: Array<{ id: string; turns: Array<{ status: string }> }> = [];
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
    fakeCodex as never,
    async (ms) => {
      sleeps.push(ms);
    },
  );

  const result = await runner.review({
    prompt: "Review this PR.",
    workspace: { worktreePath: "/tmp/review-quill-test" },
  } as never, { onThreadSnapshot: (thread) => snapshots.push(thread) });

  assert.equal(result.threadId, "thread-1");
  assert.equal(result.turnId, "turn-1");
  assert.equal(result.verdict.verdict, "approve");
  assert.equal(readCalls, 2);
  assert.deepEqual(sleeps, [1_500]);
  assert.deepEqual(snapshots.map((thread) => thread.turns.at(-1)?.status), ["running", "completed"]);
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
    fakeCodex as never,
    async (ms) => {
      sleeps.push(ms);
    },
  );

  const result = await runner.review({
    prompt: "Review this PR.",
    workspace: { worktreePath: "/tmp/review-quill-test" },
  } as never);

  assert.equal(result.threadId, "thread-1");
  assert.equal(startThreadCalls, 2);
  assert.deepEqual(sleeps, [750]);
});

test("ReviewRunner continues when thread snapshot persistence fails", async () => {
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
    fakeCodex as never,
    async () => {},
  );

  const result = await runner.review({
    prompt: "Review this PR.",
    workspace: { worktreePath: "/tmp/review-quill-test" },
  } as never, {
    onThreadSnapshot: () => { throw new Error("database is read-only"); },
  });

  assert.equal(result.verdict.verdict, "approve");
  assert.deepEqual(warnings, [
    "Failed to persist Codex thread snapshot; continuing review",
    "Failed to persist Codex thread snapshot; continuing review",
  ]);
});

test("ReviewRunner checkpoints a started turn and only changed in-progress snapshots", async () => {
  let readCalls = 0;
  const snapshots: Array<{ id: string; turns: Array<{ id: string; status: string; items: unknown[] }> }> = [];
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
    fakeCodex as never,
    async () => {},
  );

  const result = await runner.review({
    prompt: "Review this PR.",
    workspace: { worktreePath: "/tmp/review-quill-test" },
  } as never, { onThreadSnapshot: (thread) => snapshots.push(thread) });

  assert.equal(result.verdict.verdict, "approve");
  assert.equal(readCalls, 3);
  assert.deepEqual(
    snapshots.map((thread) => ({
      threadId: thread.id,
      turnId: thread.turns.at(-1)?.id,
      status: thread.turns.at(-1)?.status,
    })),
    [
      { threadId: "thread-progress", turnId: "turn-progress", status: "running" },
      { threadId: "thread-progress", turnId: "turn-progress", status: "inProgress" },
      { threadId: "thread-progress", turnId: "turn-progress", status: "completed" },
    ],
  );
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
    fakeCodex as never,
    async (ms) => {
      sleeps.push(ms);
    },
  );

  const result = await runner.review({
    prompt: "Review this PR.",
    workspace: { worktreePath: "/tmp/review-quill-test" },
  } as never);

  assert.equal(result.turnId, "turn-1");
  assert.equal(startTurnCalls, 2);
  assert.deepEqual(sleeps, [750]);
});

test("ReviewRunner interrupts a running Codex turn when the review signal aborts", async () => {
  const controller = new AbortController();
  let readCalls = 0;
  let interruptCalls = 0;
  const sleeps: number[] = [];
  const snapshots: Array<{ id: string; turns: Array<{ status: string }> }> = [];
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
    fakeCodex as never,
    async (ms) => {
      sleeps.push(ms);
    },
  );

  await assert.rejects(
    () => runner.review({
      prompt: "Review this PR.",
      workspace: { worktreePath: "/tmp/review-quill-test" },
    } as never, { signal: controller.signal, onThreadSnapshot: (thread) => snapshots.push(thread) }),
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
  assert.deepEqual(snapshots.map((thread) => thread.turns.at(-1)?.status), ["running", "interrupted"]);
});

test("ReviewRunner fails fast when the Codex app-server reports a failed turn", async () => {
  const sleeps: number[] = [];
  const snapshots: Array<{ id: string; turns: Array<{ status: string }> }> = [];
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
    fakeCodex as never,
    async (ms) => {
      sleeps.push(ms);
    },
  );

  await assert.rejects(
    () => runner.review({
      prompt: "Review this PR.",
      workspace: { worktreePath: "/tmp/review-quill-test" },
    } as never, { onThreadSnapshot: (thread) => snapshots.push(thread) }),
    /Review turn ended with status failed/,
  );
  assert.deepEqual(sleeps, []);
  assert.deepEqual(snapshots.map((thread) => thread.turns.at(-1)?.status), ["running", "failed"]);
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
    fakeCodex as never,
    async (ms) => {
      sleeps.push(ms);
    },
  );

  await assert.rejects(
    () => runner.review({
      prompt: "Review this PR.",
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
    fakeCodex as never,
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
      prompt: "Review this PR.",
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
      prompt: "Review this PR.",
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
      prompt: "Review this PR.",
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
      prompt: "Review this PR.",
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
      prompt: "Review this PR.",
      workspace: { worktreePath: "/tmp/review-quill-test" },
    } as never),
    /Review turn ended with status failed: sandbox denied write access/,
  );
});
