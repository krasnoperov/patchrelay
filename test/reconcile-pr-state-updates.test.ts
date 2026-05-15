import assert from "node:assert/strict";
import test from "node:test";
import { buildPrStateUpdates } from "../src/reconcile-pr-state-updates.ts";
import type { ReconcilePullRequestSnapshot } from "../src/reconcile-pr-fetch.ts";

const FIXED_NOW = () => new Date("2026-05-15T10:00:00.000Z");

test("buildPrStateUpdates copies the headRefOid when present", () => {
  const pr: ReconcilePullRequestSnapshot = { headRefOid: "abc" };
  const updates = buildPrStateUpdates(pr, undefined, "verify", FIXED_NOW);
  assert.equal(updates.prHeadSha, "abc");
});

test("buildPrStateUpdates only marks prState=open when the PR is OPEN", () => {
  for (const state of ["OPEN", "CLOSED", "MERGED", undefined]) {
    const updates = buildPrStateUpdates({ state }, undefined, "verify", FIXED_NOW);
    assert.equal(updates.prState, state === "OPEN" ? "open" : undefined);
  }
});

test("buildPrStateUpdates maps review decision to prReviewState", () => {
  assert.equal(
    buildPrStateUpdates({ reviewDecision: "APPROVED" }, undefined, "verify", FIXED_NOW).prReviewState,
    "approved",
  );
  assert.equal(
    buildPrStateUpdates({ reviewDecision: "CHANGES_REQUESTED" }, undefined, "verify", FIXED_NOW).prReviewState,
    "changes_requested",
  );
  assert.equal(
    buildPrStateUpdates({ reviewDecision: "REVIEW_REQUIRED" }, undefined, "verify", FIXED_NOW).prReviewState,
    "commented",
  );
  assert.equal(
    buildPrStateUpdates({ reviewDecision: "COMMENTED" }, undefined, "verify", FIXED_NOW).prReviewState,
    undefined,
    "unrecognized decisions don't set prReviewState",
  );
});

test("buildPrStateUpdates accepts mixed-case + whitespace review decisions", () => {
  assert.equal(
    buildPrStateUpdates({ reviewDecision: " approved " }, undefined, "verify", FIXED_NOW).prReviewState,
    "approved",
  );
});

test("buildPrStateUpdates emits a CI snapshot only when both head sha and gate status are observable", () => {
  const both = buildPrStateUpdates(
    { headRefOid: "abc" },
    "success",
    "verify",
    FIXED_NOW,
  );
  assert.equal(both.lastGitHubCiSnapshotHeadSha, "abc");
  assert.equal(both.lastGitHubCiSnapshotGateCheckName, "verify");
  assert.equal(both.lastGitHubCiSnapshotGateCheckStatus, "success");
  assert.equal(both.lastGitHubCiSnapshotSettledAt, "2026-05-15T10:00:00.000Z");

  const noStatus = buildPrStateUpdates({ headRefOid: "abc" }, undefined, "verify", FIXED_NOW);
  assert.equal(noStatus.lastGitHubCiSnapshotHeadSha, undefined);

  const noHead = buildPrStateUpdates({}, "success", "verify", FIXED_NOW);
  assert.equal(noHead.lastGitHubCiSnapshotHeadSha, undefined);
});

test("buildPrStateUpdates leaves settledAt null for pending gate checks", () => {
  const updates = buildPrStateUpdates({ headRefOid: "abc" }, "pending", "verify", FIXED_NOW);
  assert.equal(updates.lastGitHubCiSnapshotSettledAt, null);
  assert.equal(updates.lastGitHubCiSnapshotGateCheckStatus, "pending");
});
