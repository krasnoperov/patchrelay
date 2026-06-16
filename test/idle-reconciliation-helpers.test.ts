import assert from "node:assert/strict";
import test from "node:test";
import {
  buildBranchUpkeepContext,
  buildFailureContext,
  getGateCheckNames,
  hasCompletedReviewQuillVerdict,
  hasFailureProvenance,
  isDuplicateRepairAttempt,
  isFailingCheckStatus,
  isReviewDecisionApproved,
  isReviewDecisionChangesRequested,
  isReviewDecisionReviewRequired,
  type FailureContextIssue,
  type FailureProvenanceIssue,
} from "../src/idle-reconciliation-helpers.ts";
import type { GitHubStatusRollupEntry } from "../src/github-rollup.ts";

test("isFailingCheckStatus recognizes both `failed` and `failure`", () => {
  assert.equal(isFailingCheckStatus("failed"), true);
  assert.equal(isFailingCheckStatus("failure"), true);
  assert.equal(isFailingCheckStatus("success"), false);
  assert.equal(isFailingCheckStatus(undefined), false);
});

test("review-decision predicates accept upper/lower/whitespace variants", () => {
  assert.equal(isReviewDecisionApproved(" approved "), true);
  assert.equal(isReviewDecisionApproved("APPROVED"), true);
  assert.equal(isReviewDecisionApproved("Approved"), true);
  assert.equal(isReviewDecisionApproved("changes_requested"), false);

  assert.equal(isReviewDecisionChangesRequested("changes_requested"), true);
  assert.equal(isReviewDecisionChangesRequested("CHANGES_REQUESTED"), true);
  assert.equal(isReviewDecisionChangesRequested("approved"), false);

  assert.equal(isReviewDecisionReviewRequired("review_required"), true);
  assert.equal(isReviewDecisionReviewRequired("REVIEW_REQUIRED"), true);
  assert.equal(isReviewDecisionReviewRequired("approved"), false);

  for (const fn of [isReviewDecisionApproved, isReviewDecisionChangesRequested, isReviewDecisionReviewRequired]) {
    assert.equal(fn(undefined), false);
    assert.equal(fn(""), false);
  }
});

