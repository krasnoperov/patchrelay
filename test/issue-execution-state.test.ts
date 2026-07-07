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

// The pre-D3 derivation, kept verbatim so the table below proves the
// union-based waitingReason is equivalent to what shipped before.
function legacyWaitingReason(params: IssueExecutionStateInput): string | undefined {
  const hasOpenPr = (prNumber?: number, prState?: string) => prNumber !== undefined && (prState === undefined || prState === "open");
  const humanize = (value: string) => value.replaceAll("_", " ");
  if (params.delegatedToPatchRelay === false && params.factoryState !== "done" && params.factoryState !== "failed" && params.factoryState !== "escalated") {
    return params.factoryState === "awaiting_queue" || (hasOpenPr(params.prNumber, params.prState) && params.prReviewState === "approved")
      ? PATCHRELAY_WAITING_REASONS.automationPausedDownstream
      : PATCHRELAY_WAITING_REASONS.automationPaused;
  }
  if (params.activeRunType) {
    if (hasOpenPr(params.prNumber, params.prState) && (params.factoryState === "pr_open" || params.factoryState === "awaiting_queue")) {
      return PATCHRELAY_WAITING_REASONS.finalizingPublishedPr;
    }
    if (params.factoryState === "done") {
      return PATCHRELAY_WAITING_REASONS.finalizingMergedChange;
    }
    return `PatchRelay is running ${humanize(params.activeRunType)}`;
  }
  if (params.activeRunId !== undefined) {
    return PATCHRELAY_WAITING_REASONS.activeWork;
  }
  if (params.orchestrationSettleUntil) {
    const settleAt = Date.parse(params.orchestrationSettleUntil);
    if (Number.isFinite(settleAt) && settleAt > Date.now()) {
      return PATCHRELAY_WAITING_REASONS.waitingForChildSettle;
    }
  }
  const blockedByKeys = (params.blockedByKeys ?? []).filter((value) => value.trim().length > 0);
  if (blockedByKeys.length > 0) {
    return `Blocked by ${blockedByKeys.join(", ")}`;
  }
  const checkName = params.latestFailureCheckName ?? "CI";
  switch (params.factoryState) {
    case "awaiting_input": return PATCHRELAY_WAITING_REASONS.waitingForOperatorInput;
    case "changes_requested": return PATCHRELAY_WAITING_REASONS.waitingForReviewFeedback;
    case "repairing_ci": return `Waiting to repair ${checkName}`;
    case "repairing_queue": return PATCHRELAY_WAITING_REASONS.waitingForMergeStewardRepair;
    case "awaiting_queue": return PATCHRELAY_WAITING_REASONS.waitingForDownstreamAutomation;
    case "done": return PATCHRELAY_WAITING_REASONS.workComplete;
    case "failed":
    case "escalated": return PATCHRELAY_WAITING_REASONS.waitingForOperatorIntervention;
    default: break;
  }
  if (params.prCheckStatus === "failed" || params.prCheckStatus === "failure") {
    return `${checkName} failed`;
  }
  if (params.prReviewState === "changes_requested") {
    if (params.prCheckStatus === "passed" || params.prCheckStatus === "success") {
      if (params.prHeadSha && params.lastBlockingReviewHeadSha && params.prHeadSha !== params.lastBlockingReviewHeadSha) {
        return PATCHRELAY_WAITING_REASONS.waitingForReviewOnNewHead;
      }
      return PATCHRELAY_WAITING_REASONS.sameHeadStillBlocked;
    }
    return PATCHRELAY_WAITING_REASONS.waitingForReviewFeedback;
  }
  if (params.prReviewState === "approved") {
    return PATCHRELAY_WAITING_REASONS.waitingForDownstreamAutomation;
  }
  if (hasOpenPr(params.prNumber, params.prState)) {
    return PATCHRELAY_WAITING_REASONS.waitingForExternalReview;
  }
  if (params.runnableTaskRunType) {
    return `Ready to run ${humanize(params.runnableTaskRunType)}`;
  }
  return undefined;
}

interface Row {
  name: string;
  input: IssueExecutionStateInput;
  expected: IssueExecutionState;
}

const FUTURE = new Date(Date.now() + 60 * 60_000).toISOString();

