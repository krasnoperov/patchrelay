import assert from "node:assert/strict";
import test from "node:test";
import { ReviewRunner } from "../src/review-runner.ts";
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

test("ReviewRunner keeps waiting when a Codex thread read times out", async () => {
  let readCalls = 0;
  const sleeps: number[] = [];
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
  } as never);

  assert.equal(result.threadId, "thread-1");
  assert.equal(result.turnId, "turn-1");
  assert.equal(result.verdict.verdict, "approve");
  assert.equal(readCalls, 2);
  assert.deepEqual(sleeps, [1_500]);
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
