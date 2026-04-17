import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildDiffContext,
  buildLocalDiffContext,
  DEFAULT_DIFF_IGNORE,
  DEFAULT_DIFF_SUMMARIZE_ONLY,
  DEFAULT_PATCH_BODY_BUDGET_TOKENS,
  estimateTokens,
  parseGitHubRepoFullName,
} from "../src/diff-context/index.ts";
import { packPatches, type CandidatePatch } from "../src/diff-context/git-diff.ts";
import type { DiffFileInventoryEntry, ReviewQuillRepositoryConfig, ReviewWorkspace } from "../src/types.ts";

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
    waitForGreenChecks: false,
    requiredChecks: [],
    excludeBranches: [],
    reviewDocs: ["REVIEW_WORKFLOW.md", "CLAUDE.md", "AGENTS.md"],
    diffIgnore: [...DEFAULT_DIFF_IGNORE],
    diffSummarizeOnly: [...DEFAULT_DIFF_SUMMARIZE_ONLY],
    patchBodyBudgetTokens: DEFAULT_PATCH_BODY_BUDGET_TOKENS,
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

function fakeCandidate(path: string, tokens: number): CandidatePatch {
  const entry: DiffFileInventoryEntry = {
    path,
    status: "M",
    additions: 1,
    deletions: 0,
    changes: 1,
    isBinary: false,
    classification: "full_patch",
  };
  return { entry, patch: `diff --git a/${path} b/${path}\n`, tokens };
}

test("packPatches applies 10% soft slack to the token budget", () => {
  // Budget 100, three files of 40/40/25 tokens. Total = 105 (5 over).
  // Strict budget would drop one 40-token file. 10% slack (effective 110)
  // keeps all three.
  const candidates = [fakeCandidate("a.ts", 40), fakeCandidate("b.ts", 40), fakeCandidate("c.ts", 25)];
  const { patches, overflowed } = packPatches(candidates, 100);
  assert.equal(patches.length, 3, "all three files should fit within the 10% slack");
  assert.equal(overflowed.length, 0);
});

test("packPatches still drops files that exceed budget + slack", () => {
  // Budget 100, two files: 50 and 70. Total = 120 (20 over). With 10%
  // slack (effective 110) the 70-token file doesn't fit after the 50.
  const candidates = [fakeCandidate("small.ts", 50), fakeCandidate("big.ts", 70)];
  const { patches, overflowed } = packPatches(candidates, 100);
  assert.equal(patches.length, 1);
  assert.equal(patches[0]?.path, "small.ts");
  assert.equal(overflowed.length, 1);
  assert.equal(overflowed[0]?.path, "big.ts");
  assert.equal(overflowed[0]?.reason, "budget_exceeded");
});

test("packPatches keeps files within strict budget (no slack needed)", () => {
  const candidates = [fakeCandidate("a.ts", 30), fakeCandidate("b.ts", 30), fakeCandidate("c.ts", 30)];
  const { patches, overflowed } = packPatches(candidates, 100);
  assert.equal(patches.length, 3);
  assert.equal(overflowed.length, 0);
});

test("estimateTokens produces sane values", () => {
  assert.equal(estimateTokens(""), 0);
  // "hello world" is 11 bytes / 3.5 = 3.14 → ceil = 4
  assert.equal(estimateTokens("hello world"), 4);
  // Multibyte UTF-8: "héllo" is 6 bytes / 3.5 = 1.71 → ceil = 2
  assert.equal(estimateTokens("héllo"), 2);
  // Long text scales linearly
  const big = "x".repeat(1000);
  assert.equal(estimateTokens(big), Math.ceil(1000 / 3.5));
});

