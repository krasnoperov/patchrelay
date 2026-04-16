import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runCli } from "../src/cli.ts";
import { SqliteStore } from "../src/db/sqlite-store.ts";
import {
  buildPrReviewReport,
  classifyAttempt,
  exitCodeForKind,
} from "../src/cli/pr-status.ts";
import type { ReviewAttemptRecord } from "../src/types.ts";

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

function makeAttempt(overrides: Partial<ReviewAttemptRecord>): ReviewAttemptRecord {
  return {
    id: 1,
    repoFullName: "owner/app",
    prNumber: 42,
    headSha: "abc",
    status: "queued",
    createdAt: "2026-04-17T00:00:00Z",
    updatedAt: "2026-04-17T00:00:00Z",
    ...overrides,
  };
}

test("classifyAttempt approved on completed+approved", () => {
  assert.equal(classifyAttempt(makeAttempt({ status: "completed", conclusion: "approved" })).kind, "approved");
});

test("classifyAttempt declined on completed+declined", () => {
  assert.equal(classifyAttempt(makeAttempt({ status: "completed", conclusion: "declined" })).kind, "declined");
});

test("classifyAttempt skipped on completed+skipped", () => {
  assert.equal(classifyAttempt(makeAttempt({ status: "completed", conclusion: "skipped" })).kind, "skipped");
});

test("classifyAttempt errored on completed+error", () => {
  assert.equal(classifyAttempt(makeAttempt({ status: "completed", conclusion: "error" })).kind, "errored");
});

test("classifyAttempt queued on status=queued", () => {
  assert.equal(classifyAttempt(makeAttempt({ status: "queued" })).kind, "queued");
});

test("classifyAttempt running on status=running", () => {
  assert.equal(classifyAttempt(makeAttempt({ status: "running" })).kind, "running");
});

test("classifyAttempt no_attempt when undefined", () => {
  assert.equal(classifyAttempt(undefined).kind, "no_attempt");
});

test("exitCodeForKind maps kinds to exit codes", () => {
  assert.equal(exitCodeForKind("approved"), 0);
  assert.equal(exitCodeForKind("skipped"), 0);
  assert.equal(exitCodeForKind("declined"), 2);
  assert.equal(exitCodeForKind("errored"), 2);
  assert.equal(exitCodeForKind("cancelled"), 2);
  assert.equal(exitCodeForKind("queued"), 3);
  assert.equal(exitCodeForKind("running"), 3);
  assert.equal(exitCodeForKind("no_attempt"), 3);
});

test("buildPrReviewReport sets summaryFirstLine", () => {
  const report = buildPrReviewReport({
    repoId: "app",
    repoFullName: "owner/app",
    prNumber: 42,
    attempt: makeAttempt({ status: "completed", conclusion: "approved", summary: "LGTM\n\nmore details" }),
  });
  assert.equal(report.kind, "approved");
  assert.equal(report.exitCode, 0);
  assert.equal(report.terminal, true);
  assert.equal(report.summaryFirstLine, "LGTM");
});

function withConfig<T>(setup: (configPath: string, dbPath: string) => void, run: () => Promise<T>): Promise<T> {
  const baseDir = mkdtempSync(path.join(tmpdir(), "rq-pr-status-"));
  const configDir = path.join(baseDir, ".config", "review-quill");
  mkdirSync(configDir, { recursive: true });
  const configPath = path.join(configDir, "review-quill.json");
  const dbPath = path.join(baseDir, "rq.sqlite");
  setup(configPath, dbPath);
  const previous: Record<string, string | undefined> = {
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    XDG_STATE_HOME: process.env.XDG_STATE_HOME,
    XDG_DATA_HOME: process.env.XDG_DATA_HOME,
    REVIEW_QUILL_CONFIG: process.env.REVIEW_QUILL_CONFIG,
    REVIEW_QUILL_CONFIG_DIR: process.env.REVIEW_QUILL_CONFIG_DIR,
  };
  process.env.XDG_CONFIG_HOME = path.join(baseDir, ".config");
  process.env.XDG_STATE_HOME = path.join(baseDir, ".state");
  process.env.XDG_DATA_HOME = path.join(baseDir, ".share");
  process.env.REVIEW_QUILL_CONFIG = configPath;
  process.env.REVIEW_QUILL_CONFIG_DIR = configDir;
  const restore = () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(baseDir, { recursive: true, force: true });
  };
  return run().finally(restore) as Promise<T>;
}

function writeConfig(configPath: string, dbPath: string): void {
  writeFileSync(configPath, JSON.stringify({
    server: { bind: "127.0.0.1", port: 8800 },
    database: { path: dbPath, wal: true },
    codex: {
      bin: "codex",
      args: ["app-server"],
      approvalPolicy: "never",
      sandboxMode: "danger-full-access",
    },
    repositories: [
      {
        repoId: "app",
        repoFullName: "owner/app",
        baseBranch: "main",
        requiredChecks: [],
        reviewDocs: [],
        excludeBranches: [],
        diffIgnore: [],
        diffSummarizeOnly: [],
        patchBodyBudgetTokens: 12000,
      },
    ],
  }), "utf8");
}

test("review-quill pr status exits 0 when latest attempt is approved", async () => {
  await withConfig(
    (configPath, dbPath) => {
      writeConfig(configPath, dbPath);
      const store = new SqliteStore(dbPath);
      const attempt = store.createAttempt({
        repoFullName: "owner/app",
        prNumber: 42,
        headSha: "abc",
        status: "running",
      });
      store.updateAttempt(attempt.id, {
        status: "completed",
        conclusion: "approved",
        summary: "LGTM with minor nits.",
        completedAt: "2026-04-17T00:05:00Z",
      });
      store.close();
    },
    async () => {
      const stdout = createBufferStream();
      const code = await runCli(
        ["pr", "status", "--repo", "app", "--pr", "42", "--json"],
        {
          stdout: stdout.stream,
          stderr: createBufferStream().stream,
        },
      );
      assert.equal(code, 0);
      const payload = JSON.parse(stdout.read());
      assert.equal(payload.kind, "approved");
    },
  );
});

