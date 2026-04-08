import assert from "node:assert/strict";
import test from "node:test";
import { derivePatchRelayWaitingReason, PATCHRELAY_WAITING_REASONS } from "../src/waiting-reason.ts";

test("changes requested with green checks on the same head stays blocked", () => {
  const waitingReason = derivePatchRelayWaitingReason({
    factoryState: "pr_open",
    prNumber: 12,
    prHeadSha: "sha-1",
    prReviewState: "changes_requested",
    prCheckStatus: "success",
    lastBlockingReviewHeadSha: "sha-1",
  });

  assert.equal(waitingReason, PATCHRELAY_WAITING_REASONS.sameHeadStillBlocked);
});

test("changes requested with green checks on a newer head waits for review", () => {
  const waitingReason = derivePatchRelayWaitingReason({
    factoryState: "pr_open",
    prNumber: 12,
    prHeadSha: "sha-2",
    prReviewState: "changes_requested",
    prCheckStatus: "success",
    lastBlockingReviewHeadSha: "sha-1",
  });

  assert.equal(waitingReason, PATCHRELAY_WAITING_REASONS.waitingForReviewOnNewHead);
});

test("changes requested without green checks still waits for review feedback", () => {
  const waitingReason = derivePatchRelayWaitingReason({
    factoryState: "pr_open",
    prNumber: 12,
    prReviewState: "changes_requested",
    prCheckStatus: "pending",
  });

  assert.equal(waitingReason, PATCHRELAY_WAITING_REASONS.waitingForReviewFeedback);
});