test("buildDiffContext ignores lockfiles by default and keeps source patches", async () => {
  const fixture = await createRepo();
  try {
    await writeFile(path.join(fixture.repoPath, "src.ts"), "export const value = 2;\n", "utf8");
    await writeFile(path.join(fixture.repoPath, "package-lock.json"), "{\n  \"name\": \"fixture\",\n  \"version\": 2\n}\n", "utf8");
    git(fixture.repoPath, "add", ".");
    git(fixture.repoPath, "commit", "-m", "change");

    const diff = await buildDiffContext(repoConfig(), workspace(fixture.repoPath, fixture.baseSha));

    assert.ok(
      diff.inventory.some((entry) => entry.path === "src.ts" && entry.classification === "full_patch"),
      "src.ts should be a full_patch entry in the final inventory",
    );
    assert.ok(diff.patches.some((entry) => entry.path === "src.ts"));
    assert.ok(
      diff.suppressed.some((entry) => entry.path === "package-lock.json" && entry.reason === "ignored_by_policy"),
      "package-lock.json should be suppressed with reason=ignored_by_policy by the default diffIgnore list",
    );
    assert.equal(
      diff.inventory.find((entry) => entry.path === "package-lock.json")?.classification,
      "ignore",
    );
  } finally {
    await rm(fixture.repoPath, { recursive: true, force: true });
  }
});

test("buildLocalDiffContext mirrors buildDiffContext for the current branch", async () => {
  const fixture = await createRepo();
  try {
    git(fixture.repoPath, "checkout", "-b", "feature/local-diff");
    await writeFile(path.join(fixture.repoPath, "src.ts"), "export const value = 99;\n", "utf8");
    await writeFile(
      path.join(fixture.repoPath, "package-lock.json"),
      "{\n  \"name\": \"fixture\",\n  \"version\": 9\n}\n",
      "utf8",
    );
    git(fixture.repoPath, "add", ".");
    git(fixture.repoPath, "commit", "-m", "feature change");

    const { workspace, diff } = await buildLocalDiffContext({
      repo: repoConfig(),
      cwd: fixture.repoPath,
      baseRef: "main",
    });

    assert.equal(workspace.repoFullName, "example/fixture");
    assert.equal(workspace.baseRef, "main");
    assert.equal(workspace.headRef, "feature/local-diff");
    assert.ok(diff.inventory.some((entry) => entry.path === "src.ts" && entry.classification === "full_patch"));
    assert.ok(diff.patches.some((entry) => entry.path === "src.ts"));
    assert.ok(
      diff.suppressed.some((entry) => entry.path === "package-lock.json" && entry.reason === "ignored_by_policy"),
    );
  } finally {
    await rm(fixture.repoPath, { recursive: true, force: true });
  }
});

test("buildLocalDiffContext includes staged and unstaged tracked changes on the current branch", async () => {
  const fixture = await createRepo();
  try {
    await writeFile(path.join(fixture.repoPath, "src.ts"), "export const value = 7;\n", "utf8");
    await writeFile(path.join(fixture.repoPath, "extra.ts"), "export const extra = true;\n", "utf8");
    git(fixture.repoPath, "add", "extra.ts");

    const { workspace, diff } = await buildLocalDiffContext({
      repo: repoConfig(),
      cwd: fixture.repoPath,
      baseRef: "main",
    });

    assert.equal(workspace.baseRef, "main");
    assert.equal(workspace.diffTarget, "working-tree");
    assert.ok(workspace.diffBaseRef, "local diff should resolve a merge-base for the working tree");
    assert.ok(diff.inventory.some((entry) => entry.path === "src.ts" && entry.classification === "full_patch"));
    assert.ok(diff.inventory.some((entry) => entry.path === "extra.ts" && entry.classification === "full_patch"));
    assert.ok(diff.patches.some((entry) => entry.path === "src.ts"));
    assert.ok(diff.patches.some((entry) => entry.path === "extra.ts"));
  } finally {
    await rm(fixture.repoPath, { recursive: true, force: true });
  }
});

test("parseGitHubRepoFullName handles common GitHub remote URL formats", () => {
  assert.equal(parseGitHubRepoFullName("https://github.com/krasnoperov/patchrelay.git"), "krasnoperov/patchrelay");
  assert.equal(parseGitHubRepoFullName("https://github.com/krasnoperov/patchrelay"), "krasnoperov/patchrelay");
  assert.equal(parseGitHubRepoFullName("git@github.com:krasnoperov/patchrelay.git"), "krasnoperov/patchrelay");
  assert.equal(parseGitHubRepoFullName("git@github.com:krasnoperov/patchrelay"), "krasnoperov/patchrelay");
  assert.equal(parseGitHubRepoFullName(""), undefined);
  assert.equal(parseGitHubRepoFullName("not-a-url"), undefined);
});