test("review-quill pr status exits 2 when latest attempt requested changes", async () => {
  await withConfig(
    (configPath, dbPath) => {
      writeConfig(configPath, dbPath);
      const store = new SqliteStore(dbPath);
      const attempt = store.createAttempt({
        repoFullName: "owner/app",
        prNumber: 42,
        headSha: "abc",
        status: "running",
      });
      store.updateAttempt(attempt.id, {
        status: "completed",
        conclusion: "declined",
        summary: "Found a regression.",
        completedAt: "2026-04-17T00:05:00Z",
      });
      store.close();
    },
    async () => {
      const stdout = createBufferStream();
      const code = await runCli(
        ["pr", "status", "--repo", "app", "--pr", "42", "--json"],
        {
          stdout: stdout.stream,
          stderr: createBufferStream().stream,
        },
      );
      assert.equal(code, 2);
      const payload = JSON.parse(stdout.read());
      assert.equal(payload.kind, "declined");
    },
  );
});

test("review-quill pr status exits 3 when there is no attempt yet", async () => {
  await withConfig(
    (configPath, dbPath) => writeConfig(configPath, dbPath),
    async () => {
      const stdout = createBufferStream();
      const code = await runCli(
        ["pr", "status", "--repo", "app", "--pr", "42", "--json"],
        {
          stdout: stdout.stream,
          stderr: createBufferStream().stream,
        },
      );
      assert.equal(code, 3);
      const payload = JSON.parse(stdout.read());
      assert.equal(payload.kind, "no_attempt");
    },
  );
});

test("review-quill pr status --wait loops until a terminal conclusion is recorded", async () => {
  let sharedDbPath = "";
  await withConfig(
    (configPath, dbPath) => {
      sharedDbPath = dbPath;
      writeConfig(configPath, dbPath);
      const store = new SqliteStore(dbPath);
      store.createAttempt({
        repoFullName: "owner/app",
        prNumber: 42,
        headSha: "abc",
        status: "running",
      });
      store.close();
    },
    async () => {
      const stdout = createBufferStream();
      let sleeps = 0;
      let timeMs = 1_000;
      const code = await runCli(
        ["pr", "status", "--repo", "app", "--pr", "42", "--wait", "--poll", "1", "--json"],
        {
          stdout: stdout.stream,
          stderr: createBufferStream().stream,
          now: () => timeMs,
          sleep: async (ms: number) => {
            sleeps += 1;
            timeMs += ms;
            if (sleeps === 1) {
              const store = new SqliteStore(sharedDbPath);
              const running = store.listAttemptsForPullRequest("owner/app", 42, 10)[0];
              if (running) {
                store.updateAttempt(running.id, {
                  status: "completed",
                  conclusion: "approved",
                  summary: "LGTM",
                  completedAt: "2026-04-17T00:10:00Z",
                });
              }
              store.close();
            }
          },
        },
      );
      assert.equal(code, 0);
      assert.ok(sleeps >= 1);
      const payload = JSON.parse(stdout.read());
      assert.equal(payload.kind, "approved");
    },
  );
});

test("review-quill pr status --wait times out with exit 4", async () => {
  await withConfig(
    (configPath, dbPath) => {
      writeConfig(configPath, dbPath);
      const store = new SqliteStore(dbPath);
      store.createAttempt({
        repoFullName: "owner/app",
        prNumber: 42,
        headSha: "abc",
        status: "running",
      });
      store.close();
    },
    async () => {
      const stdout = createBufferStream();
      let timeMs = 1_000;
      const code = await runCli(
        ["pr", "status", "--repo", "app", "--pr", "42", "--wait", "--timeout", "2", "--poll", "1", "--json"],
        {
          stdout: stdout.stream,
          stderr: createBufferStream().stream,
          now: () => timeMs,
          sleep: async (ms: number) => {
            timeMs += ms;
          },
        },
      );
      assert.equal(code, 4);
      const payload = JSON.parse(stdout.read());
      assert.equal(payload.timedOut, true);
    },
  );
});

test("review-quill pr status picks the non-superseded attempt over a superseded newer row", async () => {
  await withConfig(
    (configPath, dbPath) => {
      writeConfig(configPath, dbPath);
      const store = new SqliteStore(dbPath);
      const first = store.createAttempt({
        repoFullName: "owner/app",
        prNumber: 42,
        headSha: "sha-1",
        status: "running",
      });
      store.updateAttempt(first.id, {
        status: "completed",
        conclusion: "approved",
        summary: "LGTM",
        completedAt: "2026-04-17T00:10:00Z",
      });
      const second = store.createAttempt({
        repoFullName: "owner/app",
        prNumber: 42,
        headSha: "sha-2",
        status: "queued",
      });
      store.updateAttempt(second.id, { status: "superseded" });
      store.close();
    },
    async () => {
      const stdout = createBufferStream();
      const code = await runCli(
        ["pr", "status", "--repo", "app", "--pr", "42", "--json"],
        {
          stdout: stdout.stream,
          stderr: createBufferStream().stream,
        },
      );
      assert.equal(code, 0);
      const payload = JSON.parse(stdout.read());
      assert.equal(payload.kind, "approved");
    },
  );
});
