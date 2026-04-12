import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildFollowUpRunPrompt,
  buildInitialRunPrompt,
  buildRunPrompt as buildLayeredRunPrompt,
  findDisallowedPatchRelayPromptSectionIds,
} from "../src/prompting/patchrelay.ts";
import { shouldReuseIssueThread } from "../src/run-launcher.ts";
import type { PromptCustomizationLayer } from "../src/types.ts";
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

    const prompt = buildInitialRunPrompt({ issue: createIssue(), runType: "implementation", repoPath: baseDir });

    assert.match(prompt, /## Task Objective/);
    assert.match(prompt, /## Scope Discipline/);
    assert.match(prompt, /Stay inside the delegated task/);
    assert.match(prompt, /implementation goal is to leave the branch review-ready, not merely locally working/);
    assert.match(prompt, /If a narrow patch fixes the immediate symptom but leaves the same underlying risk elsewhere in the changed flow, keep going/);
    assert.match(prompt, /### Likely Review Invariants/);
    assert.match(prompt, /## Publication Requirements/);
    assert.match(prompt, /commit them, push the issue branch, and open or update the PR before stopping/);
    assert.match(prompt, /Do not stop with only local commits or uncommitted changes/);
    assert.doesNotMatch(prompt, /## Follow-up Turn/);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("repair prompts append publication requirements for the existing PR branch", () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-prompt-"));
  try {
    writeFileSync(path.join(baseDir, "IMPLEMENTATION_WORKFLOW.md"), "# Implementation Workflow\n");

    const prompt = buildLayeredRunPrompt({
      issue: {
        ...createIssue(),
        factoryState: "repairing_ci",
        prNumber: 12,
      },
      runType: "ci_repair",
      repoPath: baseDir,
      context: { checkName: "lint" },
    });

    assert.match(prompt, /## Publication Requirements/);
    assert.match(prompt, /publish the result to the existing PR branch/);
    assert.match(prompt, /Do not open a new PR/);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("implementation prompts keep the no-PR case explicit without switching delivery modes", () => {
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

    const prompt = buildInitialRunPrompt({ issue, runType: "implementation", repoPath: baseDir });

    assert.match(prompt, /## Publication Requirements/);
    assert.match(prompt, /If the task is genuinely complete without a PR, say so clearly in your normal summary instead of inventing one/);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("branch_upkeep prompt includes explicit branch upkeep guidance when the PR is still dirty", () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-prompt-"));
  try {
    writeFileSync(path.join(baseDir, "REVIEW_WORKFLOW.md"), "# Review Workflow\n");

    const prompt = buildFollowUpRunPrompt({
      issue: {
        ...createIssue(),
        factoryState: "changes_requested",
        prNumber: 12,
        prReviewState: "changes_requested",
      },
      runType: "branch_upkeep",
      repoPath: baseDir,
      context: {
        promptContext: "The requested review change is already addressed, but GitHub still reports PR #12 as DIRTY against latest main. Before stopping, update the existing PR branch onto latest main, resolve any conflicts, rerun the narrowest relevant verification, and push again.",
        branchUpkeepRequired: true,
        mergeStateStatus: "DIRTY",
        baseBranch: "main",
        wakeReason: "branch_upkeep",
        githubFactsFresh: true,
      },
    });

    assert.match(prompt, /## Follow-up Turn/);
    assert.match(prompt, /Why this turn exists: GitHub still shows the PR branch as needing upkeep after the requested code change was addressed/);
    assert.match(prompt, /## Branch Upkeep After Requested Changes/);
    assert.match(prompt, /## Current PR Facts/);
    assert.match(prompt, /Fact freshness: refreshed immediately before this turn was created\./);
    assert.match(prompt, /Current PR: #12/);
    assert.match(prompt, /Current review state: changes_requested/);
    assert.match(prompt, /Merge state against main: DIRTY/);
    assert.match(prompt, /Goal: restore merge readiness on the existing PR branch without regressing review or CI readiness\./);
    assert.match(prompt, /update the existing PR branch onto latest main/);
    assert.doesNotMatch(prompt, /## Review Changes Requested/);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("review_fix prompt embeds structured inline review context", () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-prompt-"));
  try {
    writeFileSync(path.join(baseDir, "REVIEW_WORKFLOW.md"), "# Review Workflow\n");

    const prompt = buildFollowUpRunPrompt({
      issue: {
        ...createIssue(),
        factoryState: "changes_requested",
        prNumber: 26,
        prReviewState: "changes_requested",
      },
      runType: "review_fix",
      repoPath: baseDir,
      context: {
        reviewerName: "review-quill",
        reviewBody: "The recovery shell still shows fake standings.",
        reviewId: 901,
        reviewCommitId: "abc123def456",
        reviewUrl: "https://github.com/owner/repo/pull/26#pullrequestreview-901",
        reviewComments: [
          {
            body: "Blank totals should not produce a leader.",
            path: "src/frontend/app/sessionSchema.ts",
            line: 1526,
            side: "RIGHT",
            url: "https://github.com/owner/repo/pull/26#discussion_r71",
          },
        ],
      },
    });

    assert.match(prompt, /## Structured Review Context/);
    assert.match(prompt, /## Scope Discipline/);
    assert.match(prompt, /Only broaden to adjacent routes, copy, or supporting surfaces when the issue text or repository guidance explicitly says they are the same user flow/);
    assert.match(prompt, /Review ID: 901/);
    assert.match(prompt, /Reviewed commit: abc123def456/);
    assert.match(prompt, /Inline review comments captured: 1/);
    assert.match(prompt, /only complete if you push a newer PR head or deliberately escalate/);
    assert.match(prompt, /src\/frontend\/app\/sessionSchema\.ts:1526 \(RIGHT\)/);
    assert.match(prompt, /Blank totals should not produce a leader\./);
    assert.match(prompt, /Goal: restore review readiness on the existing PR branch, not merely patch the latest cited line\./);
    assert.match(prompt, /Treat the reviewer comments as evidence of what still makes the branch unready\./);
    assert.match(prompt, /1\. Start with the structured review context below, then inspect the PR's inline review comments with `gh api repos\/<owner>\/<repo>\/pulls\/<pr>\/comments\?per_page=100`/);
    assert.match(prompt, /2\. Inspect the current diff with `review-quill diff` when available so you see the reviewer-oriented diff view from this checkout; use `git diff origin\/main` as a fallback/);
    assert.match(prompt, /Infer the underlying concern or invariant behind the review feedback\./);
    assert.match(prompt, /Only finish when you believe the branch is review-ready again\./);
    assert.match(prompt, /GitHub review happens after the new head is pushed and CI is green/);
    assert.doesNotMatch(prompt, /If you believe all concerns are resolved, request a re-review/);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("thread reuse is limited to explicit follow-up continuity", () => {
  assert.equal(
    shouldReuseIssueThread({
      existingThreadId: "thread-1",
      compactThread: false,
      resumeThread: false,
    }),
    false,
  );
  assert.equal(
    shouldReuseIssueThread({
      existingThreadId: "thread-1",
      compactThread: false,
      resumeThread: true,
    }),
    true,
  );
  assert.equal(
    shouldReuseIssueThread({
      existingThreadId: "thread-1",
      compactThread: true,
      resumeThread: true,
    }),
    false,
  );
});

test("buildRunPrompt switches implementation follow-ups to the follow-up prompt shape", () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-prompt-"));
  try {
    writeFileSync(path.join(baseDir, "IMPLEMENTATION_WORKFLOW.md"), "# Implementation Workflow\n");

    const prompt = buildLayeredRunPrompt({
      issue: {
        ...createIssue(),
        factoryState: "pr_open",
        prNumber: 22,
        prHeadSha: "abc123def456",
        prReviewState: "commented",
      },
      runType: "implementation",
      repoPath: baseDir,
      context: {
        wakeReason: "followup_comment",
        followUpMode: true,
        followUps: [
          { type: "followup_comment", text: "Please keep the existing API stable.", author: "alice" },
        ],
      },
    });

    assert.match(prompt, /## Follow-up Turn/);
    assert.match(prompt, /Why this turn exists: A human follow-up comment arrived after the previous turn/);
    assert.match(prompt, /Required action now: Continue from the latest branch state/);
    assert.match(prompt, /Recent updates:/);
    assert.doesNotMatch(prompt, /## What Changed Since The Last Turn/);
    assert.match(prompt, /followup_comment from alice: Please keep the existing API stable/);
    assert.match(prompt, /## Current PR Facts/);
    assert.match(prompt, /Fact freshness: may now be stale; refresh before making irreversible decisions\./);
    assert.match(prompt, /Current PR: #22/);
    assert.match(prompt, /Current relevant head SHA: abc123def456/);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("buildRunPrompt keeps direct-reply follow-ups concise", () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-direct-reply-prompt-"));
  try {
    writeFileSync(path.join(baseDir, "IMPLEMENTATION_WORKFLOW.md"), "# Implementation Workflow\n");

    const prompt = buildLayeredRunPrompt({
      issue: {
        ...createIssue(),
        factoryState: "awaiting_input",
        prNumber: 22,
        prHeadSha: "abc123def456",
      },
      runType: "implementation",
      repoPath: baseDir,
      context: {
        wakeReason: "direct_reply",
        directReplyMode: true,
        followUpCount: 1,
        followUps: [
          { type: "direct_reply", text: "Use the staged rollout copy.", author: "alice" },
        ],
      },
    });

    assert.match(prompt, /Why this turn exists: A human reply arrived for the outstanding question from the previous turn/);
    assert.match(prompt, /Required action now: Apply the latest human answer, continue from the current branch\/session context/);
    assert.match(prompt, /direct_reply from alice: Use the staged rollout copy/);
    assert.doesNotMatch(prompt, /## Direct Reply Handling/);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("buildRunPrompt applies extra instructions and section replacement without replacing the whole default prompt", () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-prompt-layer-"));
  const promptLayer: PromptCustomizationLayer = {
    extraInstructions: { sourcePath: "/install/local-policy.md", content: "Use the repo's rollout checklist." },
    replaceSections: {
      "publication-contract": {
        sourcePath: "/repo/publication.md",
        content: "## Publication Requirements\n\nUse the existing publication contract.",
      },
    },
  };

  try {
    writeFileSync(path.join(baseDir, "IMPLEMENTATION_WORKFLOW.md"), "# Implementation Workflow\n\nStay focused.\n");

    const prompt = buildLayeredRunPrompt({
      issue: {
        ...createIssue(),
        factoryState: "delegated",
      },
      runType: "implementation",
      repoPath: baseDir,
      promptLayer,
    });

    assert.match(prompt, /## Extra Instructions/);
    assert.match(prompt, /Use the repo's rollout checklist\./);
    assert.match(prompt, /## Task Objective/);
    assert.match(prompt, /## Scope Discipline/);
    assert.match(prompt, /Stay focused\./);
    assert.match(prompt, /Use the existing publication contract/);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("disallowed PatchRelay section replacements are detected and ignored by the builder", () => {
  const promptLayer: PromptCustomizationLayer = {
    replaceSections: {
      "reactive-context": {
        sourcePath: "/repo/reactive.md",
        content: "## Reactive Context\n\nDo not use this replacement.",
      },
    },
  };

  assert.deepEqual(findDisallowedPatchRelayPromptSectionIds(promptLayer), ["reactive-context"]);
});
