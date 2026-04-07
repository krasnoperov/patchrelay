import assert from "node:assert/strict";
import test from "node:test";
import { renderReviewPrompt } from "../src/prompt-builder/index.ts";
import type { ReviewContext } from "../src/types.ts";

function baseContext(): Omit<ReviewContext, "prompt"> {
  return {
    workspaceMode: "checkout",
    workspace: {
      repoFullName: "example/fixture",
      cachePath: "/tmp/cache",
      worktreePath: "/tmp/worktree",
      baseRef: "origin/main",
      headRef: "refs/remotes/pull/1/head",
      headSha: "abc123",
    },
    repo: {
      repoId: "fixture",
      repoFullName: "example/fixture",
      baseBranch: "main",
      requiredChecks: ["Tests"],
      excludeBranches: [],
      reviewDocs: ["REVIEW_WORKFLOW.md", "CLAUDE.md", "AGENTS.md"],
      diffIgnore: [],
      diffSummarizeOnly: ["package-lock.json"],
      maxPatchLines: 400,
      maxPatchBytes: 24_000,
      maxFilesWithFullPatch: 20,
    },
    pr: {
      number: 42,
      title: "Tighten review context",
      body: "This PR improves review input quality.",
      url: "https://example.invalid/pr/42",
      state: "OPEN",
      isDraft: false,
      headSha: "abc123",
      headRefName: "feature/review",
      baseRefName: "main",
    },
    diff: {
      inventory: [
        {
          path: "src/service.ts",
          status: "M",
          additions: 10,
          deletions: 2,
          changes: 12,
          isBinary: false,
          classification: "full_patch",
        },
        {
          path: "package-lock.json",
          status: "M",
          additions: 40,
          deletions: 10,
          changes: 50,
          isBinary: false,
          classification: "summarize",
          reason: "summarize_only_policy",
        },
      ],
      patches: [
        {
          path: "src/service.ts",
          status: "M",
          additions: 10,
          deletions: 2,
          changes: 12,
          isBinary: false,
          classification: "full_patch",
          patch: "diff --git a/src/service.ts b/src/service.ts\n+export const updated = true;\n",
        },
      ],
      suppressed: [
        {
          path: "package-lock.json",
          status: "M",
          additions: 40,
          deletions: 10,
          changes: 50,
          isBinary: false,
          classification: "summarize",
          reason: "summarize_only_policy",
        },
      ],
    },
    promptContext: {
      guidanceDocs: [
        { path: "AGENTS.md", text: "Be careful with merges." },
        { path: "REVIEW_WORKFLOW.md", text: "Focus on correctness and regressions." },
      ],
      priorReviews: [
        { id: 1, authorLogin: "review-quill", state: "COMMENTED", body: "Earlier note", commitId: "oldsha" },
      ],
      issueKeys: ["TST-28"],
    },
  };
}

test("renderReviewPrompt includes explicit guidance docs and suppressed summaries", () => {
  const prompt = renderReviewPrompt(baseContext());

  assert.match(prompt, /AGENTS\.md/);
  assert.match(prompt, /REVIEW_WORKFLOW\.md/);
  assert.match(prompt, /package-lock\.json .*omitted: summarize_only_policy/);
  assert.doesNotMatch(prompt, /lockfile patch body/);
  assert.match(prompt, /src\/service\.ts/);
  assert.match(prompt, /Earlier note/);
  assert.match(prompt, /Linked issue keys detected: TST-28/);
  assert.match(prompt, /linear` MCP tool is available/);
});
