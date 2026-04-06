import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { buildRunPrompt, resolveImplementationDeliveryMode } from "../src/run-orchestrator.ts";
import type { IssueRecord } from "../src/db-types.ts";

function createIssue(): IssueRecord {
  return {
    id: 1,
    projectId: "krasnoperov/ballony-i-nasosy",
    linearIssueId: "issue-1",
    issueKey: "TST-3",
    title: "Implement scoring for correct guesses, successful bluffs, and title winners",
    factoryState: "delegated",
    ciRepairAttempts: 0,
    queueRepairAttempts: 0,
    reviewFixAttempts: 0,
    updatedAt: "2026-04-06T00:00:00.000Z",
  };
}

test("implementation prompt always appends publication requirements even when the repo workflow omits them", () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-prompt-"));
  try {
    writeFileSync(path.join(baseDir, "IMPLEMENTATION_WORKFLOW.md"), [
      "# Implementation Workflow",
      "",
      "Work on the issue.",
      "",
      "Before finishing:",
      "",
      "- run tests",
    ].join("\n"));

    const prompt = buildRunPrompt(createIssue(), "implementation", baseDir);

    assert.match(prompt, /## Publication Requirements/);
    assert.match(prompt, /commit them, push the issue branch, and open or update the PR before stopping/);
    assert.match(prompt, /Do not stop with only local commits or uncommitted changes/);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("repair prompts append publication requirements for the existing PR branch", () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-prompt-"));
  try {
    writeFileSync(path.join(baseDir, "IMPLEMENTATION_WORKFLOW.md"), "# Implementation Workflow\n");

    const prompt = buildRunPrompt({
      ...createIssue(),
      factoryState: "repairing_ci",
      prNumber: 12,
    }, "ci_repair", baseDir, { checkName: "lint" });

    assert.match(prompt, /## Publication Requirements/);
    assert.match(prompt, /publish the result to the existing PR branch/);
    assert.match(prompt, /Do not open a new PR/);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("planning-only implementation prompts switch to Linear-only delivery requirements", () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-prompt-"));
  try {
    writeFileSync(path.join(baseDir, "IMPLEMENTATION_WORKFLOW.md"), "# Implementation Workflow\n");

    const issue = {
      ...createIssue(),
      description: [
        "This is a planning/specification issue only.",
        "Do not open a PR or make repository changes for this issue.",
        "Create follow-up Linear implementation issues and stop.",
      ].join("\n"),
    };

    const prompt = buildRunPrompt(issue, "implementation", baseDir);

    assert.equal(resolveImplementationDeliveryMode(issue), "linear_only");
    assert.match(prompt, /## Delivery Requirements/);
    assert.match(prompt, /Do not modify repo files or open a PR for this issue/);
    assert.doesNotMatch(prompt, /## Publication Requirements/);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("review_fix prompt includes explicit branch upkeep guidance when the PR is still dirty", () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-prompt-"));
  try {
    writeFileSync(path.join(baseDir, "REVIEW_WORKFLOW.md"), "# Review Workflow\n");

    const prompt = buildRunPrompt({
      ...createIssue(),
      factoryState: "changes_requested",
      prNumber: 12,
    }, "review_fix", baseDir, {
      promptContext: "The requested review change is already addressed, but GitHub still reports PR #12 as DIRTY against latest main. Before stopping, update the existing PR branch onto latest main, resolve any conflicts, rerun the narrowest relevant verification, and push again.",
      branchUpkeepRequired: true,
      mergeStateStatus: "DIRTY",
    });

    assert.match(prompt, /GitHub still reports PR #12 as DIRTY against latest main/);
    assert.match(prompt, /update the existing PR branch onto latest main/);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});
