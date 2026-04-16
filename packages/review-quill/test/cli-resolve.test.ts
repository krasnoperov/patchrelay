import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolvePrNumber, resolveRepo, type ResolveCommandRunner } from "../src/cli/resolve.ts";
import { parseArgs, UsageError } from "../src/cli/args.ts";

function withConfig<T>(run: () => Promise<T>): Promise<T> {
  const baseDir = mkdtempSync(path.join(tmpdir(), "rq-resolve-"));
  const configDir = path.join(baseDir, ".config", "review-quill");
  mkdirSync(configDir, { recursive: true });
  const configPath = path.join(configDir, "review-quill.json");
  writeFileSync(configPath, JSON.stringify({
    server: { bind: "127.0.0.1", port: 8800 },
    database: { path: path.join(baseDir, "rq.sqlite"), wal: true },
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

function makeRunner(remoteUrl: string | undefined, prNumber: number | undefined): ResolveCommandRunner {
  return async (command, args) => {
    if (command === "git" && args[0] === "remote" && args[1] === "get-url") {
      if (remoteUrl === undefined) {
        return { exitCode: 128, stdout: "", stderr: "fatal: no remote" };
      }
      return { exitCode: 0, stdout: `${remoteUrl}\n`, stderr: "" };
    }
    if (command === "gh" && args[0] === "pr" && args[1] === "view") {
      if (prNumber === undefined) {
        return { exitCode: 1, stdout: "", stderr: "no pull requests for branch" };
      }
      return { exitCode: 0, stdout: `${prNumber}\n`, stderr: "" };
    }
    return { exitCode: 127, stdout: "", stderr: "unexpected" };
  };
}

test("resolveRepo prefers --repo flag", async () => {
  await withConfig(async () => {
    const resolved = await resolveRepo({
      parsed: parseArgs(["pr", "status", "--repo", "app"]),
      runCommand: makeRunner(undefined, undefined),
    });
    assert.equal(resolved.repoId, "app");
    assert.equal(resolved.source, "flag");
  });
});

test("resolveRepo falls back to git remote", async () => {
  await withConfig(async () => {
    const resolved = await resolveRepo({
      parsed: parseArgs(["pr", "status"]),
      runCommand: makeRunner("git@github.com:owner/app.git", undefined),
    });
    assert.equal(resolved.repoId, "app");
    assert.equal(resolved.source, "cwd");
  });
});

test("resolveRepo parses https remote URLs", async () => {
  await withConfig(async () => {
    const resolved = await resolveRepo({
      parsed: parseArgs(["pr", "status"]),
      runCommand: makeRunner("https://github.com/owner/app", undefined),
    });
    assert.equal(resolved.repoId, "app");
  });
});

test("resolveRepo errors when repo not attached", async () => {
  await withConfig(async () => {
    await assert.rejects(
      resolveRepo({
        parsed: parseArgs(["pr", "status"]),
        runCommand: makeRunner("git@github.com:owner/other.git", undefined),
      }),
      (error) => error instanceof UsageError && /not attached/.test(error.message),
    );
  });
});

test("resolvePrNumber prefers --pr flag", async () => {
  const resolved = await resolvePrNumber({
    parsed: parseArgs(["pr", "status", "--pr", "42"]),
    runCommand: makeRunner(undefined, 999),
  });
  assert.equal(resolved.prNumber, 42);
  assert.equal(resolved.source, "flag");
});

test("resolvePrNumber falls back to gh pr view", async () => {
  const resolved = await resolvePrNumber({
    parsed: parseArgs(["pr", "status"]),
    runCommand: makeRunner(undefined, 77),
  });
  assert.equal(resolved.prNumber, 77);
  assert.equal(resolved.source, "cwd");
});

test("resolvePrNumber errors when gh returns nothing", async () => {
  await assert.rejects(
    resolvePrNumber({
      parsed: parseArgs(["pr", "status"]),
      runCommand: makeRunner(undefined, undefined),
    }),
    (error) => error instanceof UsageError && /--pr/.test(error.message),
  );
});

test("resolvePrNumber rejects non-numeric --pr", async () => {
  await assert.rejects(
    resolvePrNumber({
      parsed: parseArgs(["pr", "status", "--pr", "nope"]),
      runCommand: makeRunner(undefined, undefined),
    }),
    (error) => error instanceof UsageError && /positive integer/.test(error.message),
  );
});
