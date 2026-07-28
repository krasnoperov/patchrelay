import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveReviewDiffBaseSha } from "../src/review-workspace/materialize.ts";
import { buildDiffContext } from "../src/diff-context/index.ts";
import type { ReviewQuillRepositoryConfig, ReviewWorkspace } from "../src/types.ts";

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

test("stacked review diff contains only child changes from GitHub's PR base", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "rq-stacked-base-"));
  try {
    git(dir, "init", "-q", "-b", "main");
    git(dir, "config", "user.email", "test@example.com");
    git(dir, "config", "user.name", "Test");
    writeFileSync(path.join(dir, "README.md"), "main\n");
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", "main");

    git(dir, "checkout", "-q", "-b", "feature/parent");
    writeFileSync(path.join(dir, "parent.txt"), "parent-only\n");
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", "parent");
    const parentSha = git(dir, "rev-parse", "HEAD");

    git(dir, "checkout", "-q", "-b", "feature/child");
    writeFileSync(path.join(dir, "child.txt"), "child-only\n");
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", "child");
    const childSha = git(dir, "rev-parse", "HEAD");

    const diffBaseSha = await resolveReviewDiffBaseSha(dir, {
      number: 907,
      baseSha: parentSha,
      headSha: childSha,
    });
    assert.equal(diffBaseSha, parentSha);
    assert.deepEqual(git(dir, "diff", "--name-only", `${diffBaseSha}...${childSha}`).split("\n"), ["child.txt"]);

    const repo: ReviewQuillRepositoryConfig = {
      repoId: "stacked-fixture",
      repoFullName: "fixture/stacked",
      baseBranch: "main",
      waitForGreenChecks: false,
      requiredChecks: [],
      excludeBranches: [],
      reviewDocs: [],
      diffIgnore: [],
      diffSummarizeOnly: [],
      patchBodyBudgetTokens: 5_000,
    };
    const workspace: ReviewWorkspace = {
      repoFullName: repo.repoFullName,
      cachePath: dir,
      worktreePath: dir,
      baseRef: diffBaseSha,
      diffBaseRef: diffBaseSha,
      headRef: childSha,
      headSha: childSha,
      prBaseSha: parentSha,
    };
    const diff = await buildDiffContext(repo, workspace);
    assert.deepEqual(
      diff.inventory.map((entry) => entry.path),
      ["child.txt"],
      "the production diff inventory must exclude parent-only and main-only files",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
