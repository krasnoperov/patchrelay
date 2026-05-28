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
import { buildInitialImplementationGoal, shouldFreshenWorktreeBeforeLaunch, shouldPreserveDirtyWorktreeBeforeLaunch, shouldReuseIssueThread } from "../src/run-launcher.ts";
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

test("implementation prompt keeps a concise scaffold with workflow pointer and publish guidance", () => {
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
    assert.match(prompt, /## Constraints/);
    assert.match(prompt, /Stay inside the delegated task/);
    assert.match(prompt, /## Workflow/);
    assert.match(prompt, /Read and follow `IMPLEMENTATION_WORKFLOW\.md` in the repository for task-specific behavior/);
    assert.match(prompt, /## Publish/);
    assert.match(prompt, /If this is code-delivery work, publish before stopping: commit, push the issue branch, and open or update the PR\./);
    assert.match(prompt, /## Final Self-Review Before Push/);
    assert.match(prompt, /Before you open or update the PR, do one brief reviewer-minded pass on the current head\./);
    assert.match(prompt, /Fix any likely in-scope blocker you can see now: missing edge-case handling, broken adjacent invariant in the touched flow/);
    assert.match(prompt, /Name 2-4 concrete invariants most likely to regress in the touched flow, confirm which file or path enforces each one, and verify at least one adjacent path you did not edit directly\./);
    assert.match(prompt, /If you changed schema, enums, shared vocabulary, normalization helpers, or compatibility mappings, inspect the main read\/write paths that can bypass the new abstraction and verify one legacy-flow and one new-flow case before publishing\./);
    assert.match(prompt, /If the issue explicitly allows a non-PR outcome, complete that outcome clearly; otherwise publish before stopping\./);
    assert.doesNotMatch(prompt, /## PR Body Contract/);
    assert.doesNotMatch(prompt, /## Follow-up Turn/);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("initial implementation goal mirrors the delegated Linear issue", () => {
  const goal = buildInitialImplementationGoal({
    ...createIssue(),
    description: [
      "Players should see their score change during the round.",
      "",
      "## Acceptance criteria",
      "",
      "- Correct guesses increment the guesser.",
      "- Successful bluffs increment the bluffer.",
    ].join("\n"),
  });

  assert.equal(goal, "Implement scoring for correct guesses, successful bluffs, and title winners");
  assert.doesNotMatch(goal, /Implement Linear issue/);
  assert.doesNotMatch(goal, /Acceptance criteria/);
});

test("initial implementation goal uses only the explicit goal section when present", () => {
  const goal = buildInitialImplementationGoal({
    ...createIssue(),
    title: "iOS remote IVCard content and server API realignment",
    description: [
      "## Goal",
      "",
      "Realign the native iOS Image Cards app so catalogue metadata and images load from server APIs.",
      "",
      "## Acceptance criteria",
      "",
      "- The iOS app can fetch catalogue metadata and images from the server.",
      "- CI prevents accidental re-bundling of large image assets.",
    ].join("\n"),
  });

  assert.equal(
    goal,
    "iOS remote IVCard content and server API realignment. Realign the native iOS Image Cards app so catalogue metadata and images load from server APIs.",
  );
  assert.doesNotMatch(goal, /Acceptance criteria/);
});

test("repair prompts publish to the existing PR branch with concise self-review guidance", () => {
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

    assert.match(prompt, /## Publish/);
    assert.match(prompt, /Restore and publish on the existing PR branch: commit and push the same branch\./);
    assert.match(prompt, /Do not open a new PR/);
    assert.match(prompt, /A PR-less stop is not a successful outcome for a repair run unless a genuine external blocker prevents any correct push\./);
    assert.match(prompt, /After pushing a new head, stop and report the pushed commit\./);
    assert.match(prompt, /Do not poll or watch GitHub for CI, review, mergeability, review-quill, merge-steward, approval, or merge completion\./);
    assert.match(prompt, /Do not run blocking wait commands such as `gh pr checks --watch`/);
    assert.match(prompt, /PatchRelay receives GitHub webhooks for check, review, and base-branch changes/);
    assert.match(prompt, /If the issue text asks you to watch CI, wait for approval, or merge after checks pass, treat that as PatchRelay service responsibility/);
    assert.match(prompt, /Keep reactive repairs narrow: do not run TypeScript, lint, full test suites, Playwright, browser UI suites, or screenshot capture/);
    assert.match(prompt, /If the repair is a tiny reviewer-requested edit, commit and push the fresh head without broad local verification\./);
    assert.match(prompt, /Before changing code or config, reproduce the failure on the exact failing head or identify the concrete log signature that justifies the fix\./);
    assert.match(prompt, /If the exact failing head does not reproduce locally and the logs do not support a scoped fix, prefer a rerun-only repair over speculative branch changes\./);
    assert.match(prompt, /## Final Self-Review Before Push/);
    assert.match(prompt, /Before you push the existing PR branch, do one brief reviewer-minded pass on the current head\./);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("dirty repair continuation prompt preserves unpublished local work", () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-prompt-"));
  try {
    writeFileSync(path.join(baseDir, "IMPLEMENTATION_WORKFLOW.md"), "# Implementation Workflow\n");

    const prompt = buildLayeredRunPrompt({
      issue: {
        ...createIssue(),
        factoryState: "changes_requested",
        prNumber: 311,
        prHeadSha: "old-head",
      },
      runType: "review_fix",
      repoPath: baseDir,
      context: {
        wakeReason: "completion_check_continue",
        completionCheckSummary: "Repair run finished with a dirty worktree; Worktree has uncommitted changes: tests/integration/authenticated-ssr.spec.ts",
        preserveDirtyWorktree: true,
        dirtyWorktreeSummary: "Worktree has uncommitted changes: tests/integration/authenticated-ssr.spec.ts, tests/integration/ssr-hydration.spec.ts",
        dirtyWorktreeChangedPaths: [
          "tests/integration/authenticated-ssr.spec.ts",
          "tests/integration/ssr-hydration.spec.ts",
        ],
      },
    });

    assert.match(prompt, /Unpublished local work:/);
    assert.match(prompt, /Do not reset, clean, stash-drop, or otherwise discard the current worktree/);
    assert.match(prompt, /commit and push a fresh PR head/);
    assert.match(prompt, /tests\/integration\/authenticated-ssr\.spec\.ts/);
    assert.match(prompt, /tests\/integration\/ssr-hydration\.spec\.ts/);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("fresh-head queue repair prompt overrides patch-id no-op guard", () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-prompt-"));
  try {
    writeFileSync(path.join(baseDir, "IMPLEMENTATION_WORKFLOW.md"), "# Implementation Workflow\n");

    const prompt = buildLayeredRunPrompt({
      issue: {
        ...createIssue(),
        factoryState: "repairing_queue",
        prNumber: 1125,
        prHeadSha: "evictedhead",
        lastPublishedPatchId: "patch-id-1",
      },
      runType: "queue_repair",
      repoPath: baseDir,
      context: {
        failureReason: "queue_eviction_missed",
        requiresFreshHead: true,
        promptContext: "merge-steward will not re-admit this same head.",
      },
    });

    assert.match(prompt, /This queue repair requires a fresh PR head SHA/);
    assert.match(prompt, /If the patch-id matches, preserve the approved diff and still push a new head SHA/);
    assert.match(prompt, /create an empty queue-kick commit/);
    assert.doesNotMatch(prompt, /If they match, do not push — finish the run as a no-op/);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("implementation prompts keep explicit no-PR handling for planning-only issues", () => {
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

    assert.match(prompt, /## Publish/);
    assert.match(prompt, /If the issue explicitly allows a non-PR outcome, complete that outcome clearly instead of inventing a PR\./);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("orchestration prompts keep child-reuse and convergence babysitting guidance", () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-prompt-"));
  try {
    writeFileSync(path.join(baseDir, "IMPLEMENTATION_WORKFLOW.md"), "# Implementation Workflow\n");

    const prompt = buildInitialRunPrompt({
      issue: {
        ...createIssue(),
        issueClass: "orchestration",
      },
      runType: "implementation",
      repoPath: baseDir,
      context: {
        trackedDependents: [
          {
            issueKey: "TST-4",
            title: "Migrate public pages to Lingui",
            currentLinearState: "In Progress",
            factoryState: "implementing",
            delegatedToPatchRelay: true,
            hasOpenPr: true,
          },
          {
            issueKey: "TST-5",
            title: "Audit lingering translation helpers",
            currentLinearState: "Start",
            factoryState: "delegated",
            delegatedToPatchRelay: true,
            hasOpenPr: false,
          },
        ],
      },
    });

    assert.match(prompt, /## Constraints/);
    assert.match(prompt, /This issue is orchestration work\. Coordinate convergence instead of duplicating child implementation\./);
    assert.match(prompt, /Inspect the current child set before acting\. Reuse existing child issues when they already cover the needed slices instead of creating duplicates\./);
    assert.match(prompt, /Before creating child issues, list existing children and recent parent context, normalize the intended child purpose, and update or reuse matching issues\./);
    assert.match(prompt, /When you create or reuse children, leave a concise parent-visible split manifest naming the child IDs and what each one covers\./);
    assert.match(prompt, /Babysit child progress and solve parent-owned integration or convergence issues when the delivered pieces do not yet fit together cleanly\./);
    assert.match(prompt, /Do not open an overlapping umbrella PR unless this parent owns unique direct work\./);
    assert.match(prompt, /Create new child issues only for genuinely missing required work needed to satisfy the parent goal\./);
    assert.match(prompt, /Leave later-wave child issues queued unless they are immediately actionable\./);
    assert.match(prompt, /### Child Issue Summaries/);
    assert.match(prompt, /TST-4: Migrate public pages to Lingui \(In Progress; implementing; delegated; open PR\)/);
    assert.match(prompt, /TST-5: Audit lingering translation helpers \(Start; delegated; delegated; no open PR\)/);
    assert.match(prompt, /## Workflow/);
    assert.match(prompt, /Use the wake reason and child issue summaries to decide the next orchestration step\./);
    assert.match(prompt, /Prefer supervising, auditing, and unblocking existing child work over creating more issues\./);
    assert.match(prompt, /If the parent goal now depends on an integration fix between delivered child slices, own that convergence work here without restating already-owned child implementation\./);
    assert.match(prompt, /Close the umbrella when the original parent goal is satisfied\./);
    assert.match(prompt, /Create blocking follow-up work only when it is required to satisfy that goal\./);
    assert.match(prompt, /## Publish/);
    assert.match(prompt, /Publish the orchestration outcome clearly: observation, follow-up issues, rollout update, closeout, or a small parent-owned cleanup PR\./);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("orchestration follow-up prompts reason explicitly from the wake cause", () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-prompt-"));
  try {
    const prompt = buildFollowUpRunPrompt({
      issue: {
        ...createIssue(),
        issueClass: "orchestration",
      },
      runType: "implementation",
      repoPath: baseDir,
      context: {
        wakeReason: "child_delivered",
        trackedDependents: [
          {
            issueKey: "TST-4",
            title: "Migrate public pages to Lingui",
            currentLinearState: "Done",
            factoryState: "done",
            delegatedToPatchRelay: true,
            hasOpenPr: false,
          },
        ],
      },
    });

    assert.match(prompt, /## Current Context/);
    assert.match(prompt, /Turn reason: A child issue was delivered\./);
    assert.match(prompt, /## Workflow/);
    assert.match(prompt, /Use the wake reason and child issue summaries to decide the next orchestration step\./);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("branch_upkeep prompt folds follow-up and PR facts into current context", () => {
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

    assert.match(prompt, /## Current Context/);
    assert.match(prompt, /Turn reason: GitHub still shows the PR branch as needing upkeep\./);
    assert.match(prompt, /Current PR facts:/);
    assert.match(prompt, /Fact freshness: refreshed immediately before this turn was created\./);
    assert.match(prompt, /Current PR: #12/);
    assert.match(prompt, /Current review state: changes_requested/);
    assert.match(prompt, /Merge state against main: DIRTY/);
    assert.match(prompt, /Branch upkeep is required on the existing PR branch\./);
    assert.match(prompt, /Goal: restore merge readiness on the current branch\. Push a newer head only when the work actually changes the diff against the base/);
    assert.doesNotMatch(prompt, /## Follow-up Turn/);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("review_fix prompt keeps concise reviewer context plus structured comments", () => {
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

    assert.match(prompt, /## Constraints/);
    assert.match(prompt, /## Current Context/);
    assert.match(prompt, /Requested changes on the existing PR branch\./);
    assert.match(prompt, /Review ID: 901/);
    assert.match(prompt, /Reviewed commit: abc123def456/);
    assert.match(prompt, /Inline review comments captured: 1/);
    assert.match(prompt, /Do not push a commit that produces a patch-id-equivalent diff just to make the fix unmistakable\./);
    assert.match(prompt, /src\/frontend\/app\/sessionSchema\.ts:1526 \(RIGHT\)/);
    assert.match(prompt, /Blank totals should not produce a leader\./);
    assert.match(prompt, /Goal: restore review readiness on the current PR branch\. Push a newer head only when the fix actually changes the diff/);
    assert.match(prompt, /Address the real concern behind the feedback and verify nearby invariants in the touched flow before you publish\./);
    assert.match(prompt, /For each review comment, identify the resource, epoch, or token it touches[\s\S]*enumerate the other transitions that share that same resource, and verify each one before pushing/);
    assert.match(prompt, /## Final Self-Review Before Push/);
    assert.match(prompt, /Fix any likely in-scope blocker you can see now: missing edge-case handling, broken adjacent invariant in the touched flow/);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("review_fix prompt surfaces degraded GitHub review context before launch", () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-prompt-degraded-review-"));
  try {
    writeFileSync(path.join(baseDir, "REVIEW_WORKFLOW.md"), "# Review Workflow\n");

    const prompt = buildFollowUpRunPrompt({
      issue: {
        ...createIssue(),
        factoryState: "changes_requested",
        prNumber: 27,
        prReviewState: "changes_requested",
      },
      runType: "review_fix",
      repoPath: baseDir,
      context: {
        currentPrHeadSha: "sha-current",
        reviewContextStatus: "degraded",
        reviewContextDegraded: true,
        reviewContextDegradedReason: "GitHub requested-changes review context could not be fetched before launch.",
      },
    });

    assert.match(prompt, /GitHub review context refresh: degraded/);
    assert.match(prompt, /GitHub requested-changes review context could not be fetched before launch\./);
    assert.match(prompt, /Do not assume cached review details are current\. Re-read the PR review in GitHub before making review-fix changes\./);
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

test("plain review-fix runs stay on the live PR head instead of rebasing onto main", () => {
  assert.equal(shouldFreshenWorktreeBeforeLaunch({ runType: "review_fix" }), false);
  assert.equal(shouldFreshenWorktreeBeforeLaunch({
    runType: "review_fix",
    effectiveContext: { branchUpkeepRequired: true },
  }), true);
  assert.equal(shouldFreshenWorktreeBeforeLaunch({
    runType: "review_fix",
    effectiveContext: { reviewFixMode: "branch_upkeep" },
  }), true);
  assert.equal(shouldFreshenWorktreeBeforeLaunch({ runType: "branch_upkeep" }), true);
  assert.equal(shouldFreshenWorktreeBeforeLaunch({ runType: "queue_repair" }), false);
  assert.equal(shouldPreserveDirtyWorktreeBeforeLaunch({
    runType: "review_fix",
    effectiveContext: { preserveDirtyWorktree: true },
  }), true);
  assert.equal(shouldFreshenWorktreeBeforeLaunch({
    runType: "branch_upkeep",
    effectiveContext: { preserveDirtyWorktree: true },
  }), false);
  assert.equal(shouldPreserveDirtyWorktreeBeforeLaunch({
    runType: "implementation",
    effectiveContext: { preserveDirtyWorktree: true },
  }), false);
});

test("buildRunPrompt folds implementation follow-ups into current context", () => {
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

    assert.match(prompt, /## Current Context/);
    assert.match(prompt, /Turn reason: A human follow-up comment arrived after the previous turn\./);
    assert.match(prompt, /Recent updates:/);
    assert.match(prompt, /followup_comment from alice: Please keep the existing API stable/);
    assert.match(prompt, /Current PR facts:/);
    assert.match(prompt, /Fact freshness: may now be stale; refresh before making irreversible decisions\./);
    assert.match(prompt, /Current PR: #22/);
    assert.match(prompt, /Current relevant head SHA: abc123def456/);
    assert.doesNotMatch(prompt, /## Follow-up Turn/);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("buildRunPrompt keeps direct-reply follow-ups concise inside current context", () => {
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

    assert.match(prompt, /## Current Context/);
    assert.match(prompt, /Turn reason: Human reply to the previous question\./);
    assert.match(prompt, /direct_reply from alice: Use the staged rollout copy/);
    assert.doesNotMatch(prompt, /## Follow-up Turn/);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("buildRunPrompt includes recovered Linear agent activity context", () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-linear-activity-prompt-"));
  try {
    writeFileSync(path.join(baseDir, "IMPLEMENTATION_WORKFLOW.md"), "# Implementation Workflow\n");

    const prompt = buildLayeredRunPrompt({
      issue: {
        ...createIssue(),
        factoryState: "delegated",
      },
      runType: "implementation",
      repoPath: baseDir,
      context: {
        linearAgentActivityContext: [
          "- prompt: Please use the Linear activity history.",
          "- response: Previous run opened PR #478.",
        ].join("\n"),
        linearAgentActivityCount: 2,
      },
    });

    assert.match(prompt, /## Current Context/);
    assert.match(prompt, /Recovered Linear agent activity context:/);
    assert.match(prompt, /prompt: Please use the Linear activity history/);
    assert.match(prompt, /response: Previous run opened PR #478/);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("follow-up prompts describe closed PRs as replacement context instead of current PRs", () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-prompt-"));
  try {
    writeFileSync(path.join(baseDir, "IMPLEMENTATION_WORKFLOW.md"), "# Implementation Workflow\n");

    const prompt = buildFollowUpRunPrompt({
      issue: {
        ...createIssue(),
        factoryState: "implementing",
        prNumber: 260,
        prState: "closed",
        prHeadSha: "deadbeef",
      },
      runType: "implementation",
      repoPath: baseDir,
      context: {
        wakeReason: "followup_comment",
        followUpMode: true,
      },
    });

    assert.match(prompt, /Previous PR: #260 \(closed; replacement PR needed\)/);
    assert.doesNotMatch(prompt, /Current PR: #260/);
    assert.match(prompt, /Previous PR facts:/);
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
        content: "## Publish\n\nUse the existing publication contract.",
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
    assert.match(prompt, /## Constraints/);
    assert.match(prompt, /## Workflow/);
    assert.match(prompt, /Read and follow `IMPLEMENTATION_WORKFLOW\.md` in the repository for task-specific behavior/);
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
