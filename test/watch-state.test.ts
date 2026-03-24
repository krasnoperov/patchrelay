import assert from "node:assert/strict";
import test from "node:test";
import {
  watchReducer,
  initialWatchState,
  type WatchAction,
  type WatchIssue,
  type WatchState,
} from "../src/cli/watch/watch-state.ts";
import type { OperatorFeedEvent } from "../src/operator-feed.ts";

// ─── Helpers ──────────────────────────────────────────────────────

function makeIssue(key: string, overrides?: Partial<WatchIssue>): WatchIssue {
  return {
    issueKey: key,
    projectId: "test-project",
    factoryState: "implementing",
    updatedAt: "2026-03-25T10:00:00.000Z",
    ...overrides,
  };
}

function makeFeedEvent(overrides: Partial<OperatorFeedEvent> & { id: number }): OperatorFeedEvent {
  return {
    at: "2026-03-25T10:05:00.000Z",
    level: "info",
    kind: "stage",
    summary: "test event",
    ...overrides,
  };
}

function stateWith(overrides: Partial<WatchState>): WatchState {
  return { ...initialWatchState, ...overrides };
}

function reduce(state: WatchState, action: WatchAction): WatchState {
  return watchReducer(state, action);
}

// ─── Connection State ─────────────────────────────────────────────

test("connected and disconnected toggle the connected flag", () => {
  const s1 = reduce(initialWatchState, { type: "connected" });
  assert.equal(s1.connected, true);
  const s2 = reduce(s1, { type: "disconnected" });
  assert.equal(s2.connected, false);
});

// ─── Issues Snapshot ──────────────────────────────────────────────

test("issues-snapshot replaces the issue list", () => {
  const issues = [makeIssue("USE-1"), makeIssue("USE-2")];
  const state = reduce(initialWatchState, { type: "issues-snapshot", issues });
  assert.equal(state.issues.length, 2);
  assert.equal(state.issues[0]?.issueKey, "USE-1");
  assert.equal(state.issues[1]?.issueKey, "USE-2");
});

test("issues-snapshot clamps selectedIndex when list shrinks", () => {
  const initial = stateWith({
    issues: [makeIssue("USE-1"), makeIssue("USE-2"), makeIssue("USE-3")],
    selectedIndex: 2,
  });
  const state = reduce(initial, { type: "issues-snapshot", issues: [makeIssue("USE-1")] });
  assert.equal(state.selectedIndex, 0);
});

test("issues-snapshot preserves selectedIndex when list stays same size", () => {
  const initial = stateWith({
    issues: [makeIssue("USE-1"), makeIssue("USE-2")],
    selectedIndex: 1,
  });
  const state = reduce(initial, {
    type: "issues-snapshot",
    issues: [makeIssue("USE-1"), makeIssue("USE-2", { factoryState: "done" })],
  });
  assert.equal(state.selectedIndex, 1);
});

// ─── Selection ────────────────────────────────────────────────────

test("select clamps to valid range", () => {
  const initial = stateWith({
    issues: [makeIssue("USE-1"), makeIssue("USE-2"), makeIssue("USE-3")],
    selectedIndex: 0,
  });

  const down = reduce(initial, { type: "select", index: 1 });
  assert.equal(down.selectedIndex, 1);

  const pastEnd = reduce(initial, { type: "select", index: 10 });
  assert.equal(pastEnd.selectedIndex, 2);

  const belowZero = reduce(initial, { type: "select", index: -1 });
  assert.equal(belowZero.selectedIndex, 0);
});

test("select on empty list stays at 0", () => {
  const state = reduce(initialWatchState, { type: "select", index: 5 });
  assert.equal(state.selectedIndex, 0);
});

// ─── View Transitions ─────────────────────────────────────────────

test("enter-detail switches to detail view with the issue key", () => {
  const state = reduce(initialWatchState, { type: "enter-detail", issueKey: "USE-74" });
  assert.equal(state.view, "detail");
  assert.equal(state.activeDetailKey, "USE-74");
});

test("exit-detail returns to list view and clears active key", () => {
  const initial = stateWith({ view: "detail", activeDetailKey: "USE-74" });
  const state = reduce(initial, { type: "exit-detail" });
  assert.equal(state.view, "list");
  assert.equal(state.activeDetailKey, null);
});

// ─── Feed Event Application ───────────────────────────────────────

test("feed-event with stage kind updates factoryState", () => {
  const initial = stateWith({
    issues: [makeIssue("USE-74", { factoryState: "implementing" })],
  });
  const event = makeFeedEvent({
    id: 1,
    kind: "stage",
    issueKey: "USE-74",
    stage: "repairing_queue",
  });
  const state = reduce(initial, { type: "feed-event", event });
  assert.equal(state.issues[0]?.factoryState, "repairing_queue");
});

