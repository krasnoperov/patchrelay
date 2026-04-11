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
