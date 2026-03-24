import assert from "node:assert/strict";
import test from "node:test";
import { resolveFactoryStateFromGitHub, ALLOWED_TRANSITIONS, type FactoryState } from "../src/factory-state.ts";
import type { GitHubTriggerEvent } from "../src/github-types.ts";

// ─── Helper ───────────────────────────────────────────────────────

function resolve(event: GitHubTriggerEvent, current: FactoryState): FactoryState | undefined {
  return resolveFactoryStateFromGitHub(event, current);
}

// ─── Happy path: implementation → merge ───────────────────────────

test("happy path: implementing → pr_open → awaiting_queue → done", () => {
  assert.equal(resolve("pr_opened", "implementing"), "pr_open");
  assert.equal(resolve("review_approved", "pr_open"), "awaiting_queue");
  assert.equal(resolve("pr_merged", "awaiting_queue"), "done");
});

test("happy path via awaiting_review", () => {
  assert.equal(resolve("review_approved", "awaiting_review"), "awaiting_queue");
  assert.equal(resolve("pr_merged", "awaiting_queue"), "done");
});

// ─── CI repair loop ──────────────────────────────────────────────

test("ci repair from pr_open: check_failed → repairing_ci → pr_open", () => {
  assert.equal(resolve("check_failed", "pr_open"), "repairing_ci");
  assert.equal(resolve("check_passed", "repairing_ci"), "pr_open");
});

test("ci repair from awaiting_review: check_failed → repairing_ci → pr_open", () => {
  assert.equal(resolve("check_failed", "awaiting_review"), "repairing_ci");
  assert.equal(resolve("check_passed", "repairing_ci"), "pr_open");
});

test("ci repair from awaiting_queue: check_failed → repairing_ci → pr_open", () => {
  assert.equal(resolve("check_failed", "awaiting_queue"), "repairing_ci");
  assert.equal(resolve("check_passed", "repairing_ci"), "pr_open");
});

// ─── Queue repair (merge conflict) ──────────────────────────────

test("queue repair: merge_group_failed → repairing_queue → awaiting_queue", () => {
  assert.equal(resolve("merge_group_failed", "awaiting_queue"), "repairing_queue");
  assert.equal(resolve("check_passed", "repairing_queue"), "awaiting_queue");
});

test("queue repair returns to awaiting_queue, not pr_open", () => {
  // After queue_repair succeeds, the issue should re-enter the merge queue
  assert.equal(resolve("check_passed", "repairing_queue"), "awaiting_queue");
  assert.notEqual(resolve("check_passed", "repairing_queue"), "pr_open");
});

// ─── Review changes requested ────────────────────────────────────

test("review_changes_requested from awaiting_review → changes_requested", () => {
  assert.equal(resolve("review_changes_requested", "awaiting_review"), "changes_requested");
});

test("review_changes_requested from pr_open → changes_requested", () => {
  assert.equal(resolve("review_changes_requested", "pr_open"), "changes_requested");
});

test("review_changes_requested from awaiting_queue → changes_requested", () => {
  // Late review after approval — must pull the issue out of the merge queue
  assert.equal(resolve("review_changes_requested", "awaiting_queue"), "changes_requested");
});

test("review_changes_requested during active runs is ignored", () => {
  // During ci_repair or queue_repair, a review_changes_requested should not
  // disrupt the active run — the resolver returns undefined.
  assert.equal(resolve("review_changes_requested", "repairing_ci"), undefined);
  assert.equal(resolve("review_changes_requested", "repairing_queue"), undefined);
  assert.equal(resolve("review_changes_requested", "implementing"), undefined);
  assert.equal(resolve("review_changes_requested", "changes_requested"), undefined);
});

// ─── Review approved ─────────────────────────────────────────────

test("review_approved from pr_open → awaiting_queue", () => {
  assert.equal(resolve("review_approved", "pr_open"), "awaiting_queue");
});

test("review_approved from awaiting_review → awaiting_queue", () => {
  assert.equal(resolve("review_approved", "awaiting_review"), "awaiting_queue");
});