test("feed-event with stage starting updates activeRunType", () => {
  const initial = stateWith({
    issues: [makeIssue("USE-74")],
  });
  const event = makeFeedEvent({
    id: 2,
    kind: "stage",
    status: "starting",
    issueKey: "USE-74",
    stage: "queue_repair",
  });
  const state = reduce(initial, { type: "feed-event", event });
  assert.equal(state.issues[0]?.activeRunType, "queue_repair");
});

test("feed-event with turn completed clears activeRunType and sets latestRunStatus", () => {
  const initial = stateWith({
    issues: [makeIssue("USE-74", { activeRunType: "implementation" })],
  });
  const event = makeFeedEvent({
    id: 3,
    kind: "turn",
    status: "completed",
    issueKey: "USE-74",
  });
  const state = reduce(initial, { type: "feed-event", event });
  assert.equal(state.issues[0]?.activeRunType, undefined);
  assert.equal(state.issues[0]?.latestRunStatus, "completed");
});

test("feed-event with turn failed sets latestRunStatus to failed", () => {
  const initial = stateWith({
    issues: [makeIssue("USE-74", { activeRunType: "ci_repair" })],
  });
  const event = makeFeedEvent({
    id: 4,
    kind: "turn",
    status: "failed",
    issueKey: "USE-74",
  });
  const state = reduce(initial, { type: "feed-event", event });
  assert.equal(state.issues[0]?.activeRunType, undefined);
  assert.equal(state.issues[0]?.latestRunStatus, "failed");
});

test("feed-event with github check_passed updates prCheckStatus", () => {
  const initial = stateWith({
    issues: [makeIssue("USE-74", { prNumber: 127 })],
  });
  const event = makeFeedEvent({
    id: 5,
    kind: "github",
    status: "check_passed",
    issueKey: "USE-74",
  });
  const state = reduce(initial, { type: "feed-event", event });
  assert.equal(state.issues[0]?.prCheckStatus, "passed");
});

test("feed-event with github check_failed updates prCheckStatus", () => {
  const initial = stateWith({
    issues: [makeIssue("USE-74", { prNumber: 127 })],
  });
  const event = makeFeedEvent({
    id: 6,
    kind: "github",
    status: "check_failed",
    issueKey: "USE-74",
  });
  const state = reduce(initial, { type: "feed-event", event });
  assert.equal(state.issues[0]?.prCheckStatus, "failed");
});

test("feed-event updates updatedAt timestamp", () => {
  const initial = stateWith({
    issues: [makeIssue("USE-74", { updatedAt: "2026-03-25T09:00:00.000Z" })],
  });
  const event = makeFeedEvent({
    id: 7,
    kind: "stage",
    stage: "done",
    issueKey: "USE-74",
    at: "2026-03-25T11:30:00.000Z",
  });
  const state = reduce(initial, { type: "feed-event", event });
  assert.equal(state.issues[0]?.updatedAt, "2026-03-25T11:30:00.000Z");
});

test("feed-event for unknown issue is a no-op", () => {
  const initial = stateWith({
    issues: [makeIssue("USE-74")],
  });
  const event = makeFeedEvent({
    id: 8,
    kind: "stage",
    stage: "done",
    issueKey: "USE-999",
  });
  const state = reduce(initial, { type: "feed-event", event });
  assert.deepEqual(state.issues, initial.issues);
});

test("feed-event without issueKey is a no-op", () => {
  const initial = stateWith({
    issues: [makeIssue("USE-74")],
  });
  const event = makeFeedEvent({
    id: 9,
    kind: "service",
    summary: "service started",
  });
  const state = reduce(initial, { type: "feed-event", event });
  assert.deepEqual(state.issues, initial.issues);
});

test("feed-event does not mutate original state", () => {
  const issue = makeIssue("USE-74", { factoryState: "implementing" });
  const initial = stateWith({ issues: [issue] });
  const event = makeFeedEvent({
    id: 10,
    kind: "stage",
    stage: "done",
    issueKey: "USE-74",
  });
  reduce(initial, { type: "feed-event", event });
  assert.equal(initial.issues[0]?.factoryState, "implementing");
});

// ─── Multi-issue scenarios ────────────────────────────────────────

test("feed-event updates only the matching issue in a multi-issue list", () => {
  const initial = stateWith({
    issues: [
      makeIssue("USE-72", { factoryState: "implementing" }),
      makeIssue("USE-74", { factoryState: "implementing" }),
      makeIssue("USE-76", { factoryState: "implementing" }),
    ],
  });
  const event = makeFeedEvent({
    id: 11,
    kind: "stage",
    stage: "done",
    issueKey: "USE-74",
  });
  const state = reduce(initial, { type: "feed-event", event });
  assert.equal(state.issues[0]?.factoryState, "implementing");
  assert.equal(state.issues[1]?.factoryState, "done");
  assert.equal(state.issues[2]?.factoryState, "implementing");
});
