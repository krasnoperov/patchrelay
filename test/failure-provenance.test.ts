import assert from "node:assert/strict";
import test from "node:test";
import { mayClearFailureProvenance } from "../src/failure-provenance.ts";

const QUEUE_FAILURE = {
  lastGitHubFailureSource: "queue_eviction",
  lastGitHubFailureHeadSha: "failure-head",
} as const;

const BRANCH_FAILURE = {
  lastGitHubFailureSource: "branch_ci",
  lastGitHubFailureHeadSha: "failure-head",
} as const;

test("mayClearFailureProvenance: a merged or closed PR always supersedes the failure", () => {
  assert.equal(mayClearFailureProvenance(QUEUE_FAILURE, { prState: "merged" }), true);
  assert.equal(mayClearFailureProvenance(QUEUE_FAILURE, { prState: "closed" }), true);
  assert.equal(mayClearFailureProvenance(BRANCH_FAILURE, { prState: "merged" }), true);
});

test("mayClearFailureProvenance: nothing recorded means clearing is harmless", () => {
  assert.equal(
    mayClearFailureProvenance(
      { lastGitHubFailureSource: undefined, lastGitHubFailureHeadSha: undefined },
      {},
    ),
    true,
  );
});

test("mayClearFailureProvenance: a recorded failure with no fresh evidence is preserved", () => {
  assert.equal(mayClearFailureProvenance(QUEUE_FAILURE, {}), false);
  assert.equal(mayClearFailureProvenance(BRANCH_FAILURE, {}), false);
});

test("mayClearFailureProvenance: a current-truth head past the failure head clears it", () => {
  assert.equal(
    mayClearFailureProvenance(QUEUE_FAILURE, { headSha: "newer-head", headIsCurrentTruth: true }),
    true,
  );
});

test("mayClearFailureProvenance: an out-of-order check event for another head proves nothing", () => {
  assert.equal(
    mayClearFailureProvenance(QUEUE_FAILURE, { headSha: "newer-head", gateCheckStatus: "success" }),
    false,
  );
  assert.equal(
    mayClearFailureProvenance(BRANCH_FAILURE, { headSha: "other-head", gateCheckStatus: "success" }),
    false,
  );
});

test("mayClearFailureProvenance: a green branch gate never swallows a queue incident on the same head", () => {
  assert.equal(
    mayClearFailureProvenance(QUEUE_FAILURE, {
      headSha: "failure-head",
      headIsCurrentTruth: true,
      gateCheckStatus: "success",
    }),
    false,
  );
});

test("mayClearFailureProvenance: a successful eviction check on the failure head clears a queue incident", () => {
  assert.equal(
    mayClearFailureProvenance(QUEUE_FAILURE, {
      headSha: "failure-head",
      evictionCheckSucceeded: true,
    }),
    true,
  );
});

test("mayClearFailureProvenance: branch_ci failures clear on a green gate or eviction check on the failure head", () => {
  assert.equal(
    mayClearFailureProvenance(BRANCH_FAILURE, { headSha: "failure-head", gateCheckStatus: "success" }),
    true,
  );
  assert.equal(
    mayClearFailureProvenance(BRANCH_FAILURE, { headSha: "failure-head", evictionCheckSucceeded: true }),
    true,
  );
  assert.equal(
    mayClearFailureProvenance(BRANCH_FAILURE, { headSha: "failure-head", gateCheckStatus: "pending" }),
    false,
  );
});
