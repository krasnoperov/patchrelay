import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { computeChangeIdentityFromWorktree } from "../src/change-identity.ts";

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

function setupRepo(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), "patchrelay-change-identity-"));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "Test");
  writeFileSync(path.join(dir, "README.md"), "init\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "init");
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("returns patchId and integrationTreeId for a clean diff", () => {
  const { dir, cleanup } = setupRepo();
  try {
    git(dir, "checkout", "-q", "-b", "feature");
    writeFileSync(path.join(dir, "a.txt"), "first\n");
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", "add a");

    const identity = computeChangeIdentityFromWorktree({
      worktreePath: dir,
      baseRef: "main",
    });
    assert.ok(identity.patchId, "patchId should be present");
    assert.ok(identity.integrationTreeId, "integrationTreeId should be present");
    assert.match(identity.patchId!, /^[0-9a-f]{40}$/, "patchId should be a 40-char hex");
  } finally {
    cleanup();
  }
});

test("two patch-id-equivalent commits produce identical patchId", () => {
  const { dir, cleanup } = setupRepo();
  try {
    git(dir, "checkout", "-q", "-b", "feature");
    writeFileSync(path.join(dir, "a.txt"), "first\n");
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", "add a");
    const identityA = computeChangeIdentityFromWorktree({ worktreePath: dir, baseRef: "main" });

    // Amend the commit to change committer date but keep the same
    // diff — patch-id is stable across this kind of churn.
    const result = spawnSync(
      "git",
      ["commit", "-q", "--amend", "--no-edit", "--date=2026-05-05T00:00:00Z"],
      {
        cwd: dir,
        env: { ...process.env, GIT_COMMITTER_DATE: "2026-05-05T00:00:00Z" },
      },
    );
    if (result.status !== 0) throw new Error(`amend failed: ${result.stderr}`);
    const identityB = computeChangeIdentityFromWorktree({ worktreePath: dir, baseRef: "main" });

    assert.equal(identityA.patchId, identityB.patchId, "amend with same diff should preserve patchId");
    assert.notEqual(identityA.headSha, identityB.headSha, "head SHA changes on amend");
  } finally {
    cleanup();
  }
});

test("returns undefined fields gracefully on bad ref", () => {
  const { dir, cleanup } = setupRepo();
  try {
    const identity = computeChangeIdentityFromWorktree({
      worktreePath: dir,
      baseRef: "no-such-ref",
    });
    // Both identity values undefined; baseSha undefined.
    assert.equal(identity.patchId, undefined);
    assert.equal(identity.integrationTreeId, undefined);
    assert.equal(identity.baseSha, undefined);
  } finally {
    cleanup();
  }
});
