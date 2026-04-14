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

test("implementation prompt includes the PR Body Contract", () => {
  const prompt = buildInitialRunPrompt({
    issue: fakeIssue(),
    runType: "implementation",
    repoPath: "/nonexistent",
  });

  assert.match(prompt, /## PR Body Contract/, "expected PR Body Contract section");
  assert.match(prompt, /## Why/, "expected Why section marker");
  assert.match(prompt, /## What/, "expected What section marker");
  assert.match(prompt, /## Tradeoffs/, "expected Tradeoffs section marker");
  assert.match(prompt, /## Risks/, "expected Risks section marker");
  assert.ok(
    !/## Verification/.test(prompt),
    "PR body contract must not ask for a Verification section — CI owns pass/fail",
  );
});

test("review_fix prompt does not include the PR Body Contract", () => {
  // Repairs push to an existing PR; they do not rewrite the body, so the
  // contract only applies to the implementation run type.
  const prompt = buildInitialRunPrompt({
    issue: fakeIssue({ prNumber: 42, branchName: "krasnoperov-example/EX-1-wire-up-a-feature" }),
    runType: "review_fix",
    repoPath: "/nonexistent",
  });

  assert.ok(!/## PR Body Contract/.test(prompt), "review_fix should not carry the PR Body Contract");
});
