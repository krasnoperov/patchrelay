import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolvePrNumber, resolveRepo, type ResolveCommandRunner } from "../src/cli/resolve.ts";
import { parseArgs } from "../src/cli/args.ts";
import { UsageError } from "../src/cli/types.ts";

function withXdg<T>(run: () => Promise<T>): Promise<T> {
  const baseDir = mkdtempSync(path.join(tmpdir(), "ms-resolve-"));
  const previous: Record<string, string | undefined> = {
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    XDG_STATE_HOME: process.env.XDG_STATE_HOME,
    XDG_DATA_HOME: process.env.XDG_DATA_HOME,
  };
  process.env.XDG_CONFIG_HOME = path.join(baseDir, ".config");
  process.env.XDG_STATE_HOME = path.join(baseDir, ".state");
  process.env.XDG_DATA_HOME = path.join(baseDir, ".share");
  mkdirSync(path.join(baseDir, ".config"), { recursive: true });
  const restore = () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(baseDir, { recursive: true, force: true });
  };
  return run().finally(restore) as Promise<T>;
}

function writeRepoConfig(repoId: string, repoFullName: string): void {
  const home = process.env.XDG_CONFIG_HOME!;
  const repoConfigDir = path.join(home, "merge-steward", "repos");
  mkdirSync(repoConfigDir, { recursive: true });
  const config = {
    repoId,
    repoFullName,
    baseBranch: "main",
    clonePath: "/tmp/clone",
    server: { bind: "127.0.0.1", port: 9901 },
    database: { path: "/tmp/queue.sqlite", wal: true },
    logging: { level: "info" },
  };
  writeFileSync(path.join(repoConfigDir, `${repoId}.json`), JSON.stringify(config), "utf8");
}

function makeRunner(remoteUrl: string | undefined, prNumber: number | undefined): ResolveCommandRunner {
  return async (command, args) => {
    if (command === "git" && args[0] === "remote" && args[1] === "get-url") {
      if (remoteUrl === undefined) {
        return { exitCode: 128, stdout: "", stderr: "fatal: No such remote 'origin'" };
      }
      return { exitCode: 0, stdout: `${remoteUrl}\n`, stderr: "" };
    }
    if (command === "gh" && args[0] === "pr" && args[1] === "view") {
      if (prNumber === undefined) {
        return { exitCode: 1, stdout: "", stderr: "no pull requests found for current branch" };
      }
      return { exitCode: 0, stdout: `${prNumber}\n`, stderr: "" };
    }
    return { exitCode: 127, stdout: "", stderr: "unexpected command" };
  };
}

test("resolveRepo prefers --repo flag and looks up repoId in attached configs", async () => {
  await withXdg(async () => {
    writeRepoConfig("app", "owner/app");
    const resolved = await resolveRepo({
      parsed: parseArgs(["pr", "status", "--repo", "app"]),
      runCommand: makeRunner(undefined, undefined),
    });
    assert.equal(resolved.repoId, "app");
    assert.equal(resolved.repoFullName, "owner/app");
    assert.equal(resolved.source, "flag");
  });
});

test("resolveRepo accepts owner/repo form on --repo", async () => {
  await withXdg(async () => {
    writeRepoConfig("app", "owner/app");
    const resolved = await resolveRepo({
      parsed: parseArgs(["pr", "status", "--repo", "owner/app"]),
      runCommand: makeRunner(undefined, undefined),
    });
    assert.equal(resolved.repoId, "app");
    assert.equal(resolved.source, "flag");
  });
});

test("resolveRepo falls back to git remote when --repo omitted", async () => {
  await withXdg(async () => {
    writeRepoConfig("app", "owner/app");
    const resolved = await resolveRepo({
      parsed: parseArgs(["pr", "status"]),
      runCommand: makeRunner("git@github.com:owner/app.git", undefined),
    });
    assert.equal(resolved.repoId, "app");
    assert.equal(resolved.source, "cwd");
  });
});

test("resolveRepo parses https remote URLs", async () => {
  await withXdg(async () => {
    writeRepoConfig("app", "owner/app");
    const resolved = await resolveRepo({
      parsed: parseArgs(["pr", "status"]),
      runCommand: makeRunner("https://github.com/owner/app.git", undefined),
    });
    assert.equal(resolved.repoId, "app");
  });
});

test("resolveRepo errors when repo not attached", async () => {
  await withXdg(async () => {
    writeRepoConfig("other", "owner/other");
    await assert.rejects(
      resolveRepo({
        parsed: parseArgs(["pr", "status"]),
        runCommand: makeRunner("git@github.com:owner/app.git", undefined),
      }),
      (error) => error instanceof UsageError && /not attached/.test(error.message),
    );
  });
});

test("resolveRepo errors with no remote and no flag", async () => {
  await withXdg(async () => {
    await assert.rejects(
      resolveRepo({
        parsed: parseArgs(["pr", "status"]),
        runCommand: makeRunner(undefined, undefined),
      }),
      (error) => error instanceof UsageError && /pass --repo/.test(error.message),
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
