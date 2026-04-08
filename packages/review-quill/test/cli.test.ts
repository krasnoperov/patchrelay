import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { runCli } from "../src/cli.ts";
import { SqliteStore } from "../src/db/sqlite-store.ts";

function createBufferStream() {
  let buffer = "";
  return {
    stream: {
      write(chunk: string): boolean {
        buffer += chunk;
        return true;
      },
    },
    read(): string {
      return buffer;
    },
  };
}

function withEnv(values: Record<string, string | undefined>, run: () => Promise<void> | void): Promise<void> | void {
  const previous = new Map<string, string | undefined>();

  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  const restore = () => {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };

  try {
    const result = run();
    if (result && typeof (result as Promise<void>).then === "function") {
      return (result as Promise<void>).finally(restore);
    }
    restore();
    return result;
  } catch (error) {
    restore();
    throw error;
  }
}

test("help shows dashboard in the root command surface", async () => {
  const stdout = createBufferStream();
  const code = await runCli(["help"], {
    stdout: stdout.stream,
    stderr: createBufferStream().stream,
  });

  assert.equal(code, 0);
  assert.match(stdout.read(), /dashboard \[--config <path>\]/);
  assert.match(stdout.read(), /Everyday commands:/);
  assert.match(stdout.read(), /repo attach <owner\/repo>/);
});

test("unknown command prints help and exits 1", async () => {
  const stderr = createBufferStream();
  const code = await runCli(["dashboard1"], {
    stdout: createBufferStream().stream,
    stderr: stderr.stream,
  });

  assert.equal(code, 1);
  assert.match(stderr.read(), /review-quill/);
  assert.match(stderr.read(), /Command help:/);
  assert.match(stderr.read(), /Error: Unknown command: dashboard1/);
});

test("repo help and alias help both describe the repo command surface", async () => {
  const repoHelp = createBufferStream();
  assert.equal(await runCli(["repo", "--help"], {
    stdout: repoHelp.stream,
    stderr: createBufferStream().stream,
  }), 0);
  assert.match(repoHelp.read(), /review-quill repo attach <owner\/repo>/);

  const aliasHelp = createBufferStream();
  assert.equal(await runCli(["attach", "--help"], {
    stdout: aliasHelp.stream,
    stderr: createBufferStream().stream,
  }), 0);
  assert.match(aliasHelp.read(), /review-quill repo attach <owner\/repo>/);
});

