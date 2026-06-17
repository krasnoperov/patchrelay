import assert from "node:assert/strict";
import test from "node:test";
import pino from "pino";
import { runPrepareWorktreeHookWithRetries } from "../src/run-launcher.ts";

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
