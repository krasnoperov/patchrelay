import assert from "node:assert/strict";
import test from "node:test";
import {
  deriveCiGateStatus,
  deriveCiOwner,
  describeCiOwnership,
  getGateCheckNames,
} from "../src/cli/cluster-health/ci-classification.ts";
import type { CiOwnerParams } from "../src/cli/cluster-health/ci-classification.ts";
import type { ReviewQuillAttemptOwnership } from "../src/cli/cluster-health/types.ts";
import type { IssueExecutionState } from "../src/issue-execution-state.ts";

function externalReviewState(): IssueExecutionState {
  return { kind: "idle_awaiting_external", waitingOn: "external_review" };
}

function downstreamState(): IssueExecutionState {
  return { kind: "idle_awaiting_external", waitingOn: "merge_queue" };
}

function followupState(followup: "review_fix" | "ci_repair" | "queue_repair"): IssueExecutionState {
  return { kind: "awaiting_followup", followup };
}

function runningState(): IssueExecutionState {
  return { kind: "running", run: { activeRunId: 42, runType: "ci_repair", phase: "working" } };
}

function baseOwnerParams(overrides: Partial<CiOwnerParams> = {}): CiOwnerParams {
  return {
    delegatedToPatchRelay: true,
    gateCheckStatus: "success",
    executionState: externalReviewState(),
    reviewDecision: undefined,
    reviewRequested: false,
    currentHeadSha: undefined,
    latestBlockingReviewHeadSha: undefined,
    mergeConflictDetected: false,
    reviewQuillAttempt: undefined,
    ...overrides,
  };
}

test("getGateCheckNames falls back to common gate names when none configured", () => {
  assert.deepEqual(getGateCheckNames(undefined), ["Tests", "verify"]);
  assert.deepEqual(getGateCheckNames({ gateChecks: [] } as never), ["Tests", "verify"]);
  assert.deepEqual(getGateCheckNames({ gateChecks: ["  ", ""] } as never), ["Tests", "verify"]);
});

test("getGateCheckNames trims and preserves configured names", () => {
  assert.deepEqual(
    getGateCheckNames({ gateChecks: [" verify ", "lint"] } as never),
    ["verify", "lint"],
  );
});

test("deriveCiGateStatus returns unknown for empty rollup", () => {
  assert.equal(deriveCiGateStatus(undefined, ["verify"]), "unknown");
  assert.equal(deriveCiGateStatus([], ["verify"]), "unknown");
});

test("deriveCiGateStatus reports pending when only non-gate checks are pending", () => {
  const rollup = [{ name: "lint", status: "in_progress" }] as never;
  assert.equal(deriveCiGateStatus(rollup, ["verify"]), "pending");
});

test("deriveCiGateStatus reports success when a configured gate check is COMPLETED+SUCCESS", () => {
  const rollup = [
    { name: "verify", status: "completed", conclusion: "success" },
  ] as never;
  assert.equal(deriveCiGateStatus(rollup, ["verify"]), "success");
});

test("deriveCiGateStatus reports failure when a configured gate check failed", () => {
  const rollup = [
    { name: "verify", status: "completed", conclusion: "failure" },
  ] as never;
  assert.equal(deriveCiGateStatus(rollup, ["verify"]), "failure");
});

test("deriveCiOwner returns patchrelay whenever an active run is attached", () => {
  assert.equal(
    deriveCiOwner(baseOwnerParams({ executionState: runningState(), gateCheckStatus: "failure" })),
    "patchrelay",
  );
});

test("deriveCiOwner returns patchrelay for failed gate CI while repairing_ci", () => {
  assert.equal(
    deriveCiOwner(baseOwnerParams({ gateCheckStatus: "failure", executionState: followupState("ci_repair") })),
    "patchrelay",
  );
});

test("deriveCiOwner returns paused for undelegated failing CI", () => {
  assert.equal(
    deriveCiOwner(baseOwnerParams({ delegatedToPatchRelay: false, gateCheckStatus: "failure" })),
    "paused",
  );
});

test("deriveCiOwner returns unknown for failed gate CI when no repair run is active", () => {
  assert.equal(
    deriveCiOwner(baseOwnerParams({ gateCheckStatus: "failure" })),
    "unknown",
  );
});

test("deriveCiOwner does not hand off approved PRs with failed gate CI downstream", () => {
  assert.equal(
    deriveCiOwner(baseOwnerParams({
      gateCheckStatus: "failure",
      executionState: downstreamState(),
      reviewDecision: "APPROVED",
    })),
    "unknown",
  );
});

test("deriveCiOwner returns external for pending gate CI", () => {
  assert.equal(
    deriveCiOwner(baseOwnerParams({ gateCheckStatus: "pending" })),
    "external",
  );
});

test("deriveCiOwner routes approved PRs to downstream", () => {
  assert.equal(
    deriveCiOwner(baseOwnerParams({ reviewDecision: "APPROVED" })),
    "downstream",
  );
});

test("deriveCiOwner returns paused when an approved PR has merge conflicts and is undelegated", () => {
  assert.equal(
    deriveCiOwner(baseOwnerParams({
      delegatedToPatchRelay: false,
      reviewDecision: "APPROVED",
      mergeConflictDetected: true,
    })),
    "paused",
  );
});

test("deriveCiOwner returns unknown when an approved PR has merge conflicts and no repair queued", () => {
  assert.equal(
    deriveCiOwner(baseOwnerParams({
      reviewDecision: "APPROVED",
      mergeConflictDetected: true,
      executionState: downstreamState(),
    })),
    "unknown",
  );
});

