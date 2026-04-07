import assert from "node:assert/strict";
import test from "node:test";
import { derivePatchRelayWaitingReason, PATCHRELAY_WAITING_REASONS } from "../src/waiting-reason.ts";

test("changes requested with green checks waits for re-review", () => {
  const waitingReason = derivePatchRelayWaitingReason({
    factoryState: "pr_open",
    prNumber: 12,
    prReviewState: "changes_requested",
    prCheckStatus: "success",
  });

  assert.equal(waitingReason, PATCHRELAY_WAITING_REASONS.waitingForRereview);
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
