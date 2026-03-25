import assert from "node:assert/strict";
import test from "node:test";
import {
  watchReducer,
  initialWatchState,
  type WatchAction,
  type WatchIssue,
  type WatchState,
  type WatchThread,
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

// ─── Thread Snapshot ──────────────────────────────────────────────

function makeThread(overrides?: Partial<WatchThread>): WatchThread {
  return {
    threadId: "thr_abc123",
    status: "active",
    turns: [],
    ...overrides,
  };
}

test("thread-snapshot replaces the thread state", () => {
  const thread = makeThread({ turns: [{ id: "turn_1", status: "completed", items: [] }] });
  const state = reduce(initialWatchState, { type: "thread-snapshot", thread });
  assert.equal(state.thread?.threadId, "thr_abc123");
  assert.equal(state.thread?.turns.length, 1);
});

test("enter-detail clears thread state for fresh rehydration", () => {
  const initial = stateWith({ thread: makeThread() });
  const state = reduce(initial, { type: "enter-detail", issueKey: "USE-74" });
  assert.equal(state.thread, null);
});

test("exit-detail clears thread state", () => {
  const initial = stateWith({ view: "detail", activeDetailKey: "USE-74", thread: makeThread() });
  const state = reduce(initial, { type: "exit-detail" });
  assert.equal(state.thread, null);
});

// ─── Codex Notification: Turn Lifecycle ───────────────────────────

test("turn/started bootstraps a thread when none exists", () => {
  const state = reduce(initialWatchState, {
    type: "codex-notification",
    method: "turn/started",
    params: { threadId: "thr_new", turn: { id: "turn_1" } },
  });
  assert.equal(state.thread?.threadId, "thr_new");
  assert.equal(state.thread?.turns.length, 1);
  assert.equal(state.thread?.turns[0]?.id, "turn_1");
  assert.equal(state.thread?.turns[0]?.status, "inProgress");
});

test("turn/started adds a new turn to existing thread", () => {
  const initial = stateWith({
    thread: makeThread({ turns: [{ id: "turn_1", status: "completed", items: [] }] }),
  });
  const state = reduce(initial, {
    type: "codex-notification",
    method: "turn/started",
    params: { turn: { id: "turn_2" } },
  });
  assert.equal(state.thread?.turns.length, 2);
  assert.equal(state.thread?.turns[1]?.id, "turn_2");
});

test("turn/started does not duplicate existing turn", () => {
  const initial = stateWith({
    thread: makeThread({ turns: [{ id: "turn_1", status: "inProgress", items: [] }] }),
  });
  const state = reduce(initial, {
    type: "codex-notification",
    method: "turn/started",
    params: { turn: { id: "turn_1" } },
  });
  assert.equal(state.thread?.turns.length, 1);
});

test("turn/completed updates turn status", () => {
  const initial = stateWith({
    thread: makeThread({ turns: [{ id: "turn_1", status: "inProgress", items: [] }] }),
  });
  const state = reduce(initial, {
    type: "codex-notification",
    method: "turn/completed",
    params: { turn: { id: "turn_1", status: "completed" } },
  });
  assert.equal(state.thread?.turns[0]?.status, "completed");
});

test("turn/completed with failed status sets failed", () => {
  const initial = stateWith({
    thread: makeThread({ turns: [{ id: "turn_1", status: "inProgress", items: [] }] }),
  });
  const state = reduce(initial, {
    type: "codex-notification",
    method: "turn/completed",
    params: { turn: { id: "turn_1", status: "failed" } },
  });
  assert.equal(state.thread?.turns[0]?.status, "failed");
});

// ─── Codex Notification: Plan and Diff ────────────────────────────

test("turn/plan/updated replaces the plan", () => {
  const initial = stateWith({ thread: makeThread() });
  const state = reduce(initial, {
    type: "codex-notification",
    method: "turn/plan/updated",
    params: {
      plan: [
        { step: "Read the code", status: "completed" },
        { step: "Run tests", status: "inProgress" },
        { step: "Push changes", status: "pending" },
      ],
    },
  });
  assert.equal(state.thread?.plan?.length, 3);
  assert.equal(state.thread?.plan?.[0]?.step, "Read the code");
  assert.equal(state.thread?.plan?.[0]?.status, "completed");
  assert.equal(state.thread?.plan?.[1]?.status, "inProgress");
});

test("turn/diff/updated replaces the diff", () => {
  const initial = stateWith({ thread: makeThread() });
  const state = reduce(initial, {
    type: "codex-notification",
    method: "turn/diff/updated",
    params: { diff: "--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-old\n+new" },
  });
  assert.ok(state.thread?.diff?.includes("+new"));
});

// ─── Codex Notification: Item Lifecycle ───────────────────────────

test("item/started adds an item to the latest turn", () => {
  const initial = stateWith({
    thread: makeThread({ turns: [{ id: "turn_1", status: "inProgress", items: [] }] }),
  });
  const state = reduce(initial, {
    type: "codex-notification",
    method: "item/started",
    params: {
      item: { id: "item_1", type: "agentMessage", status: "inProgress", text: "Hello" },
    },
  });
  assert.equal(state.thread?.turns[0]?.items.length, 1);
  assert.equal(state.thread?.turns[0]?.items[0]?.type, "agentMessage");
  assert.equal(state.thread?.turns[0]?.items[0]?.text, "Hello");
});

test("item/started adds commandExecution with parsed command", () => {
  const initial = stateWith({
    thread: makeThread({ turns: [{ id: "turn_1", status: "inProgress", items: [] }] }),
  });
  const state = reduce(initial, {
    type: "codex-notification",
    method: "item/started",
    params: {
      item: { id: "item_2", type: "commandExecution", status: "inProgress", command: ["npm", "test"] },
    },
  });
  assert.equal(state.thread?.turns[0]?.items[0]?.command, "npm test");
});

test("item/completed finalizes an item with exit code and duration", () => {
  const initial = stateWith({
    thread: makeThread({
      turns: [{
        id: "turn_1",
        status: "inProgress",
        items: [{ id: "item_1", type: "commandExecution", status: "inProgress", command: "npm test" }],
      }],
    }),
  });
  const state = reduce(initial, {
    type: "codex-notification",
    method: "item/completed",
    params: {
      item: { id: "item_1", type: "commandExecution", status: "completed", exitCode: 0, durationMs: 1500 },
    },
  });
  const item = state.thread?.turns[0]?.items[0];
  assert.equal(item?.status, "completed");
  assert.equal(item?.exitCode, 0);
  assert.equal(item?.durationMs, 1500);
});

test("item/completed replaces text for agentMessage", () => {
  const initial = stateWith({
    thread: makeThread({
      turns: [{
        id: "turn_1",
        status: "inProgress",
        items: [{ id: "item_1", type: "agentMessage", status: "inProgress", text: "partial" }],
      }],
    }),
  });
  const state = reduce(initial, {
    type: "codex-notification",
    method: "item/completed",
    params: {
      item: { id: "item_1", type: "agentMessage", status: "completed", text: "full message" },
    },
  });
  assert.equal(state.thread?.turns[0]?.items[0]?.text, "full message");
});

// ─── Codex Notification: Delta Streaming ──────────────────────────

test("item/agentMessage/delta appends text to an item", () => {
  const initial = stateWith({
    thread: makeThread({
      turns: [{
        id: "turn_1",
        status: "inProgress",
        items: [{ id: "item_1", type: "agentMessage", status: "inProgress" }],
      }],
    }),
  });
  let state = reduce(initial, {
    type: "codex-notification",
    method: "item/agentMessage/delta",
    params: { itemId: "item_1", delta: "Hello " },
  });
  state = reduce(state, {
    type: "codex-notification",
    method: "item/agentMessage/delta",
    params: { itemId: "item_1", delta: "world" },
  });
  assert.equal(state.thread?.turns[0]?.items[0]?.text, "Hello world");
});

test("item/commandExecution/outputDelta appends output to an item", () => {
  const initial = stateWith({
    thread: makeThread({
      turns: [{
        id: "turn_1",
        status: "inProgress",
        items: [{ id: "item_1", type: "commandExecution", status: "inProgress", command: "npm test" }],
      }],
    }),
  });
  let state = reduce(initial, {
    type: "codex-notification",
    method: "item/commandExecution/outputDelta",
    params: { itemId: "item_1", delta: "PASS test.ts\n" },
  });
  state = reduce(state, {
    type: "codex-notification",
    method: "item/commandExecution/outputDelta",
    params: { itemId: "item_1", delta: "PASS other.ts\n" },
  });
  assert.equal(state.thread?.turns[0]?.items[0]?.output, "PASS test.ts\nPASS other.ts\n");
});

test("delta for unknown itemId is a no-op", () => {
  const initial = stateWith({
    thread: makeThread({
      turns: [{
        id: "turn_1",
        status: "inProgress",
        items: [{ id: "item_1", type: "agentMessage", status: "inProgress" }],
      }],
    }),
  });
  const state = reduce(initial, {
    type: "codex-notification",
    method: "item/agentMessage/delta",
    params: { itemId: "item_999", delta: "ignored" },
  });
  assert.equal(state.thread?.turns[0]?.items[0]?.text, undefined);
});

// ─── Codex Notification: Thread Status ────────────────────────────

test("thread/status/changed updates thread status", () => {
  const initial = stateWith({ thread: makeThread({ status: "active" }) });
  const state = reduce(initial, {
    type: "codex-notification",
    method: "thread/status/changed",
    params: { status: { type: "idle" } },
  });
  assert.equal(state.thread?.status, "idle");
});

// ─── Codex Notification: Immutability ─────────────────────────────

test("codex-notification does not mutate original thread state", () => {
  const thread = makeThread({
    turns: [{
      id: "turn_1",
      status: "inProgress",
      items: [{ id: "item_1", type: "agentMessage", status: "inProgress" }],
    }],
  });
  const initial = stateWith({ thread });
  reduce(initial, {
    type: "codex-notification",
    method: "item/agentMessage/delta",
    params: { itemId: "item_1", delta: "new text" },
  });
  assert.equal(initial.thread?.turns[0]?.items[0]?.text, undefined);
});

test("codex-notification without thread is a no-op for non-turn/started", () => {
  const state = reduce(initialWatchState, {
    type: "codex-notification",
    method: "item/started",
    params: { item: { id: "item_1", type: "agentMessage" } },
  });
  assert.equal(state.thread, null);
});

// ─── Token Usage ──────────────────────────────────────────────────

test("thread/tokenUsage/updated sets token counts", () => {
  const initial = stateWith({ thread: makeThread() });
  const state = reduce(initial, {
    type: "codex-notification",
    method: "thread/tokenUsage/updated",
    params: { usage: { inputTokens: 12400, outputTokens: 3200 } },
  });
  assert.equal(state.thread?.tokenUsage?.inputTokens, 12400);
  assert.equal(state.thread?.tokenUsage?.outputTokens, 3200);
});

test("thread/tokenUsage/updated handles snake_case fields", () => {
  const initial = stateWith({ thread: makeThread() });
  const state = reduce(initial, {
    type: "codex-notification",
    method: "thread/tokenUsage/updated",
    params: { usage: { input_tokens: 5000, output_tokens: 1000 } },
  });
  assert.equal(state.thread?.tokenUsage?.inputTokens, 5000);
  assert.equal(state.thread?.tokenUsage?.outputTokens, 1000);
});

// ─── Diff Summary ─────────────────────────────────────────────────

test("turn/diff/updated computes diff summary", () => {
  const initial = stateWith({ thread: makeThread() });
  const diff = [
    "--- a/src/handler.ts",
    "+++ b/src/handler.ts",
    "@@ -1,3 +1,5 @@",
    " const x = 1;",
    "-const y = 2;",
    "+const y = 3;",
    "+const z = 4;",
    "--- a/src/config.ts",
    "+++ b/src/config.ts",
    "@@ -1 +1 @@",
    "-old",
    "+new",
  ].join("\n");
  const state = reduce(initial, {
    type: "codex-notification",
    method: "turn/diff/updated",
    params: { diff },
  });
  assert.equal(state.thread?.diffSummary?.filesChanged, 2);
  assert.equal(state.thread?.diffSummary?.linesAdded, 3);
  assert.equal(state.thread?.diffSummary?.linesRemoved, 2);
});

// ─── Follow Mode ──────────────────────────────────────────────────

test("toggle-follow flips follow state", () => {
  const s1 = reduce(initialWatchState, { type: "toggle-follow" });
  assert.equal(s1.follow, false);
  const s2 = reduce(s1, { type: "toggle-follow" });
  assert.equal(s2.follow, true);
});
