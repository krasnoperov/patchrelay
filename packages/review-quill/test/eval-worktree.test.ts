import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { ReviewEvalCase } from "../src/eval/case-file.ts";
import { isChangedNewLine, prepareEvalWorktree, resolveRepositoryCheckout } from "../src/eval/worktree.ts";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

test("eval worktrees pin the frozen head and validate changed new-version lines", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "review-quill-eval-worktree-test-"));
  const checkout = path.join(root, "demo");
  try {
    git(root, ["init", "-q", "-b", "main", checkout]);
    git(checkout, ["config", "user.email", "eval@example.com"]);
    git(checkout, ["config", "user.name", "Eval"]);
    git(checkout, ["remote", "add", "origin", "https://github.com/acme/demo.git"]);
    writeFileSync(path.join(checkout, "file.txt"), "first\n", "utf8");
    git(checkout, ["add", "file.txt"]);
    git(checkout, ["commit", "-q", "-m", "base"]);
    const baseSha = git(checkout, ["rev-parse", "HEAD"]);
    writeFileSync(path.join(checkout, "file.txt"), "first\nsecond\n", "utf8");
    git(checkout, ["commit", "-qam", "change"]);
    const headSha = git(checkout, ["rev-parse", "HEAD"]);
    const evalCase = {
      id: "sample",
      repository: "acme/demo",
      pullRequest: 1,
      baseSha,
      headSha,
      baseBranch: "main",
    } as ReviewEvalCase;

    assert.equal(await resolveRepositoryCheckout("acme/demo", root), checkout);
    const prepared = await prepareEvalWorktree(evalCase, checkout);
    const worktreePath = prepared.workspace.worktreePath;
    assert.equal(git(worktreePath, ["rev-parse", "HEAD"]), headSha);
    assert.equal(git(worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"]), "HEAD");
    assert.equal(await isChangedNewLine(worktreePath, baseSha, "file.txt", 2), true);
    assert.equal(await isChangedNewLine(worktreePath, baseSha, "file.txt", 1), false);
    await prepared.dispose();
    assert.equal(existsSync(worktreePath), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
