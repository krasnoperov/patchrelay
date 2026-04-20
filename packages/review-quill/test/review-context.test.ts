import assert from "node:assert/strict";
import test from "node:test";
import { resolvePromptPullRequest } from "../src/review-context.ts";
import type { PullRequestSummary } from "../src/types.ts";

function basePr(overrides: Partial<PullRequestSummary> = {}): PullRequestSummary {
  return {
    number: 42,
    title: "Original title",
    body: "Original body",
    url: "https://example.invalid/pr/42",
    state: "OPEN",
    isDraft: false,
    headSha: "abc123",
    headRefName: "feature/review",
    baseRefName: "main",
    ...overrides,
  };
}

test("resolvePromptPullRequest refreshes title and body when the head is unchanged", async () => {
  const resolved = await resolvePromptPullRequest({
    github: {
      getPullRequest: async () => basePr({
        title: "Updated title",
        body: "Updated body",
      }),
    } as never,
    repoFullName: "example/fixture",
    pr: basePr(),
  });

  assert.equal(resolved.headSha, "abc123");
  assert.equal(resolved.title, "Updated title");
  assert.equal(resolved.body, "Updated body");
});

test("resolvePromptPullRequest keeps the original snapshot when the head changed", async () => {
  const original = basePr();
  const resolved = await resolvePromptPullRequest({
    github: {
      getPullRequest: async () => basePr({
        headSha: "def456",
        title: "Updated title",
        body: "Updated body",
      }),
    } as never,
    repoFullName: "example/fixture",
    pr: original,
  });

  assert.equal(resolved, original);
});
