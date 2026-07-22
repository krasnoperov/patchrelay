import assert from "node:assert/strict";
import test from "node:test";
import { resolvePostRunFactUpdate, type PostRunStateIssue } from "../src/run-completion-policy.ts";

const RUN_ID = 1;
const run = { id: RUN_ID, runType: "implementation" as const };
const clearFacts = { workflowOutcome: null, workflowOutcomeReason: null, inputRequestKind: null };
const completeFacts = { workflowOutcome: "completed", workflowOutcomeReason: "pr_merged", inputRequestKind: null };

function issue(overrides: Partial<PostRunStateIssue>): PostRunStateIssue {
  return {
    activeRunId: undefined,
    prNumber: undefined,
    prState: undefined,
    prHeadSha: undefined,
    prReviewState: undefined,
    prCheckStatus: undefined,
    lastBlockingReviewHeadSha: undefined,
    lastGitHubFailureSource: undefined,
    ...overrides,
  };
}

test("post-run resolution is a durable fact update, not a phase transition", () => {
  assert.equal(resolvePostRunFactUpdate(issue({ activeRunId: RUN_ID }), run), undefined);
  assert.deepEqual(resolvePostRunFactUpdate(issue({ activeRunId: RUN_ID, prNumber: 7, prState: "open" }), run), clearFacts);
  assert.deepEqual(resolvePostRunFactUpdate(issue({ activeRunId: RUN_ID, prNumber: 7, prState: "merged" }), run), completeFacts);
});

test("a completed run never overwrites a row whose active-run slot advanced", () => {
  assert.equal(resolvePostRunFactUpdate(issue({ activeRunId: 2, prNumber: 7, prState: "open" }), run), undefined);
  assert.equal(resolvePostRunFactUpdate(issue({ activeRunId: 2, prNumber: 7, prState: "merged" }), run), undefined);
});

test("recovery trusts current PR facts and clears stale terminal/input facts", () => {
  assert.deepEqual(
    resolvePostRunFactUpdate(issue({ prNumber: 7, prState: "open", prCheckStatus: "failed" }), run, { outcome: "recovered" }),
    clearFacts,
  );
  assert.deepEqual(
    resolvePostRunFactUpdate(issue({ prNumber: 7, prState: "merged" }), run, { outcome: "recovered" }),
    completeFacts,
  );
});

test("closed PR recovery still requires ownership of the active-run slot", () => {
  assert.deepEqual(
    resolvePostRunFactUpdate(issue({ activeRunId: RUN_ID, prNumber: 7, prState: "closed" }), run, { outcome: "recovered" }),
    clearFacts,
  );
  assert.equal(resolvePostRunFactUpdate(issue({ prNumber: 7, prState: "closed" }), run, { outcome: "recovered" }), undefined);
});
