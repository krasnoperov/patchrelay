import assert from "node:assert/strict";
import test from "node:test";
import pino from "pino";
import { runPrepareWorktreeHookWithRetries, startTurnAfterInitialGoal } from "../src/run-launcher.ts";

const logger = pino({ enabled: false });

test("prepare-worktree hook is retried before launch failure", async () => {
  let attempts = 0;

  await runPrepareWorktreeHookWithRetries({
    repoPath: "/repo",
    worktreePath: "/worktree",
    hookEnv: {
      PATCHRELAY_ISSUE_KEY: "USE-1",
      PATCHRELAY_BRANCH: "use/one",
      PATCHRELAY_STAGE: "implementation",
      PATCHRELAY_WORKTREE: "/worktree",
    },
    logger,
    issueKey: "USE-1",
    runType: "implementation",
    maxAttempts: 3,
    retryDelayMs: 0,
    runHook: async () => {
      attempts += 1;
      return attempts === 1
        ? { ran: true, exitCode: 1, stderr: "" }
        : { ran: true, exitCode: 0 };
    },
  });

  assert.equal(attempts, 2);
});

test("prepare-worktree hook failure reports empty output after retries", async () => {
  let attempts = 0;

  await assert.rejects(
    () => runPrepareWorktreeHookWithRetries({
      repoPath: "/repo",
      worktreePath: "/worktree",
      hookEnv: {
        PATCHRELAY_ISSUE_KEY: "USE-2",
        PATCHRELAY_BRANCH: "use/two",
        PATCHRELAY_STAGE: "implementation",
        PATCHRELAY_WORKTREE: "/worktree",
      },
      logger,
      issueKey: "USE-2",
      runType: "implementation",
      maxAttempts: 2,
      retryDelayMs: 0,
      runHook: async () => {
        attempts += 1;
        return { ran: true, exitCode: 1, stderr: "" };
      },
    }),
    /prepare-worktree hook failed \(exit 1\): \[no output\] after 2 attempts/,
  );

  assert.equal(attempts, 2);
});

test("explicit implementation goal is set before the first turn", async () => {
  const calls: string[] = [];
  const result = await startTurnAfterInitialGoal({
    codex: {
      async setThreadGoal(options) {
        calls.push(`goal:${options.objective}`);
        return {} as never;
      },
      async startTurn() {
        calls.push("turn");
        return { threadId: "implementation-thread", turnId: "turn-1", status: "inProgress" };
      },
    },
    threadId: "implementation-thread",
    cwd: "/worktree",
    input: "Full unchanged issue prompt",
    initialGoal: "Ship the requested behavior",
  });

  assert.deepEqual(calls, ["goal:Ship the requested behavior", "turn"]);
  assert.equal(result.turnId, "turn-1");
});

test("explicit implementation goal failure prevents the first turn", async () => {
  let turnStarted = false;
  await assert.rejects(
    () => startTurnAfterInitialGoal({
      codex: {
        async setThreadGoal() {
          throw new Error("goal unavailable");
        },
        async startTurn() {
          turnStarted = true;
          return { threadId: "implementation-thread", turnId: "turn-1", status: "inProgress" };
        },
      },
      threadId: "implementation-thread",
      cwd: "/worktree",
      input: "Full unchanged issue prompt",
      initialGoal: "Ship the requested behavior",
    }),
    /goal unavailable/,
  );

  assert.equal(turnStarted, false);
});

test("a fresh implementation turn starts directly when no explicit goal exists", async () => {
  const calls: string[] = [];
  await startTurnAfterInitialGoal({
    codex: {
      async setThreadGoal() {
        calls.push("goal");
        return {} as never;
      },
      async startTurn() {
        calls.push("turn");
        return { threadId: "implementation-thread", turnId: "turn-1", status: "inProgress" };
      },
    },
    threadId: "implementation-thread",
    cwd: "/worktree",
    input: "Full unchanged issue prompt",
  });

  assert.deepEqual(calls, ["turn"]);
});
