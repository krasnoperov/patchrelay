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

test("classifyIssue marks no-code planning splits as orchestration before children exist", () => {
  assert.deepEqual(
    classifyIssue({
      issue: {
        title: "Analyze latency and create follow-up tasks",
        description: "Code is not needed here. Only analysis and planning. Create follow-up issues for the implementation work.",
      },
      childIssueCount: 0,
    }),
    { issueClass: "orchestration", issueClassSource: "heuristic" },
  );

  assert.deepEqual(
    classifyIssue({
      issue: {
        title: "Проанализировать где тратится время",
        description: "выдай отчет в Linear и поставь задачи на переделать. Код в этой задаче не делаем, только анализ и планирование.",
      },
      childIssueCount: 0,
    }),
    { issueClass: "orchestration", issueClassSource: "heuristic" },
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

test("classifyIssue preserves model triage classification until hierarchy facts override it", () => {
  assert.deepEqual(
    classifyIssue({
      issue: {
        issueClass: "orchestration",
        issueClassSource: "triage",
        title: "Model-triaged orchestration parent",
        description: "No children yet.",
      },
      childIssueCount: 0,
    }),
    { issueClass: "orchestration", issueClassSource: "triage" },
  );

  assert.deepEqual(
    classifyIssue({
      issue: {
        issueClass: "orchestration",
        issueClassSource: "triage",
        title: "Triaged child",
        parentLinearIssueId: "parent-1",
      },
      childIssueCount: 0,
    }),
    { issueClass: "implementation", issueClassSource: "hierarchy" },
  );
});
