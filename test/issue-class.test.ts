import assert from "node:assert/strict";
import test from "node:test";
import { classifyIssue } from "../src/issue-class.ts";

test("classifyIssue only marks parent issues with child issues as orchestration", () => {
  assert.deepEqual(
    classifyIssue({
      issue: {
        title: "Umbrella migration tracker",
        description: "Looks orchestration-ish but has no children.",
      },
      childIssueCount: 0,
    }),
    { issueClass: "implementation", issueClassSource: "heuristic" },
  );

  assert.deepEqual(
    classifyIssue({
      issue: {
        title: "Parent issue",
        description: "Has concrete child work.",
      },
      childIssueCount: 2,
    }),
    { issueClass: "orchestration", issueClassSource: "hierarchy" },
  );
});

test("classifyIssue never marks child issues as orchestration", () => {
  assert.deepEqual(
    classifyIssue({
      issue: {
        issueClass: "orchestration",
        issueClassSource: "explicit",
        title: "Explicitly tagged child",
        description: "Still a child task.",
        parentLinearIssueId: "parent-1",
      },
      childIssueCount: 3,
    }),
    { issueClass: "implementation", issueClassSource: "hierarchy" },
  );
});

test("classifyIssue only honors explicit orchestration when child issues exist", () => {
  assert.deepEqual(
    classifyIssue({
      issue: {
        issueClass: "orchestration",
        issueClassSource: "explicit",
        title: "Explicit orchestration parent",
        description: "Parent with children.",
      },
      childIssueCount: 1,
    }),
    { issueClass: "orchestration", issueClassSource: "explicit" },
  );

  assert.deepEqual(
    classifyIssue({
      issue: {
        issueClass: "orchestration",
        issueClassSource: "explicit",
        title: "Explicit orchestration without children",
        description: "Should not start as orchestration.",
      },
      childIssueCount: 0,
    }),
    { issueClass: "implementation", issueClassSource: "heuristic" },
  );
});
