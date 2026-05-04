import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveFactoryStateFromGitHub,
  type FactoryState,
  type TransitionContext,
} from "../src/factory-state.ts";
import type { GitHubTriggerEvent } from "../src/github-types.ts";

/**
 * Tests for the merge queue integration contract:
 * 1. Factory state transitions that lead to awaiting_queue (where downstream queue automation takes over)
 * 2. Factory state transitions on check_failed while awaiting_queue (CI repair fallback)
 * 3. External queue eviction is handled by the GitHub webhook handler, not here
 */

function resolve(event: GitHubTriggerEvent, current: FactoryState, ctx?: TransitionContext): FactoryState | undefined {
  return resolveFactoryStateFromGitHub(event, current, ctx);
}

// --- Paths to awaiting_queue (where downstream queue automation takes over) ---

test("review_approved from pr_open transitions to awaiting_queue", () => {
  assert.equal(resolve("review_approved", "pr_open"), "awaiting_queue");
});

test("review_approved from repairing_ci transitions to awaiting_queue", () => {
  assert.equal(resolve("review_approved", "repairing_ci"), "awaiting_queue");
});

test("check_passed from repairing_queue transitions to awaiting_queue", () => {
  assert.equal(resolve("check_passed", "repairing_queue"), "awaiting_queue");
});

test("check_passed from repairing_ci with approval transitions to awaiting_queue", () => {
  assert.equal(
    resolve("check_passed", "repairing_ci", { prReviewState: "approved" }),
    "awaiting_queue",
  );
});

test("check_passed from repairing_ci without approval transitions to pr_open", () => {
  assert.equal(
    resolve("check_passed", "repairing_ci"),
    "pr_open",
  );
});

test("check_failed from awaiting_queue without classification is metadata-only (plan §4.3)", () => {
  // While In Deploy, branch CI failures don't trigger ci_repair — the
  // lander's spec CI on the integration tree is the gate.
  assert.equal(resolve("check_failed", "awaiting_queue"), undefined);
});

test("check_failed classified as queue_eviction from awaiting_queue routes to repairing_queue", () => {
  assert.equal(
    resolve("check_failed", "awaiting_queue", { failureSource: "queue_eviction" }),
    "repairing_queue",
  );
});

test("check_failed classified as branch_ci from awaiting_queue is metadata-only", () => {
  assert.equal(
    resolve("check_failed", "awaiting_queue", { failureSource: "branch_ci" }),
    undefined,
  );
});

test("check_failed classified as branch_ci from pr_open still routes to repairing_ci", () => {
  assert.equal(
    resolve("check_failed", "pr_open", { failureSource: "branch_ci" }),
    "repairing_ci",
  );
});

test("check_passed from repairing_queue returns to awaiting_queue", () => {
  assert.equal(resolve("check_passed", "repairing_queue"), "awaiting_queue");
});

test("merge_group events are no-ops (external queue handles merging)", () => {
  assert.equal(resolve("merge_group_failed", "awaiting_queue"), undefined);
  assert.equal(resolve("merge_group_passed", "awaiting_queue"), undefined);
});

test("full cycle: awaiting_queue → queue eviction → repairing_queue → awaiting_queue → done", () => {
  // Plan §4.3 changed this cycle: branch CI failures while In Deploy
  // are metadata; only the lander's eviction signal returns the issue
  // to a repair state.
  let state: FactoryState = "awaiting_queue";

  const afterEvict = resolve("check_failed", state, { failureSource: "queue_eviction" });
  assert.equal(afterEvict, "repairing_queue");
  state = afterEvict!;

  // After queue repair, the issue returns to the queue.
  const afterRepairPass = resolve("check_passed", state);
  assert.equal(afterRepairPass, "awaiting_queue");
  state = afterRepairPass!;

  // External queue merges → done.
  const afterMerge = resolve("pr_merged", state);
  assert.equal(afterMerge, "done");
});

// --- No merge-prep remnants ---

test("awaiting_queue does not require pendingMergePrep (removed)", () => {
  const result = resolve("review_approved", "pr_open");
  assert.equal(result, "awaiting_queue");
});
