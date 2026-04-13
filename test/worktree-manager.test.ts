import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { WorktreeManager } from "../src/worktree-manager.ts";

function runGit(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function writeGitWrapper(wrapperPath: string, scriptBody: string): void {
  writeFileSync(wrapperPath, `#!/usr/bin/env node\n${scriptBody}`, "utf8");
  chmodSync(wrapperPath, 0o755);
}

test("ensureIssueWorktree and resetWorktreeToTrackedBranch can adopt a branch already checked out in another worktree", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-worktree-manager-"));
  try {
    const remotePath = path.join(baseDir, "remote.git");
    const repoPath = path.join(baseDir, "repo");
    const worktreeRoot = path.join(baseDir, "worktrees");
    const worktreePath = path.join(worktreeRoot, "USE-ADOPT");
    const branchName = "perf/adopt-existing-pr";

    runGit(["init", "--bare", remotePath], baseDir);
    runGit(["clone", remotePath, repoPath], baseDir);
    runGit(["config", "user.name", "PatchRelay Test"], repoPath);
    runGit(["config", "user.email", "patchrelay@example.com"], repoPath);

    writeFileSync(path.join(repoPath, "app.txt"), "base\n", "utf8");
    runGit(["add", "app.txt"], repoPath);
    runGit(["commit", "-m", "base"], repoPath);
    runGit(["push", "-u", "origin", "HEAD:main"], repoPath);
    runGit(["checkout", "-B", branchName], repoPath);
    writeFileSync(path.join(repoPath, "app.txt"), "feature branch\n", "utf8");
    runGit(["commit", "-am", "feature"], repoPath);
    runGit(["push", "-u", "origin", branchName], repoPath);

    const manager = new WorktreeManager({
      runner: {
        gitBin: "git",
      },
    });

    await manager.ensureIssueWorktree(repoPath, worktreeRoot, worktreePath, branchName);
    await manager.resetWorktreeToTrackedBranch(worktreePath, branchName, { issueKey: "USE-ADOPT" });

    assert.equal(runGit(["rev-parse", "--abbrev-ref", "HEAD"], worktreePath), branchName);
    assert.match(runGit(["status", "--short", "--branch"], worktreePath), new RegExp(`## ${branchName}\\.\\.\\.origin/${branchName.replace("/", "\\/")}`));
    assert.equal(runGit(["show", "HEAD:app.txt"], worktreePath), "feature branch");
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("ensureIssueWorktree and resetWorktreeToTrackedBranch can prepare a brand-new implementation branch with no remote branch yet", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-worktree-manager-new-"));
  try {
    const remotePath = path.join(baseDir, "remote.git");
    const repoPath = path.join(baseDir, "repo");
    const worktreeRoot = path.join(baseDir, "worktrees");
    const worktreePath = path.join(worktreeRoot, "USE-NEW");
    const branchName = "use/new-implementation";

    runGit(["init", "--bare", remotePath], baseDir);
    runGit(["clone", remotePath, repoPath], baseDir);
    runGit(["config", "user.name", "PatchRelay Test"], repoPath);
    runGit(["config", "user.email", "patchrelay@example.com"], repoPath);

    writeFileSync(path.join(repoPath, "app.txt"), "base\n", "utf8");
    runGit(["add", "app.txt"], repoPath);
    runGit(["commit", "-m", "base"], repoPath);
    runGit(["push", "-u", "origin", "HEAD:main"], repoPath);
    runGit(["checkout", "main"], repoPath);

    const manager = new WorktreeManager({
      runner: {
        gitBin: "git",
      },
    });

    await manager.ensureIssueWorktree(repoPath, worktreeRoot, worktreePath, branchName);
    await manager.resetWorktreeToTrackedBranch(worktreePath, branchName, { issueKey: "USE-NEW" });

    assert.equal(runGit(["rev-parse", "--abbrev-ref", "HEAD"], worktreePath), branchName);
    assert.equal(runGit(["status", "--porcelain"], worktreePath), "");
    assert.equal(runGit(["show", "HEAD:app.txt"], worktreePath), "base");
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("ensureIssueWorktree retries transient fetch failures before creating the worktree", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-worktree-manager-retry-"));
  try {
    const remotePath = path.join(baseDir, "remote.git");
    const repoPath = path.join(baseDir, "repo");
    const worktreeRoot = path.join(baseDir, "worktrees");
    const worktreePath = path.join(worktreeRoot, "USE-RETRY");
    const wrapperPath = path.join(baseDir, "git-wrapper.mjs");
    const attemptFile = path.join(baseDir, "fetch-attempts.txt");

    runGit(["init", "--bare", remotePath], baseDir);
    runGit(["clone", remotePath, repoPath], baseDir);
    runGit(["config", "user.name", "PatchRelay Test"], repoPath);
    runGit(["config", "user.email", "patchrelay@example.com"], repoPath);

    writeFileSync(path.join(repoPath, "app.txt"), "base\n", "utf8");
    runGit(["add", "app.txt"], repoPath);
    runGit(["commit", "-m", "base"], repoPath);
    runGit(["push", "-u", "origin", "HEAD:main"], repoPath);
    runGit(["checkout", "main"], repoPath);

    writeGitWrapper(
      wrapperPath,
      `
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";

const args = process.argv.slice(2);
const attemptFile = ${JSON.stringify(attemptFile)};
if (args[0] === "-C" && args[2] === "fetch" && args[3] === "origin" && args[4] === "main") {
  appendFileSync(attemptFile, "fetch\\n");
  const count = (readFileSync(attemptFile, "utf8").match(/^fetch$/gm) ?? []).length;
  if (count === 1) {
    process.stderr.write("fatal: unable to access 'https://github.com/krasnoperov/subtitles.git/': Recv failure: Connection reset by peer\\n");
    process.exit(1);
  }
}

const output = execFileSync("git", args, {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
});
if (output) {
  process.stdout.write(output);
}
`,
    );

    const manager = new WorktreeManager({
      runner: {
        gitBin: wrapperPath,
      },
    });

    await manager.ensureIssueWorktree(repoPath, worktreeRoot, worktreePath, "retry/branch");

    assert.equal((readFileSync(attemptFile, "utf8").match(/^fetch$/gm) ?? []).length, 2);
    assert.equal(runGit(["rev-parse", "HEAD"], worktreePath), runGit(["rev-parse", "origin/main"], repoPath));
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("ensureIssueWorktree does not retry non-transient fetch failures", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-worktree-manager-auth-"));
  try {
    const remotePath = path.join(baseDir, "remote.git");
    const repoPath = path.join(baseDir, "repo");
    const worktreeRoot = path.join(baseDir, "worktrees");
    const worktreePath = path.join(worktreeRoot, "USE-AUTH");
    const wrapperPath = path.join(baseDir, "git-wrapper.mjs");
    const attemptFile = path.join(baseDir, "fetch-attempts.txt");

    runGit(["init", "--bare", remotePath], baseDir);
    runGit(["clone", remotePath, repoPath], baseDir);
    runGit(["config", "user.name", "PatchRelay Test"], repoPath);
    runGit(["config", "user.email", "patchrelay@example.com"], repoPath);

    writeFileSync(path.join(repoPath, "app.txt"), "base\n", "utf8");
    runGit(["add", "app.txt"], repoPath);
    runGit(["commit", "-m", "base"], repoPath);
    runGit(["push", "-u", "origin", "HEAD:main"], repoPath);
    runGit(["checkout", "main"], repoPath);

    writeGitWrapper(
      wrapperPath,
      `
import { appendFileSync } from "node:fs";

const args = process.argv.slice(2);
if (args[0] === "-C" && args[2] === "fetch" && args[3] === "origin" && args[4] === "main") {
  appendFileSync(${JSON.stringify(attemptFile)}, "fetch\\n");
  process.stderr.write("fatal: Authentication failed for 'https://github.com/krasnoperov/subtitles.git/'\\n");
  process.exit(1);
}

process.exit(0);
`,
    );

    const manager = new WorktreeManager({
      runner: {
        gitBin: wrapperPath,
      },
    });

    await assert.rejects(
      manager.ensureIssueWorktree(repoPath, worktreeRoot, worktreePath, "auth/branch"),
      /Authentication failed/,
    );
    assert.equal((readFileSync(attemptFile, "utf8").match(/^fetch$/gm) ?? []).length, 1);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});