const TABLE: Row[] = [
  {
    name: "undelegated mid-implementation",
    input: { delegatedToPatchRelay: false, factoryState: "implementing" },
    expected: { kind: "undelegated", downstreamMayContinue: false },
  },
  {
    name: "undelegated in the merge queue (downstream continues)",
    input: { delegatedToPatchRelay: false, factoryState: "awaiting_queue", prNumber: 5, prState: "open" },
    expected: { kind: "undelegated", downstreamMayContinue: true },
  },
  {
    name: "undelegated approved open PR (downstream continues)",
    input: { delegatedToPatchRelay: false, factoryState: "pr_open", prNumber: 5, prState: "open", prReviewState: "approved" },
    expected: { kind: "undelegated", downstreamMayContinue: true },
  },
  {
    name: "undelegated but already done stays terminal",
    input: { delegatedToPatchRelay: false, factoryState: "done" },
    expected: { kind: "terminal", outcome: "done" },
  },
  {
    name: "undelegation outranks an active run",
    input: { delegatedToPatchRelay: false, factoryState: "implementing", activeRunId: 4, activeRunType: "implementation" },
    expected: { kind: "undelegated", downstreamMayContinue: false },
  },
  {
    name: "plain active run",
    input: { factoryState: "implementing", activeRunId: 7, activeRunType: "implementation" },
    expected: { kind: "running", run: { activeRunId: 7, runType: "implementation", phase: "working" } },
  },
  {
    name: "active run known only by slot id",
    input: { factoryState: "implementing", activeRunId: 7 },
    expected: { kind: "running", run: { activeRunId: 7, phase: "working" } },
  },
  {
    name: "run finalizing a published PR",
    input: { factoryState: "pr_open", activeRunId: 7, activeRunType: "implementation", prNumber: 12, prState: "open" },
    expected: { kind: "running", run: { activeRunId: 7, runType: "implementation", phase: "finalizing_published_pr" } },
  },
  {
    name: "run finalizing a merged change",
    input: { factoryState: "done", activeRunId: 7, activeRunType: "review_fix", prNumber: 12, prState: "merged" },
    expected: { kind: "running", run: { activeRunId: 7, runType: "review_fix", phase: "finalizing_merged_change" } },
  },
  {
    name: "reply run while awaiting_input is legitimate",
    input: { factoryState: "awaiting_input", activeRunId: 9, activeRunType: "implementation" },
    expected: { kind: "running", run: { activeRunId: 9, runType: "implementation", phase: "working" } },
  },
  {
    name: "invariant violation: failed factoryState with occupied run slot",
    input: { factoryState: "failed", activeRunId: 3, activeRunType: "ci_repair" },
    expected: {
      kind: "inconsistent",
      description: 'terminal factoryState "failed" still holds an active run slot',
      run: { activeRunId: 3, runType: "ci_repair", phase: "working" },
    },
  },
  {
    name: "invariant violation: escalated factoryState with occupied run slot",
    input: { factoryState: "escalated", activeRunId: 3 },
    expected: {
      kind: "inconsistent",
      description: 'terminal factoryState "escalated" still holds an active run slot',
      run: { activeRunId: 3, phase: "working" },
    },
  },
  {
    name: "invariant violation: slot points at a terminal run (USE-364 shape)",
    input: { factoryState: "implementing", activeRunId: 3, activeRunType: "implementation", activeRunStatus: "completed" },
    expected: {
      kind: "inconsistent",
      description: "active run slot points at a completed run",
      run: { activeRunId: 3, runType: "implementation", phase: "working" },
    },
  },
  {
    name: "orchestration settle window",
    input: { factoryState: "delegated", orchestrationSettleUntil: FUTURE },
    expected: { kind: "settling", settleUntil: FUTURE },
  },
  {
    name: "expired settle window falls through",
    input: { factoryState: "delegated", orchestrationSettleUntil: "2020-01-01T00:00:00.000Z", runnableTaskRunType: "implementation" },
    expected: { kind: "ready", runnableTaskRunType: "implementation" },
  },
  {
    name: "blocked by dependencies",
    input: { factoryState: "delegated", blockedByKeys: ["USE-1", " ", "USE-2"] },
    expected: { kind: "blocked", blockedByKeys: ["USE-1", "USE-2"] },
  },
  {
    name: "awaiting input: paused local work",
    input: { factoryState: "awaiting_input" },
    expected: { kind: "waiting_input", reason: "paused_local_work" },
  },
  {
    name: "awaiting input: completion check question",
    input: { factoryState: "awaiting_input", latestRunCompletionCheckOutcome: "needs_input" },
    expected: { kind: "waiting_input", reason: "completion_check_question" },
  },
  {
    name: "changes requested without a run owes a review_fix",
    input: { factoryState: "changes_requested" },
    expected: { kind: "awaiting_followup", followup: "review_fix" },
  },
  {
    name: "repairing_ci without a run owes a ci_repair",
    input: { factoryState: "repairing_ci", latestFailureCheckName: "spec/integration" },
    expected: { kind: "awaiting_followup", followup: "ci_repair", checkName: "spec/integration" },
  },
  {
    name: "repairing_queue without a run owes a queue_repair",
    input: { factoryState: "repairing_queue" },
    expected: { kind: "awaiting_followup", followup: "queue_repair" },
  },
  {
    name: "awaiting_queue waits on the merge queue",
    input: { factoryState: "awaiting_queue", prNumber: 8, prState: "open", prReviewState: "approved" },
    expected: { kind: "idle_awaiting_external", waitingOn: "merge_queue" },
  },
  { name: "done", input: { factoryState: "done" }, expected: { kind: "terminal", outcome: "done" } },
  { name: "failed", input: { factoryState: "failed" }, expected: { kind: "terminal", outcome: "failed" } },
  { name: "escalated", input: { factoryState: "escalated" }, expected: { kind: "terminal", outcome: "escalated" } },
  {
    name: "settled red CI on an open PR",
    input: { factoryState: "pr_open", prNumber: 8, prState: "open", prCheckStatus: "failed", latestFailureCheckName: "build" },
    expected: { kind: "idle_awaiting_external", waitingOn: "ci_failure", checkName: "build" },
  },
  {
    name: "blocking review with green checks on a newer head",
    input: { factoryState: "pr_open", prNumber: 8, prHeadSha: "sha-2", prReviewState: "changes_requested", prCheckStatus: "success", lastBlockingReviewHeadSha: "sha-1" },
    expected: { kind: "idle_awaiting_external", waitingOn: "review_of_new_head" },
  },
  {
    name: "blocking review with green checks on the same head",
    input: { factoryState: "pr_open", prNumber: 8, prHeadSha: "sha-1", prReviewState: "changes_requested", prCheckStatus: "success", lastBlockingReviewHeadSha: "sha-1" },
    expected: { kind: "idle_awaiting_external", waitingOn: "blocking_review_same_head" },
  },
  {
    name: "blocking review with pending checks",
    input: { factoryState: "pr_open", prNumber: 8, prReviewState: "changes_requested", prCheckStatus: "pending" },
    expected: { kind: "idle_awaiting_external", waitingOn: "review_feedback" },
  },
  {
    name: "approved PR waits on downstream automation",
    input: { factoryState: "pr_open", prNumber: 8, prState: "open", prReviewState: "approved" },
    expected: { kind: "idle_awaiting_external", waitingOn: "downstream_automation" },
  },
  {
    name: "open PR with no signals waits on external review",
    input: { factoryState: "pr_open", prNumber: 8, prState: "open" },
    expected: { kind: "idle_awaiting_external", waitingOn: "external_review" },
  },
  {
    name: "runnable workflow task is ready",
    input: { factoryState: "delegated", runnableTaskRunType: "queue_repair" },
    expected: { kind: "ready", runnableTaskRunType: "queue_repair" },
  },
  {
    name: "nothing pending at all",
    input: { factoryState: "delegated" },
    expected: { kind: "idle" },
  },
];

