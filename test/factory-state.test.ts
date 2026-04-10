import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveFactoryStateFromGitHub,
  deriveAllowedTransitions,
  ACTIVE_RUN_STATES,
  TERMINAL_STATES,
  type FactoryState,
  type TransitionContext,
} from "../src/factory-state.ts";
import type { GitHubTriggerEvent } from "../src/github-types.ts";

// ─── Helpers ──────────────────────────────────────────────────────

const ALL_STATES: FactoryState[] = [
  "delegated", "implementing", "pr_open",
  "changes_requested", "repairing_ci", "awaiting_queue", "repairing_queue",
  "awaiting_input", "escalated", "done", "failed",
];

const ALL_EVENTS: GitHubTriggerEvent[] = [
  "pr_opened", "pr_synchronize", "pr_closed", "pr_merged",
  "review_approved", "review_changes_requested", "review_commented",
  "check_passed", "check_failed",
  "merge_group_passed", "merge_group_failed",
];

function resolve(event: GitHubTriggerEvent, current: FactoryState, ctx?: TransitionContext): FactoryState | undefined {
  return resolveFactoryStateFromGitHub(event, current, ctx);
}

// ─── Happy path: implementation → merge ───────────────────────────

test("happy path: implementing → pr_open → awaiting_queue → done", () => {
  assert.equal(resolve("pr_opened", "implementing"), "pr_open");
  assert.equal(resolve("review_approved", "pr_open"), "awaiting_queue");
  assert.equal(resolve("pr_merged", "awaiting_queue"), "done");
});

// ─── Review events apply to ALL open non-running states ──────────

test("review_approved transitions any open non-running state to awaiting_queue", () => {
  const openNonRunning = ALL_STATES.filter((s) => !ACTIVE_RUN_STATES.has(s) && !TERMINAL_STATES.has(s));
  for (const state of openNonRunning) {
    assert.equal(resolve("review_approved", state), "awaiting_queue", `review_approved from ${state}`);
  }
});

test("review_approved is ignored when a run is active", () => {
  for (const state of ALL_STATES.filter((s) => !TERMINAL_STATES.has(s))) {
    assert.equal(resolve("review_approved", state, { activeRunId: 42 }), undefined, `review_approved from ${state} with active run`);
  }
});

test("review_approved is ignored in terminal states", () => {
  for (const state of TERMINAL_STATES) {
    assert.equal(resolve("review_approved", state), undefined, `review_approved from ${state}`);
  }
});

test("review_changes_requested transitions any open non-running state to changes_requested", () => {
  const openNonRunning = ALL_STATES.filter((s) => !ACTIVE_RUN_STATES.has(s) && !TERMINAL_STATES.has(s));
  for (const state of openNonRunning) {
    assert.equal(resolve("review_changes_requested", state), "changes_requested", `review_changes_requested from ${state}`);
  }
});

test("review_changes_requested is ignored when a run is active", () => {
  for (const state of ALL_STATES.filter((s) => !TERMINAL_STATES.has(s))) {
    assert.equal(resolve("review_changes_requested", state, { activeRunId: 42 }), undefined, `review_changes_requested from ${state} with active run`);
  }
});

test("review_commented never changes state", () => {
  for (const state of ALL_STATES) {
    assert.equal(resolve("review_commented", state), undefined, `review_commented from ${state}`);
  }
});

// ─── CI check events ─────────────────────────────────────────────

test("check_failed transitions any open non-running state to repairing_ci", () => {
  const openNonRunning = ALL_STATES.filter((s) => !ACTIVE_RUN_STATES.has(s) && !TERMINAL_STATES.has(s));
  for (const state of openNonRunning) {
    assert.equal(resolve("check_failed", state), "repairing_ci", `check_failed from ${state}`);
  }
});

test("check_failed is ignored when a run is active", () => {
  for (const state of ALL_STATES.filter((s) => !TERMINAL_STATES.has(s))) {
    assert.equal(resolve("check_failed", state, { activeRunId: 42 }), undefined, `check_failed from ${state} with active run`);
  }
});

test("check_passed after queue repair → awaiting_queue", () => {
  assert.equal(resolve("check_passed", "repairing_queue"), "awaiting_queue");
});

test("check_passed after ci_repair with approved PR → awaiting_queue", () => {
  assert.equal(resolve("check_passed", "repairing_ci", { prReviewState: "approved" }), "awaiting_queue");
});

