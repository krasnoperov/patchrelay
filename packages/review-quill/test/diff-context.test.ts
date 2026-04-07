import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { buildDiffContext } from "../src/diff-context/index.ts";
import type { ReviewQuillRepositoryConfig, ReviewWorkspace } from "../src/types.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

async function createRepo(): Promise<{ repoPath: string; baseSha: string }> {
  const repoPath = await mkdtemp(path.join(tmpdir(), "review-quill-diff-"));
  git(repoPath, "init", "--initial-branch=main");
  git(repoPath, "config", "user.name", "Review Quill Test");
  git(repoPath, "config", "user.email", "review-quill@example.com");
  await writeFile(path.join(repoPath, "src.ts"), "export const value = 1;\n", "utf8");
  await writeFile(path.join(repoPath, "package-lock.json"), "{\n  \"name\": \"fixture\"\n}\n", "utf8");
  git(repoPath, "add", ".");
  git(repoPath, "commit", "-m", "base");
  const baseSha = git(repoPath, "rev-parse", "HEAD").trim();
  return { repoPath, baseSha };
}

function repoConfig(overrides?: Partial<ReviewQuillRepositoryConfig>): ReviewQuillRepositoryConfig {
  return {
    repoId: "fixture",
    repoFullName: "example/fixture",
    baseBranch: "main",
    requiredChecks: [],
    excludeBranches: ["release-please--*"],
    reviewDocs: ["REVIEW_WORKFLOW.md", "CLAUDE.md", "AGENTS.md"],
    diffIgnore: [],
    diffSummarizeOnly: [
      "package-lock.json",
      "pnpm-lock.yaml",
      "yarn.lock",
      "bun.lock*",
      "dist/**",
      "build/**",
      "coverage/**",
      "*.map",
      "*.min.js",
      "*.snap",
    ],
    maxPatchLines: 400,
    maxPatchBytes: 24_000,
    maxFilesWithFullPatch: 20,
    ...overrides,
  };
}

function workspace(repoPath: string, baseSha: string): ReviewWorkspace {
  return {
    repoFullName: "example/fixture",
    cachePath: repoPath,
    worktreePath: repoPath,
    baseRef: baseSha,
    headRef: "HEAD",
    headSha: git(repoPath, "rev-parse", "HEAD").trim(),
  };
}

test("buildDiffContext summarizes lockfiles but keeps source patches", async () => {
  const fixture = await createRepo();
  try {
    await writeFile(path.join(fixture.repoPath, "src.ts"), "export const value = 2;\n", "utf8");
    await writeFile(path.join(fixture.repoPath, "package-lock.json"), "{\n  \"name\": \"fixture\",\n  \"version\": 2\n}\n", "utf8");
    git(fixture.repoPath, "add", ".");
    git(fixture.repoPath, "commit", "-m", "change");

    const diff = await buildDiffContext(repoConfig(), workspace(fixture.repoPath, fixture.baseSha));

    assert.ok(diff.inventory.some((entry) => entry.path === "src.ts" && entry.classification === "full_patch"));
    assert.ok(diff.patches.some((entry) => entry.path === "src.ts"));
    assert.ok(diff.suppressed.some((entry) => entry.path === "package-lock.json" && entry.reason === "summarize_only_policy"));
  } finally {
    await rm(fixture.repoPath, { recursive: true, force: true });
  }
});

test("buildDiffContext summarizes oversized patches", async () => {
  const fixture = await createRepo();
  try {
    const largeLines = Array.from({ length: 50 }, (_, index) => `export const line${index} = ${index};`).join("\n");
    await writeFile(path.join(fixture.repoPath, "src.ts"), `${largeLines}\n`, "utf8");
    git(fixture.repoPath, "add", "src.ts");
    git(fixture.repoPath, "commit", "-m", "large change");

    const diff = await buildDiffContext(
      repoConfig({ maxPatchLines: 10 }),
      workspace(fixture.repoPath, fixture.baseSha),
    );

    assert.ok(diff.suppressed.some((entry) => entry.path === "src.ts" && entry.reason === "patch_too_large_lines"));
    assert.equal(diff.patches.some((entry) => entry.path === "src.ts"), false);
  } finally {
    await rm(fixture.repoPath, { recursive: true, force: true });
  }
});