test("deriveCiOwner returns downstream when a queue conflict has a repair owner", () => {
  assert.equal(
    deriveCiOwner(baseOwnerParams({
      reviewDecision: "APPROVED",
      mergeConflictDetected: true,
      executionState: followupState("queue_repair"),
    })),
    "downstream",
  );
});

test("deriveCiOwner returns patchrelay when changes_requested run is active on a dirty PR", () => {
  assert.equal(
    deriveCiOwner(baseOwnerParams({
      reviewDecision: "CHANGES_REQUESTED",
      mergeConflictDetected: true,
      executionState: followupState("review_fix"),
    })),
    "patchrelay",
  );
});

test("deriveCiOwner returns review-quill when an attempt is active on the current head", () => {
  const reviewQuillAttempt: ReviewQuillAttemptOwnership = {
    id: 7,
    status: "running",
    headSha: "abc",
  };
  assert.equal(
    deriveCiOwner(baseOwnerParams({
      reviewDecision: "CHANGES_REQUESTED",
      reviewQuillAttempt,
      currentHeadSha: "abc",
    })),
    "review-quill",
  );
});

test("deriveCiOwner returns review-quill when the repo backlog targets a stale head", () => {
  const reviewQuillAttempt: ReviewQuillAttemptOwnership = {
    backlog: true,
    headSha: "old",
  };
  assert.equal(
    deriveCiOwner(baseOwnerParams({
      reviewDecision: "CHANGES_REQUESTED",
      currentHeadSha: "new",
      reviewQuillAttempt,
    })),
    "review-quill",
  );
});

test("deriveCiOwner returns reviewer when a newer head has advanced past the blocking review", () => {
  assert.equal(
    deriveCiOwner(baseOwnerParams({
      reviewDecision: "CHANGES_REQUESTED",
      currentHeadSha: "new",
      latestBlockingReviewHeadSha: "old",
    })),
    "reviewer",
  );
});

test("deriveCiOwner returns unknown for changes_requested with no head advance and no attempt", () => {
  assert.equal(
    deriveCiOwner(baseOwnerParams({
      reviewDecision: "CHANGES_REQUESTED",
      currentHeadSha: "same",
      latestBlockingReviewHeadSha: "same",
    })),
    "unknown",
  );
});

test("deriveCiOwner returns review-quill when a quill attempt targets a REVIEW_REQUIRED PR", () => {
  assert.equal(
    deriveCiOwner(baseOwnerParams({
      reviewDecision: "REVIEW_REQUIRED",
      reviewQuillAttempt: { id: 1, status: "queued" },
    })),
    "review-quill",
  );
});

test("deriveCiOwner returns reviewer when REVIEW_REQUIRED with green CI", () => {
  assert.equal(
    deriveCiOwner(baseOwnerParams({
      reviewDecision: "REVIEW_REQUIRED",
      gateCheckStatus: "success",
    })),
    "reviewer",
  );
});

test("deriveCiOwner returns reviewer when CI green on pr_open without an explicit decision", () => {
  assert.equal(
    deriveCiOwner(baseOwnerParams({ gateCheckStatus: "success" })),
    "reviewer",
  );
});

test("describeCiOwnership branches by owner", () => {
  const base = {
    delegatedToPatchRelay: true,
    gateCheckStatus: "success" as const,
    reviewDecision: undefined,
    reviewRequested: false,
    currentHeadSha: undefined,
    latestBlockingReviewHeadSha: undefined,
    mergeConflictDetected: false,
    reviewQuillAttempt: undefined,
  };

  assert.equal(
    describeCiOwnership({ ...base, owner: "patchrelay", gateCheckStatus: "failure" }),
    "PatchRelay owns the next CI repair move",
  );
  assert.equal(
    describeCiOwnership({ ...base, owner: "patchrelay", mergeConflictDetected: true }),
    "PatchRelay owns the next branch-upkeep move",
  );
  assert.equal(
    describeCiOwnership({
      ...base,
      owner: "review-quill",
      reviewQuillAttempt: { id: 9, status: "running" },
    }),
    "review-quill attempt #9 is running on the current head",
  );
  assert.equal(
    describeCiOwnership({
      ...base,
      owner: "review-quill",
      reviewQuillAttempt: { backlog: true },
    }),
    "review-quill is actively reconciling this repo; this PR is waiting in the current review backlog",
  );
  assert.equal(
    describeCiOwnership({
      ...base,
      owner: "reviewer",
      currentHeadSha: "new",
      latestBlockingReviewHeadSha: "old",
    }),
    "Waiting on review of a newer pushed head",
  );
  assert.equal(
    describeCiOwnership({ ...base, owner: "reviewer", reviewRequested: true }),
    "Waiting on an active reviewer request",
  );
  assert.equal(
    describeCiOwnership({ ...base, owner: "downstream" }),
    "Downstream merge automation owns the next move",
  );
  assert.equal(
    describeCiOwnership({ ...base, owner: "downstream", mergeConflictDetected: true }),
    "Downstream merge automation is expected to repair or requeue this PR",
  );
  assert.equal(
    describeCiOwnership({ ...base, owner: "external", gateCheckStatus: "pending" }),
    "Waiting on external CI checks to settle",
  );
  assert.equal(
    describeCiOwnership({ ...base, owner: "paused", gateCheckStatus: "failure" }),
    "PatchRelay is paused; delegate the issue again to repair failing CI",
  );
  assert.equal(
    describeCiOwnership({ ...base, owner: "paused", reviewDecision: "CHANGES_REQUESTED" }),
    "PatchRelay is paused; delegate the issue again to address requested changes",
  );
  assert.equal(
    describeCiOwnership({ ...base, owner: "unknown" }),
    "No visible next owner for this PR state",
  );
});
