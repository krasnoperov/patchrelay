import assert from "node:assert/strict";
import test from "node:test";
import { buildStateHistory, type StateHistoryNode } from "../src/cli/watch/history-builder.ts";
import type { TimelineRunInput } from "../src/cli/watch/timeline-builder.ts";
import type { OperatorFeedEvent } from "../src/operator-feed.ts";

// ─── Helpers ──────────────────────────────────────────────────────

let eventId = 0;

function feed(overrides: Partial<OperatorFeedEvent>): OperatorFeedEvent {
  return {
    id: ++eventId,
    at: "2026-03-25T10:00:00.000Z",
    level: "info",
    kind: "stage",
    summary: "test",
    ...overrides,
  };
}

function run(overrides: Partial<TimelineRunInput> & { id: number }): TimelineRunInput {
  return {
    runType: "implementation",
    status: "completed",
    startedAt: "2026-03-25T10:01:00.000Z",
    ...overrides,
  };
}

function nodeStates(nodes: StateHistoryNode[]): string[] {
  return nodes.map((n) => n.state);
}

// Reset event ID counter between tests
test.beforeEach(() => { eventId = 0; });

// ─── Happy path ──────────────────────────────────────────────────

test("happy path: delegated → implementing → pr_open → awaiting_queue → done", () => {
  const events: OperatorFeedEvent[] = [
    feed({ at: "2026-03-25T10:00:00Z", kind: "stage", status: "starting", stage: "implementation", summary: "Starting implementation run" }),
    feed({ at: "2026-03-25T10:20:00Z", kind: "github", status: "pr_opened", stage: "pr_open", summary: "GitHub: pr_opened" }),
    feed({ at: "2026-03-25T10:25:00Z", kind: "github", status: "review_approved", stage: "awaiting_queue", summary: "GitHub: review_approved" }),
    feed({ at: "2026-03-25T10:30:00Z", kind: "github", status: "pr_merged", stage: "done", summary: "GitHub: pr_merged" }),
  ];
  const runs: TimelineRunInput[] = [
    run({ id: 1, startedAt: "2026-03-25T10:00:00Z", endedAt: "2026-03-25T10:19:00Z" }),
  ];

  const history = buildStateHistory(runs, events, "done", null);

  assert.deepEqual(nodeStates(history), ["implementing", "pr_open", "awaiting_queue", "done"]);
  assert.equal(history[history.length - 1]!.isCurrent, true);
  // Run attached to implementing
  assert.equal(history[0]!.runs.length, 1);
  assert.equal(history[0]!.runs[0]!.runType, "implementation");
  // No side-trips
  for (const node of history) {
    assert.equal(node.sideTrips.length, 0);
  }
});

// ─── Single side-trip (changes_requested) ────────────────────────

test("single side-trip: changes_requested from pr_open", () => {
  const events: OperatorFeedEvent[] = [
    feed({ at: "2026-03-25T10:00:00Z", kind: "stage", status: "starting", stage: "implementation", summary: "Starting implementation run" }),
    feed({ at: "2026-03-25T10:20:00Z", kind: "github", status: "pr_opened", stage: "pr_open", summary: "GitHub: pr_opened" }),
    feed({ at: "2026-03-25T10:25:00Z", kind: "github", status: "review_changes_requested", stage: "changes_requested", summary: "GitHub: review_changes_requested" }),
    feed({ at: "2026-03-25T10:35:00Z", kind: "github", status: "review_approved", stage: "awaiting_queue", summary: "GitHub: review_approved" }),
    feed({ at: "2026-03-25T10:40:00Z", kind: "github", status: "pr_merged", stage: "done", summary: "GitHub: pr_merged" }),
  ];
  const runs: TimelineRunInput[] = [
    run({ id: 1, startedAt: "2026-03-25T10:00:00Z", endedAt: "2026-03-25T10:19:00Z" }),
    run({ id: 2, runType: "review_fix", startedAt: "2026-03-25T10:26:00Z", endedAt: "2026-03-25T10:34:00Z" }),
  ];

  const history = buildStateHistory(runs, events, "done", null);

  assert.deepEqual(nodeStates(history), ["implementing", "pr_open", "awaiting_queue", "done"]);
  // pr_open should have one side-trip
  const prOpen = history.find((n) => n.state === "pr_open")!;
  assert.equal(prOpen.sideTrips.length, 1);
  assert.equal(prOpen.sideTrips[0]!.state, "changes_requested");
  assert.equal(prOpen.sideTrips[0]!.returnState, "awaiting_queue");
  // review_fix run attached to the side-trip
  assert.equal(prOpen.sideTrips[0]!.runs.length, 1);
  assert.equal(prOpen.sideTrips[0]!.runs[0]!.runType, "review_fix");
});