test("buildDiffContext drops oversized files so smaller files fit the budget", async () => {
  const fixture = await createRepo();
  try {
    // small.ts: ~30 bytes → ~9 tokens + framing
    await writeFile(path.join(fixture.repoPath, "small.ts"), "export const s = 1;\n", "utf8");
    // medium.ts: ~200 bytes → ~60 tokens + framing
    const mediumLines = Array.from({ length: 10 }, (_, i) => `export const m${i} = ${i};`).join("\n");
    await writeFile(path.join(fixture.repoPath, "medium.ts"), `${mediumLines}\n`, "utf8");
    // huge.ts: ~2500 bytes → ~720 tokens + framing
    const hugeLines = Array.from({ length: 100 }, (_, i) => `export const h${i} = "value-${i}-padded";`).join("\n");
    await writeFile(path.join(fixture.repoPath, "huge.ts"), `${hugeLines}\n`, "utf8");
    git(fixture.repoPath, "add", ".");
    git(fixture.repoPath, "commit", "-m", "three files");

    // Budget tight enough to fit small + medium but not huge.
    const diff = await buildDiffContext(
      repoConfig({ patchBodyBudgetTokens: 200 }),
      workspace(fixture.repoPath, fixture.baseSha),
    );

    const patchPaths = diff.patches.map((entry) => entry.path).sort();
    assert.deepEqual(patchPaths, ["medium.ts", "small.ts"]);
    const overflowed = diff.suppressed.find((entry) => entry.path === "huge.ts");
    assert.ok(overflowed, "huge.ts should land in suppressed");
    assert.equal(overflowed?.reason, "budget_exceeded");
    // The final inventory entry for huge.ts must reflect the *final*
    // classification, not the provisional one.
    assert.equal(
      diff.inventory.find((entry) => entry.path === "huge.ts")?.classification,
      "summarize",
    );
    assert.equal(
      diff.inventory.find((entry) => entry.path === "huge.ts")?.reason,
      "budget_exceeded",
    );
  } finally {
    await rm(fixture.repoPath, { recursive: true, force: true });
  }
});

test("buildDiffContext prefers small files when the budget only fits a few", async () => {
  const fixture = await createRepo();
  try {
    // Three files with distinct sizes. With a budget that fits only one,
    // the smallest should survive (because the greedy sort considers
    // biggest first and drops them on overflow).
    await writeFile(path.join(fixture.repoPath, "a-small.ts"), "export const a = 1;\n", "utf8");
    await writeFile(
      path.join(fixture.repoPath, "b-medium.ts"),
      Array.from({ length: 20 }, (_, i) => `export const b${i} = ${i};`).join("\n") + "\n",
      "utf8",
    );
    await writeFile(
      path.join(fixture.repoPath, "c-large.ts"),
      Array.from({ length: 80 }, (_, i) => `export const c${i} = "padded-string-${i}";`).join("\n") + "\n",
      "utf8",
    );
    git(fixture.repoPath, "add", ".");
    git(fixture.repoPath, "commit", "-m", "three sizes");

    // Budget that fits ONLY the smallest file after framing overhead.
    // A minimal new-file patch (header + one `+` line) runs ~165 bytes ≈
    // ~47 tokens, plus 23 tokens of framing overhead → ~70 tokens. 100 is
    // tight enough to exclude b-medium.ts (~170 tokens) and c-large.ts
    // (~500 tokens) while comfortably fitting a-small.ts.
    const diff = await buildDiffContext(
      repoConfig({ patchBodyBudgetTokens: 100 }),
      workspace(fixture.repoPath, fixture.baseSha),
    );

    assert.equal(diff.patches.length, 1);
    assert.equal(diff.patches[0]?.path, "a-small.ts");
    const overflowPaths = diff.suppressed
      .filter((entry) => entry.reason === "budget_exceeded")
      .map((entry) => entry.path)
      .sort();
    assert.deepEqual(overflowPaths, ["b-medium.ts", "c-large.ts"]);
  } finally {
    await rm(fixture.repoPath, { recursive: true, force: true });
  }
});

