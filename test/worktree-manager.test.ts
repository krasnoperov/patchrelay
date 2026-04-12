import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