// ─── Multiple side-trips from same state ─────────────────────────

test("multiple side-trips: 2 review rounds + CI repair from pr_open", () => {
  const events: OperatorFeedEvent[] = [
    feed({ at: "2026-03-25T10:00:00Z", kind: "stage", status: "starting", stage: "implementation" }),
    feed({ at: "2026-03-25T10:20:00Z", kind: "github", status: "pr_opened", stage: "pr_open" }),
    // First review round
    feed({ at: "2026-03-25T10:25:00Z", kind: "github", status: "review_changes_requested", stage: "changes_requested" }),
    feed({ at: "2026-03-25T10:35:00Z", kind: "github", status: "check_passed", stage: "pr_open" }),
    // CI failure
    feed({ at: "2026-03-25T10:36:00Z", kind: "github", status: "check_failed", stage: "repairing_ci" }),
    feed({ at: "2026-03-25T10:42:00Z", kind: "github", status: "check_passed", stage: "pr_open" }),
    // Second review round
    feed({ at: "2026-03-25T10:43:00Z", kind: "github", status: "review_changes_requested", stage: "changes_requested" }),
    feed({ at: "2026-03-25T10:50:00Z", kind: "github", status: "review_approved", stage: "awaiting_queue" }),
    feed({ at: "2026-03-25T10:55:00Z", kind: "github", status: "pr_merged", stage: "done" }),
  ];
  const runs: TimelineRunInput[] = [
    run({ id: 1, startedAt: "2026-03-25T10:00:00Z", endedAt: "2026-03-25T10:19:00Z" }),
    run({ id: 2, runType: "review_fix", startedAt: "2026-03-25T10:26:00Z", endedAt: "2026-03-25T10:34:00Z" }),
    run({ id: 3, runType: "ci_repair", startedAt: "2026-03-25T10:37:00Z", endedAt: "2026-03-25T10:41:00Z" }),
    run({ id: 4, runType: "review_fix", startedAt: "2026-03-25T10:44:00Z", endedAt: "2026-03-25T10:49:00Z" }),
  ];

  const history = buildStateHistory(runs, events, "done", null);

  const prOpen = history.find((n) => n.state === "pr_open")!;
  assert.equal(prOpen.sideTrips.length, 3);
  assert.equal(prOpen.sideTrips[0]!.state, "changes_requested");
  assert.equal(prOpen.sideTrips[1]!.state, "repairing_ci");
  assert.equal(prOpen.sideTrips[2]!.state, "changes_requested");
});

// ─── Active run ──────────────────────────────────────────────────

test("active run: implementing with active run", () => {
  const events: OperatorFeedEvent[] = [
    feed({ at: "2026-03-25T10:00:00Z", kind: "stage", status: "starting", stage: "implementation", summary: "Starting implementation run" }),
  ];
  const runs: TimelineRunInput[] = [
    run({ id: 1, status: "running", startedAt: "2026-03-25T10:00:00Z" }),
  ];

  const history = buildStateHistory(runs, events, "implementing", 1);

  assert.equal(history.length, 1);
  assert.equal(history[0]!.state, "implementing");
  assert.equal(history[0]!.isCurrent, true);
  assert.equal(history[0]!.runs.length, 1);
  assert.equal(history[0]!.runs[0]!.status, "running");
});

// ─── Retry after done ────────────────────────────────────────────

test("retry after done: continues the node list", () => {
  const events: OperatorFeedEvent[] = [
    feed({ at: "2026-03-25T10:00:00Z", kind: "stage", status: "starting", stage: "implementation" }),
    feed({ at: "2026-03-25T10:20:00Z", kind: "github", status: "pr_opened", stage: "pr_open" }),
    feed({ at: "2026-03-25T10:25:00Z", kind: "github", status: "review_approved", stage: "awaiting_queue" }),
    feed({ at: "2026-03-25T10:30:00Z", kind: "github", status: "pr_merged", stage: "done" }),
    // Retry
    feed({ at: "2026-03-25T11:00:00Z", kind: "stage", status: "retry", stage: "delegated", summary: "Retry queued: implementation" }),
    feed({ at: "2026-03-25T11:01:00Z", kind: "stage", status: "starting", stage: "implementation" }),
  ];
  const runs: TimelineRunInput[] = [
    run({ id: 1, startedAt: "2026-03-25T10:00:00Z", endedAt: "2026-03-25T10:19:00Z" }),
    run({ id: 2, status: "running", startedAt: "2026-03-25T11:01:00Z" }),
  ];

  const history = buildStateHistory(runs, events, "implementing", 2);

  // done then delegated then implementing again
  assert.ok(nodeStates(history).includes("done"));
  assert.ok(nodeStates(history).includes("delegated"));
  // The last implementing node should be current
  const lastNode = history[history.length - 1]!;
  assert.equal(lastNode.state, "implementing");
  assert.equal(lastNode.isCurrent, true);
  assert.equal(lastNode.runs[0]!.status, "running");
});