test("buildDiffContext demotes pure-deletion files to suppressed with reason=no_additions", async () => {
  const fixture = await createRepo();
  try {
    // Add a file with some content, then delete the entire file. The
    // resulting diff has only deletion hunks — after stripping them,
    // no hunks remain and the file should be demoted to suppressed,
    // NOT left as an empty `\`\`\`diff ... \`\`\`` block in patches.
    await writeFile(
      path.join(fixture.repoPath, "doomed.ts"),
      "export const a = 1;\nexport const b = 2;\nexport const c = 3;\n",
      "utf8",
    );
    git(fixture.repoPath, "add", ".");
    git(fixture.repoPath, "commit", "-m", "add doomed file");
    const baseSha = git(fixture.repoPath, "rev-parse", "HEAD").trim();

    git(fixture.repoPath, "rm", "doomed.ts");
    git(fixture.repoPath, "commit", "-m", "delete doomed file");

    const diff = await buildDiffContext(
      repoConfig(),
      workspace(fixture.repoPath, baseSha),
    );

    assert.equal(
      diff.patches.some((entry) => entry.path === "doomed.ts"),
      false,
      "pure-deletion file must not appear in patches",
    );
    const suppressed = diff.suppressed.find((entry) => entry.path === "doomed.ts");
    assert.ok(suppressed, "pure-deletion file must be in suppressed list");
    assert.equal(suppressed?.reason, "no_additions");
    assert.equal(
      diff.inventory.find((entry) => entry.path === "doomed.ts")?.classification,
      "summarize",
    );
  } finally {
    await rm(fixture.repoPath, { recursive: true, force: true });
  }
});

test("buildDiffContext strips deletion-only hunks", async () => {
  const fixture = await createRepo();
  try {
    // Start with a file that has two separate regions, so we can delete
    // one region entirely (pure deletion) and modify the other (mixed).
    const baseContent = [
      "// region A",
      "export const aOne = 1;",
      "export const aTwo = 2;",
      "export const aThree = 3;",
      "",
      "// filler line 1",
      "// filler line 2",
      "// filler line 3",
      "// filler line 4",
      "// filler line 5",
      "// filler line 6",
      "// filler line 7",
      "// filler line 8",
      "// filler line 9",
      "// filler line 10",
      "",
      "// region B",
      "export const bOne = 10;",
      "export const bTwo = 20;",
      "",
    ].join("\n");
    await writeFile(path.join(fixture.repoPath, "two-regions.ts"), baseContent, "utf8");
    git(fixture.repoPath, "add", ".");
    git(fixture.repoPath, "commit", "-m", "base for hunk test");
    const baseSha = git(fixture.repoPath, "rev-parse", "HEAD").trim();

    // Delete region A entirely (pure-deletion hunk), modify region B
    // (mixed add+delete hunk).
    const nextContent = [
      "",
      "// filler line 1",
      "// filler line 2",
      "// filler line 3",
      "// filler line 4",
      "// filler line 5",
      "// filler line 6",
      "// filler line 7",
      "// filler line 8",
      "// filler line 9",
      "// filler line 10",
      "",
      "// region B",
      "export const bOne = 999;",
      "export const bTwo = 20;",
      "",
    ].join("\n");
    await writeFile(path.join(fixture.repoPath, "two-regions.ts"), nextContent, "utf8");
    git(fixture.repoPath, "add", ".");
    git(fixture.repoPath, "commit", "-m", "drop region A, modify region B");

    const diff = await buildDiffContext(
      repoConfig(),
      workspace(fixture.repoPath, baseSha),
    );

    const patch = diff.patches.find((entry) => entry.path === "two-regions.ts")?.patch;
    assert.ok(patch, "two-regions.ts should be in patches");
    // The deletion-only hunk (dropping region A lines) should be stripped.
    // The mixed hunk (changing bOne) should be kept.
    assert.ok(patch!.includes("+export const bOne = 999;"), "mixed hunk must survive");
    assert.ok(!patch!.includes("-export const aOne = 1;"), "pure-deletion hunk must be stripped");
  } finally {
    await rm(fixture.repoPath, { recursive: true, force: true });
  }
});
