import assert from "node:assert/strict";
import test from "node:test";
import type { IssueRecord } from "../src/db-types.ts";
import { renderGitHubTaskContract } from "../src/github-task-contract.ts";
import { buildInitialRunPrompt } from "../src/prompting/patchrelay.ts";

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
    workflowOutcome: undefined,
    blockedByCount: 0,
    blockedByKeys: [],
    readyForExecution: true,
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as IssueRecord;
}

test("implementation prompt preserves the complete task and supplies the same text for PR review", () => {
  const description = "## Scope\n\n- Preserve this exact task text.\n\n## Acceptance criteria\n\n- The reviewer sees it unchanged.";
  const prompt = buildInitialRunPrompt({
    issue: fakeIssue({ description }),
    runType: "implementation",
    repoPath: "/nonexistent",
  });

  assert.match(prompt, new RegExp(`## Task\\n\\n${description.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.match(prompt, /When opening the PR, include the task block below verbatim in the PR body/);
  assert.match(prompt, /<!-- patchrelay-task-contract:v1:start -->/);
  assert.match(prompt, /<!-- patchrelay-task-contract:v1:end -->/);
});

test("review_fix prompt keeps the original task ahead of reviewer feedback", () => {
  const prompt = buildInitialRunPrompt({
    issue: fakeIssue({
      description: "Known durations over 15 seconds must be submitted unchanged.",
      prNumber: 42,
      branchName: "example/EX-1",
    }),
    runType: "review_fix",
    repoPath: "/nonexistent",
    context: { reviewBody: "Reject known durations over 15 seconds." },
  });

  assert.ok(prompt.indexOf("Known durations over 15 seconds must be submitted unchanged.") < prompt.indexOf("Reject known durations over 15 seconds."));
  assert.match(prompt, /Preserve the existing `patchrelay-task-contract:v1` block in the PR body exactly/);
});

test("renderGitHubTaskContract preserves the exact issue description", () => {
  const issue = fakeIssue({ description: "The exact current task." });
  assert.match(renderGitHubTaskContract(issue), /\n\nThe exact current task\.\n<!-- patchrelay-task-contract:v1:end -->$/);
});