// ─── Terminal states ─────────────────────────────────────────────

test("terminal: escalated as final node", () => {
  const events: OperatorFeedEvent[] = [
    feed({ at: "2026-03-25T10:00:00Z", kind: "stage", status: "starting", stage: "implementation" }),
    feed({ at: "2026-03-25T10:20:00Z", kind: "github", status: "pr_opened", stage: "pr_open" }),
    feed({ at: "2026-03-25T10:25:00Z", kind: "github", status: "check_failed", stage: "repairing_ci" }),
    feed({ at: "2026-03-25T10:40:00Z", kind: "stage", status: "reconciled", stage: "escalated", summary: "Reconciliation: repairing_ci → escalated" }),
  ];
  const runs: TimelineRunInput[] = [
    run({ id: 1, startedAt: "2026-03-25T10:00:00Z", endedAt: "2026-03-25T10:19:00Z" }),
    run({ id: 2, runType: "ci_repair", status: "failed", startedAt: "2026-03-25T10:26:00Z", endedAt: "2026-03-25T10:39:00Z" }),
  ];

  const history = buildStateHistory(runs, events, "escalated", null);

  const lastNode = history[history.length - 1]!;
  assert.equal(lastNode.state, "escalated");
  assert.equal(lastNode.isCurrent, true);
});

test("terminal: failed as final node", () => {
  const events: OperatorFeedEvent[] = [
    feed({ at: "2026-03-25T10:00:00Z", kind: "stage", status: "starting", stage: "implementation" }),
    feed({ at: "2026-03-25T10:10:00Z", kind: "stage", status: "reconciled", stage: "failed", summary: "Turn failed" }),
  ];
  const runs: TimelineRunInput[] = [
    run({ id: 1, status: "failed", startedAt: "2026-03-25T10:00:00Z", endedAt: "2026-03-25T10:09:00Z" }),
  ];

  const history = buildStateHistory(runs, events, "failed", null);

  const lastNode = history[history.length - 1]!;
  assert.equal(lastNode.state, "failed");
  assert.equal(lastNode.isCurrent, true);
});

// ─── Run-to-state mapping ────────────────────────────────────────

test("run-to-state mapping: ci_repair → repairing_ci, review_fix → changes_requested", () => {
  const events: OperatorFeedEvent[] = [
    feed({ at: "2026-03-25T10:00:00Z", kind: "stage", status: "starting", stage: "implementation" }),
    feed({ at: "2026-03-25T10:20:00Z", kind: "github", status: "pr_opened", stage: "pr_open" }),
    feed({ at: "2026-03-25T10:25:00Z", kind: "github", status: "check_failed", stage: "repairing_ci" }),
    feed({ at: "2026-03-25T10:35:00Z", kind: "github", status: "check_passed", stage: "pr_open" }),
    feed({ at: "2026-03-25T10:36:00Z", kind: "github", status: "review_changes_requested", stage: "changes_requested" }),
    feed({ at: "2026-03-25T10:45:00Z", kind: "github", status: "review_approved", stage: "awaiting_queue" }),
  ];
  const runs: TimelineRunInput[] = [
    run({ id: 1, startedAt: "2026-03-25T10:00:00Z", endedAt: "2026-03-25T10:19:00Z" }),
    run({ id: 2, runType: "ci_repair", startedAt: "2026-03-25T10:26:00Z", endedAt: "2026-03-25T10:34:00Z" }),
    run({ id: 3, runType: "review_fix", startedAt: "2026-03-25T10:37:00Z", endedAt: "2026-03-25T10:44:00Z" }),
  ];

  const history = buildStateHistory(runs, events, "awaiting_queue", null);

  const prOpen = history.find((n) => n.state === "pr_open")!;
  // ci_repair run attached to repairing_ci side-trip
  const ciTrip = prOpen.sideTrips.find((st) => st.state === "repairing_ci")!;
  assert.equal(ciTrip.runs.length, 1);
  assert.equal(ciTrip.runs[0]!.runType, "ci_repair");
  // review_fix run attached to changes_requested side-trip
  const reviewTrip = prOpen.sideTrips.find((st) => st.state === "changes_requested")!;
  assert.equal(reviewTrip.runs.length, 1);
  assert.equal(reviewTrip.runs[0]!.runType, "review_fix");
});

