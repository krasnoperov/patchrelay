import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { inspectGitWorktreeStatus } from "../src/git-worktree-status.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

// Mirror production: PatchRelay always inspects a LINKED git worktree (its
// `.git` is a file, the real gitdir lives under main/.git/worktrees/<name>),
// so `git rev-parse --git-path` returns absolute paths. A plain `git init`
// repo returns relative paths, which would make the merge-marker probe
// cwd-dependent and not represent production.
function initRepoWithWorktree(): { base: string; worktree: string; cleanup: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), "patchrelay-worktree-status-"));
  const base = path.join(root, "main");
  execFileSync("git", ["init", "-q", base]);
  git(base, "config", "user.email", "test@example.com");
  git(base, "config", "user.name", "Test");
  writeFileSync(path.join(base, "file.txt"), "base\n");
  git(base, "add", ".");
  git(base, "commit", "-q", "-m", "base");
  const worktree = path.join(root, "wt");
  git(base, "worktree", "add", "-q", worktree);
  return { base, worktree, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function mergeHeadPath(worktree: string): string {
  return git(worktree, "rev-parse", "--git-path", "MERGE_HEAD");
}

test("a clean worktree is not dirty", () => {
  const { worktree, cleanup } = initRepoWithWorktree();
  try {
    const status = inspectGitWorktreeStatus(worktree);
    assert.equal(status.dirty, false);
    assert.equal(status.mergeInProgress, false);
  } finally {
    cleanup();
  }
});

test("a vestigial MERGE_HEAD over an otherwise-clean tree is not dirty", () => {
  // Regression: a lingering MERGE_HEAD marker with zero porcelain changes
  // (a merge that produced no content change but never cleared its head) used
  // to be reported as dirty, triggering a spurious "continue to publish" loop
  // that stranded the issue.
  const { worktree, cleanup } = initRepoWithWorktree();
  try {
    const head = git(worktree, "rev-parse", "HEAD");
    writeFileSync(mergeHeadPath(worktree), `${head}\n`);

    const status = inspectGitWorktreeStatus(worktree);
    assert.equal(status.mergeInProgress, true, "marker is still detected/reported");
    assert.equal(status.dirty, false, "but an empty marker is not actionably dirty");
    assert.deepEqual(status.changedPaths, []);
  } finally {
    cleanup();
  }
});

test("uncommitted changes are dirty even alongside a merge marker", () => {
  const { worktree, cleanup } = initRepoWithWorktree();
  try {
    const head = git(worktree, "rev-parse", "HEAD");
    writeFileSync(mergeHeadPath(worktree), `${head}\n`);
    writeFileSync(path.join(worktree, "file.txt"), "changed\n");

    const status = inspectGitWorktreeStatus(worktree);
    assert.equal(status.dirty, true);
    assert.ok(status.changedPaths.includes("file.txt"));
  } finally {
    cleanup();
  }
});

test("a real merge conflict is dirty with unmerged paths", () => {
  const { worktree, cleanup } = initRepoWithWorktree();
  try {
    // Two branches diverging from the same base commit, each editing the same
    // line, then merged to force a real conflict in the worktree.
    const baseCommit = git(worktree, "rev-parse", "HEAD");
    git(worktree, "checkout", "-q", "-b", "branch-a");
    writeFileSync(path.join(worktree, "file.txt"), "aaa\n");
    git(worktree, "commit", "-q", "-am", "change a");
    git(worktree, "checkout", "-q", "-b", "branch-b", baseCommit);
    writeFileSync(path.join(worktree, "file.txt"), "bbb\n");
    git(worktree, "commit", "-q", "-am", "change b");
    try {
      git(worktree, "merge", "branch-a");
    } catch {
      // expected to conflict
    }

    const status = inspectGitWorktreeStatus(worktree);
    assert.equal(status.dirty, true);
    assert.ok(status.unmergedPaths.includes("file.txt"), "conflict surfaces as an unmerged path");
  } finally {
    cleanup();
  }
});