test("buildBranchUpkeepContext encodes the upkeep directive in the prompt", () => {
  const context = buildBranchUpkeepContext(42, "main", "DIRTY", "abc123");
  assert.equal(context.branchUpkeepRequired, true);
  assert.equal(context.reviewFixMode, "branch_upkeep");
  assert.equal(context.wakeReason, "branch_upkeep");
  assert.equal(context.mergeStateStatus, "DIRTY");
  assert.equal(context.failingHeadSha, "abc123");
  assert.equal(context.baseBranch, "main");
  assert.match(context.promptContext as string, /PR #42/);
  assert.match(context.promptContext as string, /main/);
});

test("buildBranchUpkeepContext omits optional fields when not provided", () => {
  const context = buildBranchUpkeepContext(42, "main");
  assert.equal("mergeStateStatus" in context, false);
  assert.equal("failingHeadSha" in context, false);
  assert.match(context.promptContext as string, /DIRTY against latest main/);
});

test("hasCompletedReviewQuillVerdict checks for the verdict check name and status", () => {
  const verdictDone: GitHubStatusRollupEntry[] = [
    { __typename: "CheckRun", name: "review-quill/verdict", status: "COMPLETED" } as never,
  ];
  const verdictPending: GitHubStatusRollupEntry[] = [
    { __typename: "CheckRun", name: "review-quill/verdict", status: "IN_PROGRESS" } as never,
  ];
  const otherCheck: GitHubStatusRollupEntry[] = [
    { __typename: "CheckRun", name: "verify", status: "COMPLETED" } as never,
  ];

  assert.equal(hasCompletedReviewQuillVerdict(verdictDone), true);
  assert.equal(hasCompletedReviewQuillVerdict(verdictPending), false);
  assert.equal(hasCompletedReviewQuillVerdict(otherCheck), false);
  assert.equal(hasCompletedReviewQuillVerdict(undefined), false);
  assert.equal(hasCompletedReviewQuillVerdict([]), false);
});

test("getGateCheckNames falls back to common gate names and trims configured names", () => {
  assert.deepEqual(getGateCheckNames(undefined), ["Tests", "verify"]);
  assert.deepEqual(getGateCheckNames({ gateChecks: [] } as never), ["Tests", "verify"]);
  assert.deepEqual(getGateCheckNames({ gateChecks: ["  "] } as never), ["Tests", "verify"]);
  assert.deepEqual(getGateCheckNames({ gateChecks: [" verify ", "lint"] } as never), ["verify", "lint"]);
});

function attemptIssue(
  overrides: Partial<Parameters<typeof isDuplicateRepairAttempt>[0]> = {},
): Parameters<typeof isDuplicateRepairAttempt>[0] {
  return {
    lastAttemptedFailureHeadSha: undefined,
    lastAttemptedFailureSignature: undefined,
    lastAttemptedFailureAt: undefined,
    lastGitHubFailureAt: undefined,
    ...overrides,
  };
}

test("isDuplicateRepairAttempt returns false when no signature is provided", () => {
  assert.equal(
    isDuplicateRepairAttempt(attemptIssue({ lastAttemptedFailureSignature: "sig-1" }), {}),
    false,
  );
});

test("isDuplicateRepairAttempt returns true on matching signature and head", () => {
  assert.equal(
    isDuplicateRepairAttempt(
      attemptIssue({
        lastAttemptedFailureSignature: "sig-1",
        lastAttemptedFailureHeadSha: "abc",
      }),
      { failureSignature: "sig-1", failureHeadSha: "abc" },
    ),
    true,
  );
});

test("isDuplicateRepairAttempt falls back to context.headSha when failureHeadSha is missing", () => {
  assert.equal(
    isDuplicateRepairAttempt(
      attemptIssue({
        lastAttemptedFailureSignature: "sig-1",
        lastAttemptedFailureHeadSha: "abc",
      }),
      { failureSignature: "sig-1", headSha: "abc" },
    ),
    true,
  );
});

test("isDuplicateRepairAttempt returns false when a newer failure has been observed", () => {
  assert.equal(
    isDuplicateRepairAttempt(
      attemptIssue({
        lastAttemptedFailureSignature: "sig-1",
        lastAttemptedFailureHeadSha: "abc",
        lastAttemptedFailureAt: "2026-04-01T00:00:00Z",
        lastGitHubFailureAt: "2026-05-01T00:00:00Z",
      }),
      { failureSignature: "sig-1", failureHeadSha: "abc" },
    ),
    false,
  );
});

test("isDuplicateRepairAttempt returns true when timestamps match", () => {
  assert.equal(
    isDuplicateRepairAttempt(
      attemptIssue({
        lastAttemptedFailureSignature: "sig-1",
        lastAttemptedFailureHeadSha: "abc",
        lastAttemptedFailureAt: "2026-05-01T00:00:00Z",
        lastGitHubFailureAt: "2026-05-01T00:00:00Z",
      }),
      { failureSignature: "sig-1", failureHeadSha: "abc" },
    ),
    true,
  );
});

function emptyFailureIssue(): FailureContextIssue {
  return {
    lastGitHubFailureSource: undefined,
    lastGitHubFailureHeadSha: undefined,
    lastGitHubFailureSignature: undefined,
    lastGitHubFailureCheckName: undefined,
    lastGitHubFailureCheckUrl: undefined,
    lastGitHubFailureContextJson: undefined,
    lastQueueIncidentJson: undefined,
  };
}

test("buildFailureContext returns undefined when there is no provenance to fold in", () => {
  assert.equal(buildFailureContext(emptyFailureIssue()), undefined);
});

test("buildFailureContext folds known fields into a structured context object", () => {
  const context = buildFailureContext({
    ...emptyFailureIssue(),
    lastGitHubFailureSource: "queue_eviction",
    lastGitHubFailureHeadSha: "abc",
    lastGitHubFailureSignature: "sig-1",
    lastGitHubFailureCheckName: "merge-steward/queue",
    lastGitHubFailureCheckUrl: "https://example.test/check",
  });
  assert.deepEqual(context, {
    failureReason: "queue_eviction",
    failureHeadSha: "abc",
    failureSignature: "sig-1",
    checkName: "merge-steward/queue",
    checkUrl: "https://example.test/check",
  });
});

function emptyProvenanceIssue(): FailureProvenanceIssue {
  return {
    lastGitHubFailureSource: undefined,
    lastGitHubFailureHeadSha: undefined,
    lastGitHubFailureSignature: undefined,
    lastGitHubFailureCheckName: undefined,
    lastGitHubFailureCheckUrl: undefined,
    lastGitHubFailureContextJson: undefined,
    lastGitHubFailureAt: undefined,
    lastQueueIncidentJson: undefined,
    lastAttemptedFailureHeadSha: undefined,
    lastAttemptedFailureSignature: undefined,
  };
}

test("hasFailureProvenance returns false when every provenance field is empty", () => {
  assert.equal(hasFailureProvenance(emptyProvenanceIssue()), false);
});

test("hasFailureProvenance returns true if any provenance field is populated", () => {
  for (const field of [
    "lastGitHubFailureSource",
    "lastGitHubFailureHeadSha",
    "lastGitHubFailureSignature",
    "lastGitHubFailureCheckName",
    "lastGitHubFailureCheckUrl",
    "lastGitHubFailureContextJson",
    "lastGitHubFailureAt",
    "lastQueueIncidentJson",
    "lastAttemptedFailureHeadSha",
    "lastAttemptedFailureSignature",
  ] as const) {
    const issue = { ...emptyProvenanceIssue(), [field]: "set" };
    assert.equal(
      hasFailureProvenance(issue),
      true,
      `expected true when ${field} is populated`,
    );
  }
});