// ─── Empty history ───────────────────────────────────────────────

test("empty: no events and no runs", () => {
  const history = buildStateHistory([], [], "delegated", null);
  assert.equal(history.length, 0);
});

// ─── Fallback: runs but no feed events ───────────────────────────

test("fallback: runs exist but no feed events", () => {
  const runs: TimelineRunInput[] = [
    run({ id: 1, startedAt: "2026-03-25T10:00:00Z", endedAt: "2026-03-25T10:19:00Z" }),
  ];

  const history = buildStateHistory(runs, [], "pr_open", null);

  // Should seed with delegated + implementing from runs
  assert.ok(history.length >= 2);
  assert.equal(history[0]!.state, "delegated");
  assert.equal(history[1]!.state, "implementing");
  assert.equal(history[1]!.runs.length, 1);
});

// ─── Active side-trip (currently in repairing_ci) ────────────────

test("active side-trip: currently in repairing_ci", () => {
  const events: OperatorFeedEvent[] = [
    feed({ at: "2026-03-25T10:00:00Z", kind: "stage", status: "starting", stage: "implementation" }),
    feed({ at: "2026-03-25T10:20:00Z", kind: "github", status: "pr_opened", stage: "pr_open" }),
    feed({ at: "2026-03-25T10:25:00Z", kind: "github", status: "check_failed", stage: "repairing_ci" }),
  ];
  const runs: TimelineRunInput[] = [
    run({ id: 1, startedAt: "2026-03-25T10:00:00Z", endedAt: "2026-03-25T10:19:00Z" }),
    run({ id: 2, runType: "ci_repair", status: "running", startedAt: "2026-03-25T10:26:00Z" }),
  ];

  const history = buildStateHistory(runs, events, "repairing_ci", 2);

  // pr_open should be marked as current (it's the main-path parent of the side-trip)
  const prOpen = history.find((n) => n.state === "pr_open")!;
  assert.equal(prOpen.isCurrent, true);
  // Side-trip should exist and have the active run
  assert.equal(prOpen.sideTrips.length, 1);
  assert.equal(prOpen.sideTrips[0]!.state, "repairing_ci");
  assert.equal(prOpen.sideTrips[0]!.runs[0]!.status, "running");
});

// ─── Queue repair side-trip ──────────────────────────────────────

test("queue repair: repairing_queue from awaiting_queue", () => {
  const events: OperatorFeedEvent[] = [
    feed({ at: "2026-03-25T10:00:00Z", kind: "stage", status: "starting", stage: "implementation" }),
    feed({ at: "2026-03-25T10:20:00Z", kind: "github", status: "pr_opened", stage: "pr_open" }),
    feed({ at: "2026-03-25T10:25:00Z", kind: "github", status: "review_approved", stage: "awaiting_queue" }),
    feed({ at: "2026-03-25T10:30:00Z", kind: "github", status: "merge_group_failed", stage: "repairing_queue" }),
    feed({ at: "2026-03-25T10:40:00Z", kind: "github", status: "check_passed", stage: "awaiting_queue" }),
    feed({ at: "2026-03-25T10:45:00Z", kind: "github", status: "pr_merged", stage: "done" }),
  ];
  const runs: TimelineRunInput[] = [
    run({ id: 1, startedAt: "2026-03-25T10:00:00Z", endedAt: "2026-03-25T10:19:00Z" }),
    run({ id: 2, runType: "queue_repair", startedAt: "2026-03-25T10:31:00Z", endedAt: "2026-03-25T10:39:00Z" }),
  ];

  const history = buildStateHistory(runs, events, "done", null);

  const awaitingQueue = history.find((n) => n.state === "awaiting_queue")!;
  assert.equal(awaitingQueue.sideTrips.length, 1);
  assert.equal(awaitingQueue.sideTrips[0]!.state, "repairing_queue");
  assert.equal(awaitingQueue.sideTrips[0]!.returnState, "awaiting_queue");
  assert.equal(awaitingQueue.sideTrips[0]!.runs[0]!.runType, "queue_repair");
});
