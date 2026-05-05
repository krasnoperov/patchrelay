import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { gitCommitTree, gitMergeTree } from "../src/review-workspace/git.ts";

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

function setup(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), "rq-integration-tree-"));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "Test");
  writeFileSync(path.join(dir, "README.md"), "init\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "init");
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("gitMergeTree returns tree id for a non-conflicting integration", async () => {
  const { dir, cleanup } = setup();
  try {
    const baseSha = git(dir, "rev-parse", "HEAD");
    git(dir, "checkout", "-q", "-b", "feat");
    writeFileSync(path.join(dir, "a.txt"), "feat\n");
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", "add a");
    const headSha = git(dir, "rev-parse", "HEAD");

    const result = await gitMergeTree(dir, baseSha, headSha);
    assert.equal(result.conflict, false, "expected no conflict");
    if (!result.conflict) {
      assert.match(result.treeId, /^[0-9a-f]{40}$/);
    }
  } finally {
    cleanup();
  }
});

test("gitMergeTree signals conflict when base and head touch the same lines", async () => {
  const { dir, cleanup } = setup();
  try {
    writeFileSync(path.join(dir, "shared.txt"), "v0\n");
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", "add shared");
    const baseStart = git(dir, "rev-parse", "HEAD");

    git(dir, "checkout", "-q", "-b", "feat");
    writeFileSync(path.join(dir, "shared.txt"), "feat-version\n");
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", "feat shared");
    const headSha = git(dir, "rev-parse", "HEAD");

    git(dir, "checkout", "-q", "main");
    writeFileSync(path.join(dir, "shared.txt"), "main-version\n");
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", "main shared");
    const newBase = git(dir, "rev-parse", "HEAD");

    const result = await gitMergeTree(dir, newBase, headSha);
    assert.equal(result.conflict, true, "expected conflict — both branches changed shared.txt");
    void baseStart;
  } finally {
    cleanup();
  }
});

test("gitCommitTree wraps a tree as a synthetic merge commit with two parents", async () => {
  const { dir, cleanup } = setup();
  try {
    const baseSha = git(dir, "rev-parse", "HEAD");
    git(dir, "checkout", "-q", "-b", "feat");
    writeFileSync(path.join(dir, "a.txt"), "feat\n");
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", "add a");
    const headSha = git(dir, "rev-parse", "HEAD");

    const merge = await gitMergeTree(dir, baseSha, headSha);
    if (merge.conflict) {
      throw new Error("expected non-conflict for setup");
    }
    const syntheticSha = await gitCommitTree(
      dir,
      merge.treeId,
      [baseSha, headSha],
      "synthetic integration of PR #1",
    );
    assert.match(syntheticSha, /^[0-9a-f]{40}$/);

    // Verify the synthetic commit's parents are exactly [baseSha, headSha].
    const parents = git(dir, "rev-list", "--parents", "-n", "1", syntheticSha)
      .split(/\s+/);
    assert.equal(parents[0], syntheticSha);
    assert.equal(parents[1], baseSha);
    assert.equal(parents[2], headSha);

    // And that the synthetic commit's tree matches the merge-tree result.
    const tree = git(dir, "rev-parse", `${syntheticSha}^{tree}`);
    assert.equal(tree, merge.treeId);
  } finally {
    cleanup();
  }
});
