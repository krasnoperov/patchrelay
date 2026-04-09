import assert from "node:assert/strict";
import test from "node:test";
import { renderDiffContextLines } from "../src/diff-context/index.ts";
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
      patchBodyBudgetTokens: 75_000,
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
      priorReviewClaims: [
        { authorLogin: "review-quill", state: "COMMENTED", commitId: "oldsha", excerpt: "Earlier note" },
      ],
      issueKeys: ["TST-28"],
    },
  };
}

test("renderReviewPrompt includes explicit guidance docs and suppressed summaries", () => {
  const prompt = renderReviewPrompt(baseContext());

  assert.match(prompt, /AGENTS\.md/);
  assert.match(prompt, /REVIEW_WORKFLOW\.md/);
  assert.match(prompt, /package-lock\.json .*— summary only by rule/);
  assert.doesNotMatch(prompt, /lockfile patch body/);
  assert.match(prompt, /src\/service\.ts/);
  assert.match(prompt, /Earlier note/);
  assert.match(prompt, /## Prior review claims to verify/);
  assert.match(prompt, /Do not repeat a claim just because it appeared in a previous review/);
  assert.match(prompt, /Linked issue keys detected: TST-28/);
  assert.match(prompt, /## Task Boundary/);
  assert.match(prompt, /Do not silently widen the delegated task/);
  assert.match(prompt, /broader product inconsistency should be blocking only when ONE of these is true/);
  assert.match(prompt, /Treat issue keys as identifiers only/);
  assert.match(prompt, /authoritative definition of this PR's scope on the current head/);
  assert.match(prompt, /historical claims to verify/);
  assert.match(prompt, /Do NOT claim that this PR changes files, routes, or surfaces that do not appear in that current diff inventory/);
});

test("renderReviewPrompt embeds renderDiffContextLines verbatim (CLI/LLM parity lock)", () => {
  // The `review-quill diff` CLI and the LLM prompt must render the diff
  // portion identically. They achieve this by both calling
  // `renderDiffContextLines(diff)`. This test locks that property — if
  // anyone ever re-inlines the rendering in prompt-builder/render.ts
  // (as happened once before), this assertion fails loudly.
  const context = baseContext();
  const prompt = renderReviewPrompt(context);
  const diffSection = renderDiffContextLines(context.diff).join("\n");
  assert.ok(
    prompt.includes(diffSection),
    "renderReviewPrompt output must contain renderDiffContextLines output as a substring",
  );
});
