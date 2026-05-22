import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { configureGitHubBotAuthForWorktree } from "../src/github-worktree-auth.ts";

function git(args: string[], options?: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string }): string {
  return execFileSync("git", args, {
    cwd: options?.cwd,
    env: options?.env,
    input: options?.input,
    encoding: "utf8",
  });
}

function gitOptional(args: string[], options?: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string }): string {
  try {
    return git(args, options);
  } catch (error) {
    if (typeof error === "object" && error !== null && "status" in error && error.status === 1) return "";
    throw error;
  }
}

test("configureGitHubBotAuthForWorktree overrides inherited github credential helpers", { concurrency: false }, async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-github-worktree-auth-"));
  const repoDir = path.join(baseDir, "repo");
  const globalConfigPath = path.join(baseDir, "gitconfig");
  const tokenFile = path.join(baseDir, "bot-token");
  const previousGlobal = process.env.GIT_CONFIG_GLOBAL;
  const previousNoSystem = process.env.GIT_CONFIG_NOSYSTEM;

  try {
    writeFileSync(tokenFile, "test-bot-token\n", { encoding: "utf8", mode: 0o600 });
    writeFileSync(globalConfigPath, [
      '[credential "https://github.com"]',
      '\thelper = ',
      '\thelper = !f() { echo "username=krasnoperov"; echo "password=user-token"; }; f',
      '',
    ].join("\n"), "utf8");

    process.env.GIT_CONFIG_GLOBAL = globalConfigPath;
    process.env.GIT_CONFIG_NOSYSTEM = "1";

    git(["init", repoDir]);
    git(["-C", repoDir, "remote", "add", "origin", "https://github.com/example/repo.git"]);

    await configureGitHubBotAuthForWorktree({
      gitBin: "git",
      worktreePath: repoDir,
      botIdentity: {
        name: "patchrelay[bot]",
        email: "1+patchrelay[bot]@users.noreply.github.com",
        tokenFile,
      },
    });

    const filled = git(["-C", repoDir, "credential", "fill"], {
      input: "protocol=https\nhost=github.com\npath=example/repo.git\n\n",
    });

    assert.match(filled, /^username=x-access-token$/m);
    assert.match(filled, /^password=test-bot-token$/m);
  } finally {
    if (previousGlobal === undefined) {
      delete process.env.GIT_CONFIG_GLOBAL;
    } else {
      process.env.GIT_CONFIG_GLOBAL = previousGlobal;
    }
    if (previousNoSystem === undefined) {
      delete process.env.GIT_CONFIG_NOSYSTEM;
    } else {
      process.env.GIT_CONFIG_NOSYSTEM = previousNoSystem;
    }
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("configureGitHubBotAuthForWorktree keeps bot identity scoped to linked worktree config", { concurrency: false }, async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-github-worktree-auth-linked-"));
  const repoDir = path.join(baseDir, "repo");
  const worktreeDir = path.join(baseDir, "worktree");
  const globalConfigPath = path.join(baseDir, "gitconfig");
  const tokenFile = path.join(baseDir, "bot-token");
  const previousGlobal = process.env.GIT_CONFIG_GLOBAL;
  const previousNoSystem = process.env.GIT_CONFIG_NOSYSTEM;

  try {
    writeFileSync(tokenFile, "test-bot-token\n", { encoding: "utf8", mode: 0o600 });
    writeFileSync(globalConfigPath, [
      '[credential "https://github.com"]',
      '\thelper = ',
      '\thelper = !f() { echo "username=krasnoperov"; echo "password=user-token"; }; f',
      '',
    ].join("\n"), "utf8");

    process.env.GIT_CONFIG_GLOBAL = globalConfigPath;
    process.env.GIT_CONFIG_NOSYSTEM = "1";

    git(["init", repoDir]);
    git(["-C", repoDir, "config", "user.name", "Real User"]);
    git(["-C", repoDir, "config", "user.email", "real@example.com"]);
    writeFileSync(path.join(repoDir, "README.md"), "hello\n", "utf8");
    git(["-C", repoDir, "add", "README.md"]);
    git(["-C", repoDir, "commit", "-m", "initial"]);
    git(["-C", repoDir, "worktree", "add", "-b", "patchrelay/test", worktreeDir]);

    await configureGitHubBotAuthForWorktree({
      gitBin: "git",
      worktreePath: worktreeDir,
      botIdentity: {
        name: "patchrelay[bot]",
        email: "1+patchrelay[bot]@users.noreply.github.com",
        tokenFile,
      },
    });

    assert.equal(git(["-C", repoDir, "config", "--local", "--get", "user.name"]).trim(), "Real User");
    assert.equal(git(["-C", repoDir, "config", "--local", "--get", "user.email"]).trim(), "real@example.com");
    assert.equal(git(["-C", worktreeDir, "config", "--worktree", "--get", "user.name"]).trim(), "patchrelay[bot]");
    assert.equal(git(["-C", worktreeDir, "config", "--worktree", "--get", "user.email"]).trim(), "1+patchrelay[bot]@users.noreply.github.com");
    assert.doesNotMatch(
      gitOptional(["-C", repoDir, "config", "--local", "--get-all", "credential.https://github.com.helper"]),
      /gh-token|x-access-token|patchrelay/,
    );

    const filled = git(["-C", worktreeDir, "credential", "fill"], {
      input: "protocol=https\nhost=github.com\npath=example/repo.git\n\n",
    });

    assert.match(filled, /^username=x-access-token$/m);
    assert.match(filled, /^password=test-bot-token$/m);
  } finally {
    if (previousGlobal === undefined) {
      delete process.env.GIT_CONFIG_GLOBAL;
    } else {
      process.env.GIT_CONFIG_GLOBAL = previousGlobal;
    }
    if (previousNoSystem === undefined) {
      delete process.env.GIT_CONFIG_NOSYSTEM;
    } else {
      process.env.GIT_CONFIG_NOSYSTEM = previousNoSystem;
    }
    rmSync(baseDir, { recursive: true, force: true });
  }
});