test("attempts shows recorded review history for one PR", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "review-quill-cli-"));
  try {
    const configDir = path.join(baseDir, "config");
    mkdirSync(configDir, { recursive: true });
    const configPath = path.join(configDir, "review-quill.json");
    const dbPath = path.join(baseDir, "review-quill.sqlite");

    writeFileSync(configPath, `${JSON.stringify({
      server: { bind: "127.0.0.1", port: 8788, publicBaseUrl: "https://review-quill.example.com" },
      database: { path: dbPath, wal: true },
      codex: {
        bin: "codex",
        args: ["app-server"],
        approvalPolicy: "never",
        sandboxMode: "danger-full-access",
      },
      repositories: [
        {
          repoId: "mafia",
          repoFullName: "krasnoperov/mafia",
          baseBranch: "main",
          requiredChecks: [],
          reviewDocs: ["REVIEW_WORKFLOW.md"],
          excludeBranches: [],
          diffIgnore: [],
          diffSummarizeOnly: [],
          patchBodyBudgetTokens: 12000,
        },
      ],
    }, null, 2)}\n`, "utf8");

    const store = new SqliteStore(dbPath);
    store.createAttempt({
      repoFullName: "krasnoperov/mafia",
      prNumber: 42,
      headSha: "abc1234",
      status: "queued",
    });
    const completed = store.createAttempt({
      repoFullName: "krasnoperov/mafia",
      prNumber: 42,
      headSha: "def5678",
      status: "running",
    });
    store.updateAttempt(completed.id, {
      status: "completed",
      conclusion: "declined",
      summary: "Found a regression in the session bootstrap path.",
      threadId: "thread-review-42",
      turnId: "turn-review-42",
      externalCheckRunId: 9001,
      completedAt: "2026-04-07T10:15:00.000Z",
    });
    store.close();

    await withEnv(
      {
        REVIEW_QUILL_CONFIG: configPath,
        REVIEW_QUILL_CONFIG_DIR: configDir,
        REVIEW_QUILL_WEBHOOK_SECRET: "test-secret",
      },
      async () => {
        const stdout = createBufferStream();
        const stderr = createBufferStream();
        const code = await runCli(["attempts", "mafia", "42"], {
          stdout: stdout.stream,
          stderr: stderr.stream,
        });

        assert.equal(code, 0);
        const rendered = stdout.read();
        assert.match(rendered, /Repo: krasnoperov\/mafia/);
        assert.match(rendered, /PR: #42/);
        assert.match(rendered, /attempt #\d+  completed  declined/);
        assert.match(rendered, /Thread: thread-review-42/);
        assert.match(rendered, /Catalog: search Codex old sessions for thread thread-review-42/);
        assert.match(rendered, /Check run: 9001/);
        assert.match(rendered, /Found a regression in the session bootstrap path/);
      },
    );
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("attempts marks stale active runs and prints the stale reason", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "review-quill-cli-stale-"));
  const originalDateNow = Date.now;
  try {
    const configDir = path.join(baseDir, "config");
    mkdirSync(configDir, { recursive: true });
    const configPath = path.join(configDir, "review-quill.json");
    const dbPath = path.join(baseDir, "review-quill.sqlite");

    writeFileSync(configPath, `${JSON.stringify({
      server: { bind: "127.0.0.1", port: 8788, publicBaseUrl: "https://review-quill.example.com" },
      database: { path: dbPath, wal: true },
      reconciliation: {
        pollIntervalMs: 120000,
        heartbeatIntervalMs: 30000,
        staleQueuedAfterMs: 60000,
        staleRunningAfterMs: 60000,
      },
      codex: {
        bin: "codex",
        args: ["app-server"],
        approvalPolicy: "never",
        sandboxMode: "danger-full-access",
      },
      repositories: [
        {
          repoId: "mafia",
          repoFullName: "krasnoperov/mafia",
          baseBranch: "main",
          requiredChecks: [],
          reviewDocs: ["REVIEW_WORKFLOW.md"],
          excludeBranches: [],
          diffIgnore: [],
          diffSummarizeOnly: [],
          patchBodyBudgetTokens: 12000,
        },
      ],
    }, null, 2)}\n`, "utf8");

    const store = new SqliteStore(dbPath);
    store.createAttempt({
      repoFullName: "krasnoperov/mafia",
      prNumber: 43,
      headSha: "abc1234",
      status: "running",
    });
    store.close();

    Date.now = () => originalDateNow() + 5 * 60_000;

    await withEnv(
      {
        REVIEW_QUILL_CONFIG: configPath,
        REVIEW_QUILL_CONFIG_DIR: configDir,
        REVIEW_QUILL_WEBHOOK_SECRET: "test-secret",
      },
      async () => {
        const stdout = createBufferStream();
        const stderr = createBufferStream();
        const code = await runCli(["attempts", "mafia", "43"], {
          stdout: stdout.stream,
          stderr: stderr.stream,
        });

        assert.equal(code, 0);
        const rendered = stdout.read();
        assert.match(rendered, /attempt #\d+  stale  running/);
        assert.match(rendered, /Stale: Attempt has been running without a heartbeat/);
      },
    );
  } finally {
    Date.now = originalDateNow;
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("transcript shows the full stored Codex thread for one PR review attempt", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "review-quill-cli-transcript-"));
  try {
    const configDir = path.join(baseDir, "config");
    mkdirSync(configDir, { recursive: true });
    const configPath = path.join(configDir, "review-quill.json");
    const dbPath = path.join(baseDir, "review-quill.sqlite");

    writeFileSync(configPath, `${JSON.stringify({
      server: { bind: "127.0.0.1", port: 8788, publicBaseUrl: "https://review-quill.example.com" },
      database: { path: dbPath, wal: true },
      codex: {
        bin: "codex",
        args: ["app-server"],
        approvalPolicy: "never",
        sandboxMode: "danger-full-access",
      },
      repositories: [
        {
          repoId: "mafia",
          repoFullName: "krasnoperov/mafia",
          baseBranch: "main",
          requiredChecks: [],
          reviewDocs: ["REVIEW_WORKFLOW.md"],
          excludeBranches: [],
          diffIgnore: [],
          diffSummarizeOnly: [],
          patchBodyBudgetTokens: 12000,
        },
      ],
    }, null, 2)}\n`, "utf8");

    const store = new SqliteStore(dbPath);
    const attempt = store.createAttempt({
      repoFullName: "krasnoperov/mafia",
      prNumber: 42,
      headSha: "def5678",
      status: "running",
    });
    store.updateAttempt(attempt.id, {
      status: "completed",
      conclusion: "approved",
      summary: "Looks good.",
      threadId: "thread-review-42",
      turnId: "turn-review-42",
      completedAt: "2026-04-07T10:15:00.000Z",
    });
    store.close();

    await withEnv(
      {
        REVIEW_QUILL_CONFIG: configPath,
        REVIEW_QUILL_CONFIG_DIR: configDir,
        REVIEW_QUILL_WEBHOOK_SECRET: "test-secret",
      },
      async () => {
        const stdout = createBufferStream();
        const stderr = createBufferStream();
        const code = await runCli(["transcript", "mafia", "42"], {
          stdout: stdout.stream,
          stderr: stderr.stream,
          readCodexThread: async (threadId) => ({
            id: threadId,
            turns: [
              {
                id: "turn-review-42",
                status: "completed",
                items: [
                  { type: "agentMessage", id: "assistant-1", text: "Review walkthrough paragraph one." },
                  { type: "customItem", id: "item-2", detail: "structured payload" },
                ],
              },
            ],
          }),
        });

        assert.equal(code, 0);
        const rendered = stdout.read();
        assert.match(rendered, /Repo: krasnoperov\/mafia/);
        assert.match(rendered, /Attempt: #\d+/);
        assert.match(rendered, /Thread: thread-review-42/);
        assert.match(rendered, /Visible thread items are shown below/);
        assert.match(rendered, /Turn 1: turn-review-42 \[completed\]/);
        assert.match(rendered, /assistant \(assistant-1\):/);
        assert.match(rendered, /Review walkthrough paragraph one/);
        assert.match(rendered, /item customItem \(item-2\):/);
      },
    );
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("transcript explains when the newest stale attempt has no stored thread", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "review-quill-cli-transcript-stale-"));
  const originalDateNow = Date.now;
  try {
    const configDir = path.join(baseDir, "config");
    mkdirSync(configDir, { recursive: true });
    const configPath = path.join(configDir, "review-quill.json");
    const dbPath = path.join(baseDir, "review-quill.sqlite");

    writeFileSync(configPath, `${JSON.stringify({
      server: { bind: "127.0.0.1", port: 8788, publicBaseUrl: "https://review-quill.example.com" },
      database: { path: dbPath, wal: true },
      reconciliation: {
        pollIntervalMs: 120000,
        heartbeatIntervalMs: 30000,
        staleQueuedAfterMs: 60000,
        staleRunningAfterMs: 60000,
      },
      codex: {
        bin: "codex",
        args: ["app-server"],
        approvalPolicy: "never",
        sandboxMode: "danger-full-access",
      },
      repositories: [
        {
          repoId: "mafia",
          repoFullName: "krasnoperov/mafia",
          baseBranch: "main",
          requiredChecks: [],
          reviewDocs: ["REVIEW_WORKFLOW.md"],
          excludeBranches: [],
          diffIgnore: [],
          diffSummarizeOnly: [],
          patchBodyBudgetTokens: 12000,
        },
      ],
    }, null, 2)}\n`, "utf8");

    const store = new SqliteStore(dbPath);
    const older = store.createAttempt({
      repoFullName: "krasnoperov/mafia",
      prNumber: 44,
      headSha: "older-head",
      status: "running",
    });
    store.updateAttempt(older.id, {
      status: "completed",
      conclusion: "approved",
      summary: "Looks good.",
      threadId: "thread-review-44",
      turnId: "turn-review-44",
      completedAt: "2026-04-07T10:15:00.000Z",
    });
    store.createAttempt({
      repoFullName: "krasnoperov/mafia",
      prNumber: 44,
      headSha: "new-head",
      status: "running",
    });
    store.close();

    Date.now = () => originalDateNow() + 5 * 60_000;

    await withEnv(
      {
        REVIEW_QUILL_CONFIG: configPath,
        REVIEW_QUILL_CONFIG_DIR: configDir,
        REVIEW_QUILL_WEBHOOK_SECRET: "test-secret",
      },
      async () => {
        const stdout = createBufferStream();
        const stderr = createBufferStream();
        const code = await runCli(["transcript", "mafia", "44"], {
          stdout: stdout.stream,
          stderr: stderr.stream,
          readCodexThread: async (threadId) => ({
            id: threadId,
            turns: [
              {
                id: "turn-review-44",
                status: "completed",
                items: [
                  { type: "agentMessage", id: "assistant-1", text: "Recovered review transcript." },
                ],
              },
            ],
          }),
        });

        assert.equal(code, 0);
        const rendered = stdout.read();
        assert.match(rendered, /Newest attempt #\d+ is stale and has no stored Codex thread/);
        assert.match(rendered, /Recovered review transcript/);
      },
    );
  } finally {
    Date.now = originalDateNow;
    rmSync(baseDir, { recursive: true, force: true });
  }
});
