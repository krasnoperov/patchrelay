import assert from "node:assert/strict";
import test from "node:test";
import {
  deriveIssueExecutionState,
  deriveIssueExecutionStateFromRecords,
  type IssueExecutionState,
  type IssueExecutionStateInput,
} from "../src/issue-execution-state.ts";
import { resolveAwaitingInputReason } from "../src/awaiting-input-reason.ts";
import { derivePatchRelayWaitingReason, PATCHRELAY_WAITING_REASONS } from "../src/waiting-reason.ts";
import type { IssueRecord, RunRecord } from "../src/db-types.ts";

interface Row {
  name: string;
  input: IssueExecutionStateInput;
  expected: IssueExecutionState;
}

const FUTURE = new Date(Date.now() + 60 * 60_000).toISOString();

const TABLE: Row[] = [
  {
    name: "undelegated mid-implementation",
    input: { delegatedToPatchRelay: false, workflowOutcome: undefined },
    expected: { kind: "undelegated", downstreamMayContinue: false },
  },
  {
    name: "undelegated undecided PR is paused",
    input: { delegatedToPatchRelay: false, workflowOutcome: undefined, prNumber: 5, prState: "open" },
    expected: { kind: "undelegated", downstreamMayContinue: false },
  },
  {
    name: "undelegated approved open PR (downstream continues)",
    input: { delegatedToPatchRelay: false, workflowOutcome: undefined, prNumber: 5, prState: "open", prReviewState: "approved" },
    expected: { kind: "undelegated", downstreamMayContinue: true },
  },
  {
    name: "undelegated but already done stays terminal",
    input: { delegatedToPatchRelay: false, workflowOutcome: "completed" },
    expected: { kind: "terminal", outcome: "done" },
  },
  {
    name: "undelegation outranks an active run",
    input: { delegatedToPatchRelay: false, workflowOutcome: undefined, activeRunId: 4, activeRunType: "implementation" },
    expected: { kind: "undelegated", downstreamMayContinue: false },
  },
  {
    name: "plain active run",
    input: { workflowOutcome: undefined, activeRunId: 7, activeRunType: "implementation" },
    expected: { kind: "running", run: { activeRunId: 7, runType: "implementation", phase: "working" } },
  },
  {
    name: "active run known only by slot id",
    input: { workflowOutcome: undefined, activeRunId: 7 },
    expected: { kind: "running", run: { activeRunId: 7, phase: "working" } },
  },
  {
    name: "run finalizing a published PR",
    input: { workflowOutcome: undefined, activeRunId: 7, activeRunType: "implementation", prNumber: 12, prState: "open" },
    expected: { kind: "running", run: { activeRunId: 7, runType: "implementation", phase: "finalizing_published_pr" } },
  },
  {
    name: "run finalizing a merged change",
    input: { workflowOutcome: "completed", activeRunId: 7, activeRunType: "review_fix", prNumber: 12, prState: "merged" },
    expected: { kind: "running", run: { activeRunId: 7, runType: "review_fix", phase: "finalizing_merged_change" } },
  },
  {
    name: "reply run while awaiting_input is legitimate",
    input: { inputRequestKind: "completion_check_question", activeRunId: 9, activeRunType: "implementation" },
    expected: { kind: "running", run: { activeRunId: 9, runType: "implementation", phase: "working" } },
  },
  {
    name: "invariant violation: failed workflowOutcome with occupied run slot",
    input: { workflowOutcome: "failed", activeRunId: 3, activeRunType: "ci_repair" },
    expected: {
      kind: "inconsistent",
      description: 'terminal outcome "failed" still holds an active run slot',
      run: { activeRunId: 3, runType: "ci_repair", phase: "working" },
    },
  },
  {
    name: "invariant violation: escalated workflowOutcome with occupied run slot",
    input: { workflowOutcome: "escalated", activeRunId: 3 },
    expected: {
      kind: "inconsistent",
      description: 'terminal outcome "escalated" still holds an active run slot',
      run: { activeRunId: 3, phase: "working" },
    },
  },
  {
    name: "invariant violation: slot points at a terminal run (USE-364 shape)",
    input: { workflowOutcome: undefined, activeRunId: 3, activeRunType: "implementation", activeRunStatus: "completed" },
    expected: {
      kind: "inconsistent",
      description: "active run slot points at a completed run",
      run: { activeRunId: 3, runType: "implementation", phase: "working" },
    },
  },
  {
    name: "orchestration settle window",
    input: { workflowOutcome: undefined, orchestrationSettleUntil: FUTURE },
    expected: { kind: "settling", settleUntil: FUTURE },
  },
  {
    name: "expired settle window falls through",
    input: { workflowOutcome: undefined, orchestrationSettleUntil: "2020-01-01T00:00:00.000Z", runnableTaskRunType: "implementation" },
    expected: { kind: "ready", runnableTaskRunType: "implementation" },
  },
  {
    name: "blocked by dependencies",
    input: { workflowOutcome: undefined, blockedByKeys: ["USE-1", " ", "USE-2"] },
    expected: { kind: "blocked", blockedByKeys: ["USE-1", "USE-2"] },
  },
  {
    name: "awaiting input: paused local work",
    input: { inputRequestKind: "paused_local_work" },
    expected: { kind: "waiting_input", reason: "paused_local_work" },
  },
  {
    name: "awaiting input: completion check question",
    input: { inputRequestKind: "completion_check_question", latestRunCompletionCheckOutcome: "needs_input" },
    expected: { kind: "waiting_input", reason: "completion_check_question" },
  },
  {
    name: "changes requested without a run owes a review_fix",
    input: { workflowOutcome: undefined, prNumber: 8, prState: "open", prReviewState: "changes_requested" },
    expected: { kind: "awaiting_followup", followup: "review_fix" },
  },
  {
    name: "repairing_ci without a run owes a ci_repair",
    input: { workflowOutcome: undefined, prNumber: 8, prState: "open", lastGitHubFailureSource: "branch_ci", latestFailureCheckName: "spec/integration" },
    expected: { kind: "awaiting_followup", followup: "ci_repair", checkName: "spec/integration" },
  },
  {
    name: "repairing_queue without a run owes a queue_repair",
    input: { workflowOutcome: undefined, prNumber: 8, prState: "open", lastGitHubFailureSource: "queue_eviction" },
    expected: { kind: "awaiting_followup", followup: "queue_repair" },
  },
  {
    name: "awaiting_queue waits on the merge queue",
    input: { workflowOutcome: undefined, prNumber: 8, prState: "open", prReviewState: "approved" },
    expected: { kind: "idle_awaiting_external", waitingOn: "merge_queue" },
  },
  { name: "done", input: { workflowOutcome: "completed" }, expected: { kind: "terminal", outcome: "done" } },
  { name: "failed", input: { workflowOutcome: "failed" }, expected: { kind: "terminal", outcome: "failed" } },
  { name: "escalated", input: { workflowOutcome: "escalated" }, expected: { kind: "terminal", outcome: "escalated" } },
  {
    name: "settled red CI on an open PR",
    input: { workflowOutcome: undefined, prNumber: 8, prState: "open", prCheckStatus: "failed", latestFailureCheckName: "build" },
    expected: { kind: "idle_awaiting_external", waitingOn: "ci_failure", checkName: "build" },
  },
  {
    name: "blocking review with green checks on a newer head",
    input: { workflowOutcome: undefined, prNumber: 8, prHeadSha: "sha-2", prReviewState: "changes_requested", prCheckStatus: "success", lastBlockingReviewHeadSha: "sha-1" },
    expected: { kind: "idle_awaiting_external", waitingOn: "review_of_new_head" },
  },
  {
    name: "blocking review with green checks on the same head",
    input: { workflowOutcome: undefined, prNumber: 8, prHeadSha: "sha-1", prReviewState: "changes_requested", prCheckStatus: "success", lastBlockingReviewHeadSha: "sha-1" },
    expected: { kind: "idle_awaiting_external", waitingOn: "blocking_review_same_head" },
  },
  {
    name: "blocking review with pending checks",
    input: { workflowOutcome: undefined, prNumber: 8, prReviewState: "changes_requested", prCheckStatus: "pending" },
    expected: { kind: "awaiting_followup", followup: "review_fix" },
  },
  {
    name: "approved PR waits on downstream automation",
    input: { workflowOutcome: undefined, prNumber: 8, prState: "open", prReviewState: "approved" },
    expected: { kind: "idle_awaiting_external", waitingOn: "merge_queue" },
  },
  {
    name: "open PR with no signals waits on external review",
    input: { workflowOutcome: undefined, prNumber: 8, prState: "open" },
    expected: { kind: "idle_awaiting_external", waitingOn: "external_review" },
  },
  {
    name: "runnable workflow task is ready",
    input: { workflowOutcome: undefined, runnableTaskRunType: "queue_repair" },
    expected: { kind: "ready", runnableTaskRunType: "queue_repair" },
  },
  {
    name: "nothing pending at all",
    input: { workflowOutcome: undefined },
    expected: { kind: "idle" },
  },
];