test("check_passed after ci_repair without approval → pr_open", () => {
  assert.equal(resolve("check_passed", "repairing_ci"), "pr_open");
  assert.equal(resolve("check_passed", "repairing_ci", { prReviewState: "changes_requested" }), "pr_open");
});

test("check_passed in non-repair states is no-op", () => {
  const nonRepair = ALL_STATES.filter((s) => s !== "repairing_ci" && s !== "repairing_queue");
  for (const state of nonRepair) {
    assert.equal(resolve("check_passed", state), undefined, `check_passed from ${state}`);
  }
});

// ─── PR lifecycle ────────────────────────────────────────────────

test("pr_opened only transitions from implementing", () => {
  assert.equal(resolve("pr_opened", "implementing"), "pr_open");
  for (const state of ALL_STATES.filter((s) => s !== "implementing")) {
    assert.equal(resolve("pr_opened", state), undefined, `pr_opened from ${state}`);
  }
});

test("pr_merged from any state → done", () => {
  for (const state of ALL_STATES) {
    assert.equal(resolve("pr_merged", state), "done", `pr_merged from ${state}`);
  }
});

test("pr_closed without active run fails only non-terminal states", () => {
  for (const state of ALL_STATES.filter((value) => !TERMINAL_STATES.has(value))) {
    assert.equal(resolve("pr_closed", state, {}), "failed", `pr_closed from ${state}`);
  }
  for (const state of TERMINAL_STATES) {
    assert.equal(resolve("pr_closed", state, {}), undefined, `pr_closed from terminal ${state}`);
  }
});

test("pr_closed during active run is suppressed", () => {
  for (const state of ALL_STATES) {
    assert.equal(resolve("pr_closed", state, { activeRunId: 42 }), undefined, `pr_closed from ${state} with active run`);
  }
});

test("pr_synchronize never changes state", () => {
  for (const state of ALL_STATES) {
    assert.equal(resolve("pr_synchronize", state), undefined, `pr_synchronize from ${state}`);
  }
});

// ─── Merge queue events (handled by external steward) ────────────

test("merge_group events are no-ops (queue managed by external steward)", () => {
  for (const state of ALL_STATES) {
    assert.equal(resolve("merge_group_failed", state), undefined, `merge_group_failed from ${state}`);
    assert.equal(resolve("merge_group_passed", state), undefined, `merge_group_passed from ${state}`);
  }
});

// ─── End-to-end scenarios ────────────────────────────────────────

test("full cycle: implement → CI fail → repair → approve → merge", () => {
  assert.equal(resolve("pr_opened", "implementing"), "pr_open");
  assert.equal(resolve("check_failed", "pr_open"), "repairing_ci");
  assert.equal(resolve("check_passed", "repairing_ci"), "pr_open");
  assert.equal(resolve("review_approved", "pr_open"), "awaiting_queue");
  // External steward handles queue → merge. PatchRelay sees pr_merged.
  assert.equal(resolve("pr_merged", "awaiting_queue"), "done");
});

test("late review after approval pulls issue from merge queue", () => {
  assert.equal(resolve("review_approved", "pr_open"), "awaiting_queue");
  assert.equal(resolve("review_changes_requested", "awaiting_queue"), "changes_requested");
  // After fix + re-approval:
  assert.equal(resolve("review_approved", "changes_requested"), "awaiting_queue");
});

test("CI failure in merge queue → repair → fast-track back if approved", () => {
  assert.equal(resolve("check_failed", "awaiting_queue"), "repairing_ci");
  assert.equal(resolve("check_passed", "repairing_ci", { prReviewState: "approved" }), "awaiting_queue");
});

// ─── Structural validation ───────────────────────────────────────

test("terminal states accept no transitions except pr_merged", () => {
  for (const event of ALL_EVENTS) {
    if (event === "pr_merged") continue;
    for (const state of TERMINAL_STATES) {
      assert.equal(resolve(event, state), undefined, `${event} from terminal ${state}`);
    }
  }
});

test("deriveAllowedTransitions is consistent with resolver", () => {
  const derived = deriveAllowedTransitions(ALL_STATES, ALL_EVENTS);
  // Every non-done state should reach done (via pr_merged)
  for (const state of ALL_STATES) {
    if (state === "done") continue; // done → done is a no-op (not a transition)
    assert.ok(derived[state].has("done"), `${state} should reach done via pr_merged`);
  }
});