test("deriveIssueExecutionState classifies representative issue shapes", () => {
  for (const row of TABLE) {
    assert.deepEqual(deriveIssueExecutionState(row.input), row.expected, row.name);
  }
});

test("waitingReason derived through the union matches the pre-D3 derivation for every table row", () => {
  for (const row of TABLE) {
    assert.equal(
      derivePatchRelayWaitingReason(row.input),
      legacyWaitingReason(row.input),
      row.name,
    );
  }
});

test("inconsistent rows still render the observable run for operators", () => {
  assert.equal(
    derivePatchRelayWaitingReason({ factoryState: "failed", activeRunId: 3, activeRunType: "ci_repair" }),
    "PatchRelay is running ci repair",
  );
  assert.equal(
    derivePatchRelayWaitingReason({ factoryState: "escalated", activeRunId: 3 }),
    PATCHRELAY_WAITING_REASONS.activeWork,
  );
});

test("deriveIssueExecutionStateFromRecords maps records onto the same input", () => {
  const issue = {
    delegatedToPatchRelay: true,
    factoryState: "implementing",
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
  assert.equal(resolveAwaitingInputReason({ issue: { factoryState: "awaiting_input" } }), "paused_local_work");
  assert.equal(
    resolveAwaitingInputReason({
      issue: { factoryState: "awaiting_input" },
      latestRun: { completionCheckOutcome: "needs_input" },
    }),
    "completion_check_question",
  );
  assert.equal(resolveAwaitingInputReason({ issue: { factoryState: "implementing" } }), undefined);
});