test("deriveIssueExecutionState classifies representative issue shapes", () => {
  for (const row of TABLE) {
    assert.deepEqual(deriveIssueExecutionState(row.input), row.expected, row.name);
  }
});

test("inconsistent rows still render the observable run for operators", () => {
  assert.equal(
    derivePatchRelayWaitingReason({ workflowOutcome: "failed", activeRunId: 3, activeRunType: "ci_repair" }),
    "PatchRelay is running ci repair",
  );
  assert.equal(
    derivePatchRelayWaitingReason({ workflowOutcome: "escalated", activeRunId: 3 }),
    PATCHRELAY_WAITING_REASONS.activeWork,
  );
});

test("deriveIssueExecutionStateFromRecords maps records onto the same input", () => {
  const issue = {
    delegatedToPatchRelay: true,
    workflowOutcome: undefined,
    activeRunId: 11,
    runnableTaskRunType: undefined,
    orchestrationSettleUntil: undefined,
    prNumber: undefined,
    prState: undefined,
    prHeadSha: undefined,
    prReviewState: undefined,
    prCheckStatus: undefined,
    lastBlockingReviewHeadSha: undefined,
    lastGitHubFailureCheckName: undefined,
  } satisfies Partial<IssueRecord> as IssueRecord;
  const activeRun = { id: 11, runType: "implementation", status: "running" } satisfies Partial<RunRecord> as RunRecord;
  assert.deepEqual(
    deriveIssueExecutionStateFromRecords(issue, { activeRun }),
    { kind: "running", run: { activeRunId: 11, runType: "implementation", phase: "working" } },
  );
  // The same slot pointing at a terminal run is an observable invariant violation.
  const terminalRun = { id: 11, runType: "implementation", status: "failed" } satisfies Partial<RunRecord> as RunRecord;
  assert.equal(deriveIssueExecutionStateFromRecords(issue, { activeRun: terminalRun }).kind, "inconsistent");
});

test("resolveAwaitingInputReason is the union's waiting_input reason", () => {
  assert.equal(resolveAwaitingInputReason({ issue: { inputRequestKind: "paused_local_work" } }), "paused_local_work");
  assert.equal(
    resolveAwaitingInputReason({
      issue: { inputRequestKind: "completion_check_question" },
      latestRun: { completionCheckOutcome: "needs_input" },
    }),
    "completion_check_question",
  );
  assert.equal(resolveAwaitingInputReason({ issue: { workflowOutcome: undefined } }), undefined);
});