test("review_approved while already in awaiting_queue is no-op", () => {
  // Re-approval while already queued — should not re-trigger
  assert.equal(resolve("review_approved", "awaiting_queue"), undefined);
});

test("review_approved from changes_requested → awaiting_queue (re-approval after fix)", () => {
  // Codex addressed review feedback, pushed fix, Claude re-reviewed and approved
  assert.equal(resolve("review_approved", "changes_requested"), "awaiting_queue");
});

test("review_approved during active runs is ignored", () => {
  assert.equal(resolve("review_approved", "repairing_ci"), undefined);
  assert.equal(resolve("review_approved", "implementing"), undefined);
});

// ─── check_passed edge cases ─────────────────────────────────────

test("check_passed in awaiting_queue is no-op (auto-merge handles it)", () => {
  assert.equal(resolve("check_passed", "awaiting_queue"), undefined);
});

test("check_passed in pr_open is no-op", () => {
  assert.equal(resolve("check_passed", "pr_open"), undefined);
});

test("check_passed in implementing is no-op", () => {
  assert.equal(resolve("check_passed", "implementing"), undefined);
});

// ─── check_failed edge cases ─────────────────────────────────────

test("check_failed during active repair runs is ignored", () => {
  // Already repairing — don't stack another repair
  assert.equal(resolve("check_failed", "repairing_ci"), undefined);
  assert.equal(resolve("check_failed", "repairing_queue"), undefined);
});

test("check_failed during implementation is ignored", () => {
  assert.equal(resolve("check_failed", "implementing"), undefined);
});

test("check_failed in changes_requested is ignored", () => {
  assert.equal(resolve("check_failed", "changes_requested"), undefined);
});

// ─── PR lifecycle events ─────────────────────────────────────────

test("pr_merged from any state goes to done", () => {
  const states: FactoryState[] = [
    "implementing", "pr_open", "awaiting_review", "awaiting_queue",
    "repairing_ci", "repairing_queue", "changes_requested",
  ];
  for (const state of states) {
    assert.equal(resolve("pr_merged", state), "done", `pr_merged from ${state}`);
  }
});

test("pr_closed from any state goes to failed", () => {
  const states: FactoryState[] = [
    "implementing", "pr_open", "awaiting_review", "awaiting_queue",
    "repairing_ci", "repairing_queue", "changes_requested",
  ];
  for (const state of states) {
    assert.equal(resolve("pr_closed", state), "failed", `pr_closed from ${state}`);
  }
});

test("pr_opened only transitions from implementing", () => {
  assert.equal(resolve("pr_opened", "implementing"), "pr_open");
  assert.equal(resolve("pr_opened", "pr_open"), undefined);
  assert.equal(resolve("pr_opened", "awaiting_queue"), undefined);
});

// ─── pr_synchronize ──────────────────────────────────────────────

test("pr_synchronize never changes state (just resets counters)", () => {
  const states: FactoryState[] = [
    "pr_open", "awaiting_review", "awaiting_queue",
    "repairing_ci", "repairing_queue",
  ];
  for (const state of states) {
    assert.equal(resolve("pr_synchronize", state), undefined, `pr_synchronize from ${state}`);
  }
});

// ─── review_commented ────────────────────────────────────────────

test("review_commented is always informational (no state change)", () => {
  const states: FactoryState[] = [
    "pr_open", "awaiting_review", "awaiting_queue",
    "repairing_ci", "changes_requested",
  ];
  for (const state of states) {
    assert.equal(resolve("review_commented", state), undefined, `review_commented from ${state}`);
  }
});

// ─── merge_group events ──────────────────────────────────────────

test("merge_group_passed is no-op (merge event will follow)", () => {
  assert.equal(resolve("merge_group_passed", "awaiting_queue"), undefined);
});

