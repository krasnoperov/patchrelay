import assert from "node:assert/strict";
import test from "node:test";
import { deriveIssueStatusNote } from "../src/status-note.ts";

test("deriveIssueStatusNote prefers failure context over the latest assistant summary for failed issues", () => {
  const note = deriveIssueStatusNote({
    issue: { workflowOutcome: "failed" },
    sessionSummary: "Last assistant summary that should not win.",
    latestRun: {
      id: 1,
      issueId: 1,
      projectId: "project",
      linearIssueId: "issue-1",
      runType: "review_fix",
      status: "completed",
      startedAt: "2026-04-07T22:30:00.000Z",
      summaryJson: JSON.stringify({
        assistantMessages: ["Aligned the route copy and reran checks."],
      }),
    } as never,
    failureSummary: "CI repair budget exhausted (3 attempts)",
  });

  assert.equal(note, "CI repair budget exhausted (3 attempts)");
});

test("deriveIssueStatusNote still prefers explicit operator events for escalated issues", () => {
  const note = deriveIssueStatusNote({
    issue: { workflowOutcome: "escalated" },
    latestEvent: {
      eventType: "stop_requested",
    } as never,
    failureSummary: "CI repair budget exhausted (3 attempts)",
  });

  assert.equal(note, "Operator stopped the run. Use retry or delegate again to resume.");
});

test("deriveIssueStatusNote surfaces dirty worktree context for stopped runs", () => {
  const note = deriveIssueStatusNote({
    issue: { inputRequestKind: "completion_check_question" },
    latestEvent: {
      eventType: "stop_requested",
      eventJson: JSON.stringify({
        dirtyWorktree: true,
        summary: "Worktree has unresolved merge conflicts: src/shared/voice/tutor-voice.test.ts",
      }),
    } as never,
  });

  assert.equal(
    note,
    "Operator stopped the run with dirty worktree: Worktree has unresolved merge conflicts: src/shared/voice/tutor-voice.test.ts. Use retry or delegate again to resume.",
  );
});

test("deriveIssueStatusNote unwraps shell-wrapped commands in assistant summaries", () => {
  const note = deriveIssueStatusNote({
    issue: { workflowOutcome: "completed" },
    latestRun: {
      id: 1,
      issueId: 1,
      projectId: "project",
      linearIssueId: "issue-1",
      runType: "implementation",
      status: "completed",
      startedAt: "2026-04-07T22:30:00.000Z",
      summaryJson: JSON.stringify({
        latestAssistantMessage:
          "Verification passed with `/bin/bash -lc 'npm run test:ui:local -- tests/ui/app-shell.spec.ts tests/ui/game-flow.spec.ts'`.",
      }),
    } as never,
  });

  assert.equal(
    note,
    "Verification passed with `npm run test:ui:local -- tests/ui/app-shell.spec.ts tests/ui/game-flow.spec.ts`.",
  );
});

test("deriveIssueStatusNote prefers outcome summaries over raw assistant output", () => {
  const note = deriveIssueStatusNote({
    issue: { workflowOutcome: "completed" },
    latestRun: {
      id: 1,
      issueId: 1,
      projectId: "project",
      linearIssueId: "issue-1",
      runType: "review_fix",
      status: "completed",
      startedAt: "2026-04-07T22:30:00.000Z",
      summaryJson: JSON.stringify({
        outcomeSummary: "Addressed the requested review feedback and updated PR #42.",
        latestAssistantMessage: "Updated the branch, reran checks, and tweaked several details.",
      }),
    } as never,
  });

  assert.equal(note, "Addressed the requested review feedback and updated PR #42.");
});

test("deriveIssueStatusNote prefers completion-check questions for awaiting-input issues", () => {
  const note = deriveIssueStatusNote({
    issue: { inputRequestKind: "completion_check_question" },
    latestRun: {
      id: 1,
      issueId: 1,
      projectId: "project",
      linearIssueId: "issue-1",
      runType: "implementation",
      status: "completed",
      startedAt: "2026-04-10T08:00:00.000Z",
      completionCheckOutcome: "needs_input",
      completionCheckSummary: "Approval is required before continuing.",
      completionCheckQuestion: "Approve routing /v1/* through the worker?",
    } as never,
  });

  assert.equal(note, "Approve routing /v1/* through the worker?");
});

test("deriveIssueStatusNote suppresses stale repair summaries after downstream handoff", () => {
  const note = deriveIssueStatusNote({
    issue: {
      delegatedToPatchRelay: true,
      workflowOutcome: undefined,
      prNumber: 42,
      prState: "open",
      prReviewState: "approved",
    },
    sessionSummary: "same_head_review_handoff_blocked",
    latestRun: {
      id: 1,
      issueId: 1,
      projectId: "project",
      linearIssueId: "issue-1",
      runType: "review_fix",
      status: "failed",
      startedAt: "2026-06-16T22:41:08.000Z",
      failureReason: "same_head_review_handoff_blocked",
    } as never,
    waitingReason: "PatchRelay work is done; waiting on downstream review/merge automation",
  });

  assert.equal(note, undefined);
});

test("deriveIssueStatusNote suppresses stale repair failures after terminal completion", () => {
  const note = deriveIssueStatusNote({
    issue: { workflowOutcome: "completed" },
    sessionSummary: "same_head_review_handoff_blocked",
    latestRun: {
      id: 1,
      issueId: 1,
      projectId: "project",
      linearIssueId: "issue-1",
      runType: "review_fix",
      status: "superseded",
      startedAt: "2026-06-16T22:41:08.000Z",
      failureReason: "same_head_review_handoff_blocked",
    } as never,
    waitingReason: "PatchRelay work is complete",
  });

  assert.equal(note, undefined);
});
