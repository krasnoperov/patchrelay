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

test("check_failed from awaiting_queue still resolves to repairing_ci in the FSM", () => {
  assert.equal(resolve("check_failed", "awaiting_queue"), "repairing_ci");
});

test("check_passed from repairing_queue returns to awaiting_queue", () => {
  assert.equal(resolve("check_passed", "repairing_queue"), "awaiting_queue");
});

test("merge_group events are no-ops (external queue handles merging)", () => {
  assert.equal(resolve("merge_group_failed", "awaiting_queue"), undefined);
  assert.equal(resolve("merge_group_passed", "awaiting_queue"), undefined);
});

test("full cycle: awaiting_queue → CI repair → awaiting_queue → done", () => {
  let state: FactoryState = "awaiting_queue";

  const afterFail = resolve("check_failed", state);
  assert.equal(afterFail, "repairing_ci");
  state = afterFail!;

  // Agent fixes, CI passes. Since PR is approved → awaiting_queue.
  const afterPass = resolve("check_passed", state, { prReviewState: "approved" });
  assert.equal(afterPass, "awaiting_queue");
  state = afterPass!;

  // External queue merges → done.
  const afterMerge = resolve("pr_merged", state);
  assert.equal(afterMerge, "done");
});

// --- No merge-prep remnants ---

test("awaiting_queue does not require pendingMergePrep (removed)", () => {
  const result = resolve("review_approved", "pr_open");
  assert.equal(result, "awaiting_queue");
});