test("merge_group_failed only triggers from awaiting_queue", () => {
  assert.equal(resolve("merge_group_failed", "awaiting_queue"), "repairing_queue");
  assert.equal(resolve("merge_group_failed", "pr_open"), undefined);
  assert.equal(resolve("merge_group_failed", "repairing_ci"), undefined);
});

// ─── Terminal states ─────────────────────────────────────────────

test("done and escalated are terminal — no GitHub events change them", () => {
  const events: GitHubTriggerEvent[] = [
    "pr_opened", "review_approved", "review_changes_requested",
    "check_passed", "check_failed", "merge_group_failed",
  ];
  for (const event of events) {
    // pr_merged and pr_closed always return done/failed, but in practice
    // they shouldn't arrive after done/escalated
    if (event === "pr_merged" || event === "pr_closed") continue;
    assert.equal(resolve(event, "done"), undefined, `${event} from done`);
    assert.equal(resolve(event, "escalated"), undefined, `${event} from escalated`);
  }
});

// ─── ALLOWED_TRANSITIONS consistency ─────────────────────────────

test("every resolver transition target is listed in ALLOWED_TRANSITIONS", () => {
  const events: GitHubTriggerEvent[] = [
    "pr_opened", "pr_synchronize", "pr_closed", "pr_merged",
    "review_approved", "review_changes_requested", "review_commented",
    "check_passed", "check_failed",
    "merge_group_passed", "merge_group_failed",
  ];
  const states: FactoryState[] = [
    "delegated", "preparing", "implementing", "pr_open", "awaiting_review",
    "changes_requested", "repairing_ci", "awaiting_queue", "repairing_queue",
    "awaiting_input", "escalated", "done", "failed",
  ];

  const violations: string[] = [];
  for (const event of events) {
    for (const state of states) {
      const target = resolve(event, state);
      if (target === undefined) continue;
      // pr_merged → done and pr_closed → failed are unconditional
      if (event === "pr_merged" || event === "pr_closed") continue;
      const allowed = ALLOWED_TRANSITIONS[state];
      if (!allowed.includes(target)) {
        violations.push(`${event} in ${state} → ${target} (not in ALLOWED_TRANSITIONS[${state}])`);
      }
    }
  }
  assert.deepEqual(violations, [], `Resolver produces transitions not in ALLOWED_TRANSITIONS:\n${violations.join("\n")}`);
});

// ─── Scenario: full cycle with CI repair and queue repair ────────

test("full cycle: implement → CI fail → repair → approve → conflict → queue repair → merge", () => {
  // Implementation opens PR
  assert.equal(resolve("pr_opened", "implementing"), "pr_open");

  // CI fails
  assert.equal(resolve("check_failed", "pr_open"), "repairing_ci");

  // CI repair fixes it
  assert.equal(resolve("check_passed", "repairing_ci"), "pr_open");

  // Approved
  assert.equal(resolve("review_approved", "pr_open"), "awaiting_queue");

  // Merge queue conflict
  assert.equal(resolve("merge_group_failed", "awaiting_queue"), "repairing_queue");

  // Queue repair fixes conflict, CI passes
  assert.equal(resolve("check_passed", "repairing_queue"), "awaiting_queue");

  // Merged
  assert.equal(resolve("pr_merged", "awaiting_queue"), "done");
});

// ─── Scenario: late review changes after approval ────────────────

test("late review after approval pulls issue out of merge queue", () => {
  assert.equal(resolve("review_approved", "pr_open"), "awaiting_queue");
  assert.equal(resolve("review_changes_requested", "awaiting_queue"), "changes_requested");
  // After review_fix, Codex pushes, CI passes → pr_open
  // (fast-track to awaiting_queue happens in webhook handler, not resolver)
  assert.equal(resolve("check_passed", "repairing_ci"), "pr_open");
});

// ─── Scenario: CI fails while in merge queue ─────────────────────

test("CI failure while in merge queue triggers ci_repair", () => {
  assert.equal(resolve("check_failed", "awaiting_queue"), "repairing_ci");
  assert.equal(resolve("check_passed", "repairing_ci"), "pr_open");
});
