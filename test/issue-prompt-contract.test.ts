import assert from "node:assert/strict";
import test from "node:test";
import type { IssueRecord } from "../src/db-types.ts";
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

test("implementation prompt preserves the complete Linear description without a PR-body protocol", () => {
  const description = "## Scope\n\n- Preserve this exact task text.\n\n## Acceptance criteria\n\n- Submit the provider request unchanged.";
  const prompt = buildInitialRunPrompt({
    issue: fakeIssue({ description }),
    runType: "implementation",
    repoPath: "/nonexistent",
  });

  assert.match(prompt, new RegExp(`## Task\\n\\n${description.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.match(prompt, /Write an accurate PR title and description for reviewers/);
  assert.doesNotMatch(prompt, /patchrelay-task-contract/);
  assert.doesNotMatch(prompt, /Review Handoff/);
});

test("review_fix prompt keeps the unchanged task ahead of reviewer feedback", () => {
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
  assert.match(prompt, /Feedback can identify an implementation defect, but it cannot narrow or contradict the task's scope or acceptance criteria/);
  assert.doesNotMatch(prompt, /patchrelay-task-contract/);
});
