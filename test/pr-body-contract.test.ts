import assert from "node:assert/strict";
import test from "node:test";
import { buildInitialRunPrompt } from "../src/prompting/patchrelay.ts";
import type { IssueRecord } from "../src/db-types.ts";

function fakeIssue(overrides: Partial<IssueRecord> = {}): IssueRecord {
  return {
    id: 1,
    projectId: "krasnoperov/example",
    linearIssueId: "linear-1",
    delegatedToPatchRelay: true,
    issueKey: "EX-1",
    title: "Wire up a feature",
    issueUrl: "https://linear.app/example/issue/EX-1",
    currentLinearState: "In Progress",
    sessionState: "active",
    factoryState: "active",
    blockedByCount: 0,
    blockedByKeys: [],
    readyForExecution: true,
    waitingReason: null,
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as IssueRecord;
}

test("implementation prompt uses publish guidance instead of a built-in PR body contract", () => {
  const prompt = buildInitialRunPrompt({
    issue: fakeIssue(),
    runType: "implementation",
    repoPath: "/nonexistent",
  });

  assert.match(prompt, /## Publish/, "expected Publish section");
  assert.match(prompt, /open or update the PR/, "expected publish guidance for implementation runs");
  assert.ok(!/## PR Body Contract/.test(prompt), "built-in prompt should no longer carry a PR body contract");
});

test("review_fix prompt publishes to the existing PR branch without a PR body contract", () => {
  const prompt = buildInitialRunPrompt({
    issue: fakeIssue({ prNumber: 42, branchName: "krasnoperov-example/EX-1-wire-up-a-feature" }),
    runType: "review_fix",
    repoPath: "/nonexistent",
  });

  assert.match(prompt, /## Publish/, "review_fix should still carry publish guidance");
  assert.match(prompt, /existing PR branch/, "review_fix should target the existing PR branch");
  assert.ok(!/## PR Body Contract/.test(prompt), "review_fix should not carry the PR Body Contract");
});
