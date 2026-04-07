import assert from "node:assert/strict";
import test from "node:test";
import {
  watchReducer,
  initialWatchState,
  computeAggregates,
  type WatchAction,
  type WatchIssue,
  type WatchState,
} from "../src/cli/watch/watch-state.ts";
import {
  buildTimelineFromRehydration,
  type TimelineEntry,
  type TimelineRunInput,
} from "../src/cli/watch/timeline-builder.ts";
import { buildTimelineRows } from "../src/cli/watch/timeline-presentation.ts";
import type { OperatorFeedEvent } from "../src/operator-feed.ts";

// ─── Helpers ──────────────────────────────────────────────────────

function makeIssue(key: string, overrides?: Partial<WatchIssue>): WatchIssue {
  return {
    issueKey: key,
    projectId: "test-project",
    factoryState: "implementing",
    blockedByCount: 0,
    blockedByKeys: [],
    readyForExecution: false,
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

const RECEIVED_AT = 1_711_620_000_000;

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
  const state = reduce(initialWatchState, { type: "issues-snapshot", issues, receivedAt: RECEIVED_AT });
  assert.equal(state.issues.length, 2);
  assert.equal(state.lastServerMessageAt, RECEIVED_AT);
});

test("issues-snapshot clamps selectedIndex when list shrinks", () => {
  const initial = stateWith({
    issues: [makeIssue("USE-1"), makeIssue("USE-2"), makeIssue("USE-3")],
    selectedIndex: 2,
  });
  const state = reduce(initial, { type: "issues-snapshot", issues: [makeIssue("USE-1")], receivedAt: RECEIVED_AT });
  assert.equal(state.selectedIndex, 0);
});

test("stream-heartbeat updates freshness without mutating issues", () => {
  const initial = stateWith({ issues: [makeIssue("USE-1")] });
  const state = reduce(initial, { type: "stream-heartbeat", receivedAt: RECEIVED_AT });
  assert.equal(state.lastServerMessageAt, RECEIVED_AT);
  assert.deepEqual(state.issues, initial.issues);
});

// ─── Selection ────────────────────────────────────────────────────

test("select clamps to valid range", () => {
  const initial = stateWith({
    issues: [makeIssue("USE-1"), makeIssue("USE-2"), makeIssue("USE-3")],
  });
  assert.equal(reduce(initial, { type: "select", index: 1 }).selectedIndex, 1);
  assert.equal(reduce(initial, { type: "select", index: 10 }).selectedIndex, 2);
  assert.equal(reduce(initial, { type: "select", index: -1 }).selectedIndex, 0);
});

// ─── View Transitions ─────────────────────────────────────────────

test("enter-detail switches to detail view and clears timeline", () => {
  const state = reduce(initialWatchState, { type: "enter-detail", issueKey: "USE-74" });
  assert.equal(state.view, "detail");
  assert.equal(state.activeDetailKey, "USE-74");
  assert.deepEqual(state.timeline, []);
});

test("exit-detail returns to list view and clears timeline", () => {
  const initial = stateWith({ view: "detail", activeDetailKey: "USE-74" });
  const state = reduce(initial, { type: "exit-detail" });
  assert.equal(state.view, "list");
  assert.equal(state.activeDetailKey, null);
});

test("enter-feed switches to feed view and clears detail state", () => {
  const initial = stateWith({ view: "detail", activeDetailKey: "USE-74" });
  const state = reduce(initial, { type: "enter-feed" });
  assert.equal(state.view, "feed");
  assert.equal(state.activeDetailKey, null);
});

test("exit-feed returns to list view", () => {
  const initial = stateWith({ view: "feed" });
  const state = reduce(initial, { type: "exit-feed" });
  assert.equal(state.view, "list");
});

test("detail-navigate cycles through filtered issues", () => {
  const issues = [makeIssue("USE-1"), makeIssue("USE-2"), makeIssue("USE-3")];
  const initial = stateWith({ view: "detail", activeDetailKey: "USE-1", issues });

  const next = reduce(initial, { type: "detail-navigate", direction: "next", filtered: issues });
  assert.equal(next.activeDetailKey, "USE-2");

  const prev = reduce(initial, { type: "detail-navigate", direction: "prev", filtered: issues });
  assert.equal(prev.activeDetailKey, "USE-3"); // wraps around
});

test("detail-navigate wraps forward from last to first", () => {
  const issues = [makeIssue("USE-1"), makeIssue("USE-2")];
  const initial = stateWith({ view: "detail", activeDetailKey: "USE-2", issues });
  const state = reduce(initial, { type: "detail-navigate", direction: "next", filtered: issues });
  assert.equal(state.activeDetailKey, "USE-1");
});

test("detail-navigate is no-op with empty list", () => {
  const initial = stateWith({ view: "detail", activeDetailKey: "USE-1" });
  const state = reduce(initial, { type: "detail-navigate", direction: "next", filtered: [] });
  assert.equal(state.activeDetailKey, "USE-1");
});

test("detail-navigate clears timeline for rehydration", () => {
  const issues = [makeIssue("USE-1"), makeIssue("USE-2")];
  const initial = stateWith({
    view: "detail",
    activeDetailKey: "USE-1",
    issues,
    timeline: [{ id: "t1", at: "2026-03-25T10:00:00.000Z", kind: "feed" as const }],
  });
  const state = reduce(initial, { type: "detail-navigate", direction: "next", filtered: issues });
  assert.deepEqual(state.timeline, []);
});

// ─── Feed Event → Detail Timeline Only ────────────────────────────

test("feed-event does not mutate issue list state", () => {
  const initial = stateWith({ issues: [makeIssue("USE-74")] });
  const event = makeFeedEvent({ id: 1, kind: "stage", issueKey: "USE-74", stage: "done" });
  const state = reduce(initial, { type: "feed-event", event, receivedAt: RECEIVED_AT });
  assert.deepEqual(state.issues, initial.issues);
  assert.equal(state.lastServerMessageAt, RECEIVED_AT);
});

test("feed-event for unknown issue is a no-op", () => {
  const initial = stateWith({ issues: [makeIssue("USE-74")] });
  const event = makeFeedEvent({ id: 2, kind: "stage", issueKey: "USE-999", stage: "done" });
  const state = reduce(initial, { type: "feed-event", event, receivedAt: RECEIVED_AT });
  assert.deepEqual(state.issues, initial.issues);
  assert.equal(state.lastServerMessageAt, RECEIVED_AT);
});

test("feed-event appends to timeline when in detail view", () => {
  const initial = stateWith({
    issues: [makeIssue("USE-74")],
    view: "detail",
    activeDetailKey: "USE-74",
  });
  const event = makeFeedEvent({ id: 3, kind: "stage", issueKey: "USE-74", status: "starting", summary: "Run started" });
  const state = reduce(initial, { type: "feed-event", event, receivedAt: RECEIVED_AT });
  assert.equal(state.timeline.length, 1);
  assert.equal(state.timeline[0]?.kind, "feed");
});

test("computeAggregates counts blocked and ready issues separately", () => {
  const issues = [
    makeIssue("USE-1", { blockedByCount: 1, blockedByKeys: ["USE-0"], factoryState: "delegated" }),
    makeIssue("USE-2", { readyForExecution: true, pendingRunType: "implementation", factoryState: "delegated" }),
    makeIssue("USE-3", { activeRunType: "implementation" }),
  ];

  const aggregates = computeAggregates(issues);
  assert.equal(aggregates.blocked, 1);
  assert.equal(aggregates.ready, 1);
  assert.equal(aggregates.active, 1);
});

test("computeAggregates does not count terminal issues as ready even if stale ready flags linger", () => {
  const issues = [
    makeIssue("USE-1", {
      sessionState: "done",
      factoryState: "done",
      readyForExecution: true,
    }),
    makeIssue("USE-2", {
      sessionState: "failed",
      factoryState: "failed",
      readyForExecution: true,
    }),
  ];

  const aggregates = computeAggregates(issues);
  assert.equal(aggregates.ready, 0);
  assert.equal(aggregates.done, 1);
  assert.equal(aggregates.failed, 1);
});

test("feed-event aggregates CI checks in timeline", () => {
  const initial = stateWith({
    issues: [makeIssue("USE-74")],
    view: "detail",
    activeDetailKey: "USE-74",
  });
  let state = reduce(initial, { type: "feed-event", receivedAt: RECEIVED_AT, event: makeFeedEvent({
    id: 10, kind: "github", status: "check_passed", issueKey: "USE-74", detail: "Lint",
    at: "2026-03-25T10:19:00.000Z",
  })});
  state = reduce(state, { type: "feed-event", receivedAt: RECEIVED_AT + 1_000, event: makeFeedEvent({
    id: 11, kind: "github", status: "check_failed", issueKey: "USE-74", detail: "Tests",
    at: "2026-03-25T10:19:05.000Z",
  })});
  state = reduce(state, { type: "feed-event", receivedAt: RECEIVED_AT + 2_000, event: makeFeedEvent({
    id: 12, kind: "github", status: "check_passed", issueKey: "USE-74", detail: "Build",
    at: "2026-03-25T10:19:10.000Z",
  })});

  // Should aggregate into a single ci-checks entry
  const ciEntries = state.timeline.filter((e) => e.kind === "ci-checks");
  assert.equal(ciEntries.length, 1);
  assert.equal(ciEntries[0]?.ciChecks?.checks.length, 3);
  assert.equal(ciEntries[0]?.ciChecks?.overall, "failed");
});

test("feed-event branch_not_advanced stays in timeline/history only", () => {
  const initial = stateWith({
    issues: [makeIssue("USE-74", { factoryState: "repairing_ci" })],
    view: "detail",
    activeDetailKey: "USE-74",
  });
  const event = makeFeedEvent({
    id: 13,
    kind: "turn",
    issueKey: "USE-74",
    status: "branch_not_advanced",
    summary: "Repair finished but PR #74 is still on failing head deadbeef",
  });
  const state = reduce(initial, { type: "feed-event", event, receivedAt: RECEIVED_AT });
  assert.equal(state.issues[0]?.statusNote, undefined);
  assert.equal(state.timeline.at(-1)?.kind, "feed");
});

// ─── Timeline Rehydration ─────────────────────────────────────────

test("timeline-rehydrate builds entries from runs and feed events", () => {
  const runs: TimelineRunInput[] = [{
    id: 1,
    runType: "implementation",
    status: "completed",
    startedAt: "2026-03-25T10:00:00.000Z",
    endedAt: "2026-03-25T10:05:00.000Z",
    report: {
      runType: "implementation",
      status: "completed",
      prompt: "",
      assistantMessages: ["Done"],
      plans: [],
      reasoning: [],
      commands: [{ command: "npm test", cwd: "/tmp", status: "completed", exitCode: 0 }],
      fileChanges: [],
      toolCalls: [],
      eventCounts: {},
    },
  }];
  const feedEvents: OperatorFeedEvent[] = [
    makeFeedEvent({ id: 1, kind: "stage", status: "starting", summary: "Starting", at: "2026-03-25T10:00:00.000Z", issueKey: "USE-74" }),
    makeFeedEvent({ id: 2, kind: "stage", status: "completed", summary: "Completed", at: "2026-03-25T10:05:00.000Z", issueKey: "USE-74" }),
  ];

  const state = reduce(initialWatchState, {
    type: "timeline-rehydrate",
    runs,
    feedEvents,
    liveThread: null,
    activeRunId: null,
    issueContext: null,
  });

  assert.ok(state.timeline.length > 0);
  // Should have run-start, items from report, run-end, and feed events
  const kinds = state.timeline.map((e) => e.kind);
  assert.ok(kinds.includes("run-start"));
  assert.ok(kinds.includes("run-end"));
  assert.ok(kinds.includes("item"));
  assert.ok(kinds.includes("feed"));
});

test("timeline-rehydrate tolerates live threads without a turns array", () => {
  const state = reduce(initialWatchState, {
    type: "timeline-rehydrate",
    runs: [],
    feedEvents: [],
    liveThread: {
      id: "thread-1",
      preview: "",
      cwd: "/tmp",
      status: "running",
      turns: undefined as unknown as never[],
    },
    activeRunId: 42,
    issueContext: null,
  });

  assert.deepEqual(state.timeline, []);
});

test("timeline-rehydrate sets activeRunId and startedAt", () => {
  const runs: TimelineRunInput[] = [{
    id: 42,
    runType: "ci_repair",
    status: "running",
    startedAt: "2026-03-25T10:10:00.000Z",
  }];

  const state = reduce(initialWatchState, {
    type: "timeline-rehydrate",
    runs,
    feedEvents: [],
    liveThread: null,
    activeRunId: 42,
    issueContext: null,
  });

  assert.equal(state.activeRunId, 42);
  assert.equal(state.activeRunStartedAt, "2026-03-25T10:10:00.000Z");
});

// ─── Codex Notification → Timeline ────────────────────────────────

test("item/started appends item to timeline", () => {
  const initial = stateWith({ activeRunId: 1 });
  const state = reduce(initial, {
    type: "codex-notification",
    method: "item/started",
    params: { item: { id: "item_1", type: "agentMessage", status: "inProgress", text: "Hello" } },
  });
  assert.equal(state.timeline.length, 1);
  assert.equal(state.timeline[0]?.item?.type, "agentMessage");
});

test("item/completed updates item in timeline", () => {
  const initial = stateWith({
    timeline: [{
      id: "live-item_1",
      at: "2026-03-25T10:00:00.000Z",
      kind: "item",
      item: { id: "item_1", type: "commandExecution", status: "inProgress", command: "npm test" },
    }],
  });
  const state = reduce(initial, {
    type: "codex-notification",
    method: "item/completed",
    params: { item: { id: "item_1", status: "completed", exitCode: 0, durationMs: 1500 } },
  });
  assert.equal(state.timeline[0]?.item?.status, "completed");
  assert.equal(state.timeline[0]?.item?.exitCode, 0);
});

test("item/agentMessage/delta appends text to timeline item", () => {
  const initial = stateWith({
    timeline: [{
      id: "live-item_1",
      at: "2026-03-25T10:00:00.000Z",
      kind: "item",
      item: { id: "item_1", type: "agentMessage", status: "inProgress" },
    }],
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
  assert.equal(state.timeline[0]?.item?.text, "Hello world");
});

test("item/commandExecution/outputDelta appends output", () => {
  const initial = stateWith({
    timeline: [{
      id: "live-item_1",
      at: "2026-03-25T10:00:00.000Z",
      kind: "item",
      item: { id: "item_1", type: "commandExecution", status: "inProgress", command: "npm test" },
    }],
  });
  const state = reduce(initial, {
    type: "codex-notification",
    method: "item/commandExecution/outputDelta",
    params: { itemId: "item_1", delta: "PASS\n" },
  });
  assert.equal(state.timeline[0]?.item?.output, "PASS\n");
});

// ─── Metadata Notifications ───────────────────────────────────────

test("turn/plan/updated sets plan metadata", () => {
  const state = reduce(initialWatchState, {
    type: "codex-notification",
    method: "turn/plan/updated",
    params: { plan: [{ step: "Read code", status: "completed" }, { step: "Write tests", status: "inProgress" }] },
  });
  assert.equal(state.plan?.length, 2);
  assert.equal(state.plan?.[0]?.status, "completed");
});

test("turn/diff/updated sets diff summary", () => {
  const diff = "--- a/f.ts\n+++ b/f.ts\n@@ -1 +1,2 @@\n-old\n+new\n+added";
  const state = reduce(initialWatchState, {
    type: "codex-notification",
    method: "turn/diff/updated",
    params: { diff },
  });
  assert.equal(state.diffSummary?.filesChanged, 1);
  assert.equal(state.diffSummary?.linesAdded, 2);
  assert.equal(state.diffSummary?.linesRemoved, 1);
});

test("thread/tokenUsage/updated sets token usage", () => {
  const state = reduce(initialWatchState, {
    type: "codex-notification",
    method: "thread/tokenUsage/updated",
    params: { usage: { inputTokens: 12400, outputTokens: 3200 } },
  });
  assert.equal(state.tokenUsage?.inputTokens, 12400);
  assert.equal(state.tokenUsage?.outputTokens, 3200);
});

// ─── Follow Mode ──────────────────────────────────────────────────

test("toggle-follow flips follow state", () => {
  const s1 = reduce(initialWatchState, { type: "toggle-follow" });
  assert.equal(s1.follow, false);
  const s2 = reduce(s1, { type: "toggle-follow" });
  assert.equal(s2.follow, true);
});


// ─── Timeline Builder ─────────────────────────────────────────────

test("buildTimelineFromRehydration sorts entries chronologically", () => {
  const runs: TimelineRunInput[] = [{
    id: 1,
    runType: "implementation",
    status: "completed",
    startedAt: "2026-03-25T10:00:00.000Z",
    endedAt: "2026-03-25T10:05:00.000Z",
  }];
  const feedEvents: OperatorFeedEvent[] = [
    makeFeedEvent({ id: 1, at: "2026-03-25T09:59:00.000Z", kind: "stage", summary: "Delegated" }),
    makeFeedEvent({ id: 2, at: "2026-03-25T10:06:00.000Z", kind: "stage", summary: "PR opened" }),
  ];

  const timeline = buildTimelineFromRehydration(runs, feedEvents, null, null);
  const timestamps = timeline.map((e) => e.at);
  for (let i = 1; i < timestamps.length; i++) {
    assert.ok(timestamps[i]! >= timestamps[i - 1]!, `${timestamps[i]} should be >= ${timestamps[i - 1]}`);
  }
});

test("buildTimelineFromRehydration aggregates CI checks from feed", () => {
  const feedEvents: OperatorFeedEvent[] = [
    makeFeedEvent({ id: 1, at: "2026-03-25T10:19:00.000Z", kind: "github", status: "check_passed", detail: "Lint" }),
    makeFeedEvent({ id: 2, at: "2026-03-25T10:19:05.000Z", kind: "github", status: "check_failed", detail: "Tests" }),
    makeFeedEvent({ id: 3, at: "2026-03-25T10:19:10.000Z", kind: "github", status: "check_passed", detail: "Build" }),
  ];

  const timeline = buildTimelineFromRehydration([], feedEvents, null, null);
  const ciEntries = timeline.filter((e) => e.kind === "ci-checks");
  assert.equal(ciEntries.length, 1);
  assert.equal(ciEntries[0]?.ciChecks?.checks.length, 3);
  assert.equal(ciEntries[0]?.ciChecks?.overall, "failed");
});

test("buildTimelineFromRehydration replays completed run items from persisted thread events", () => {
  const runs: TimelineRunInput[] = [{
    id: 7,
    runType: "implementation",
    status: "completed",
    startedAt: "2026-03-25T10:00:00.000Z",
    endedAt: "2026-03-25T10:05:00.000Z",
    events: [
      {
        id: 1,
        method: "item/started",
        createdAt: "2026-03-25T10:00:10.000Z",
        parsedEvent: {
          item: { id: "msg_1", type: "agentMessage", status: "inProgress" },
        },
      },
      {
        id: 2,
        method: "item/agentMessage/delta",
        createdAt: "2026-03-25T10:00:11.000Z",
        parsedEvent: { itemId: "msg_1", delta: "Working through the issue." },
      },
      {
        id: 3,
        method: "item/completed",
        createdAt: "2026-03-25T10:00:12.000Z",
        parsedEvent: {
          item: { id: "msg_1", type: "agentMessage", status: "completed" },
        },
      },
      {
        id: 4,
        method: "item/started",
        createdAt: "2026-03-25T10:00:20.000Z",
        parsedEvent: {
          item: { id: "cmd_1", type: "commandExecution", status: "inProgress", command: ["npm", "test"] },
        },
      },
      {
        id: 5,
        method: "item/commandExecution/outputDelta",
        createdAt: "2026-03-25T10:00:21.000Z",
        parsedEvent: { itemId: "cmd_1", delta: "PASS signals\n" },
      },
      {
        id: 6,
        method: "item/completed",
        createdAt: "2026-03-25T10:00:25.000Z",
        parsedEvent: {
          item: { id: "cmd_1", type: "commandExecution", status: "completed", exitCode: 0, durationMs: 5000 },
        },
      },
    ],
  }];

  const timeline = buildTimelineFromRehydration(runs, [], null, null);
  const items = timeline.filter((entry) => entry.kind === "item");

  assert.equal(items.length, 2);
  assert.equal(items[0]?.item?.id, "msg_1");
  assert.equal(items[0]?.item?.text, "Working through the issue.");
  assert.equal(items[0]?.item?.status, "completed");
  assert.equal(items[1]?.item?.id, "cmd_1");
  assert.equal(items[1]?.item?.command, "npm test");
  assert.equal(items[1]?.item?.output, "PASS signals\n");
  assert.equal(items[1]?.item?.exitCode, 0);
  assert.equal(items[1]?.item?.status, "completed");
});

test("buildTimelineRows sorts compact rows deterministically when timestamps match", () => {
  const timeline = buildTimelineFromRehydration(
    [{
      id: 2,
      runType: "implementation",
      status: "completed",
      startedAt: "2026-03-25T10:00:00.000Z",
      endedAt: "2026-03-25T10:00:05.000Z",
    }, {
      id: 1,
      runType: "review_fix",
      status: "completed",
      startedAt: "2026-03-25T10:00:00.000Z",
      endedAt: "2026-03-25T10:00:03.000Z",
    }],
    [],
    null,
    null,
  );

  const rows = buildTimelineRows(timeline, "compact").filter((row) => row.kind === "run");
  assert.equal(rows[0]?.id, "run-1");
  assert.equal(rows[1]?.id, "run-2");
});

test("buildTimelineRows hides queue handoff chatter and collapses repeated applied rows", () => {
  const timeline = buildTimelineFromRehydration(
    [],
    [
      makeFeedEvent({
        id: 1,
        at: "2026-03-25T10:00:00.000Z",
        kind: "stage",
        status: "reconciled",
        summary: "Reconciliation: awaiting_queue → awaiting_queue",
      }),
      makeFeedEvent({
        id: 2,
        at: "2026-03-25T10:00:01.000Z",
        kind: "queue",
        status: "queue_label_requested",
        summary: "Queue hand-off requested via label \"queue\" on PR #101",
      }),
      makeFeedEvent({
        id: 3,
        at: "2026-03-25T10:00:02.000Z",
        kind: "queue",
        status: "queue_label_applied",
        summary: "Queue label \"queue\" applied to PR #101",
      }),
      makeFeedEvent({
        id: 4,
        at: "2026-03-25T10:00:03.000Z",
        kind: "queue",
        status: "queue_label_requested",
        summary: "Queue hand-off requested via label \"queue\" on PR #101",
      }),
      makeFeedEvent({
        id: 5,
        at: "2026-03-25T10:00:04.000Z",
        kind: "queue",
        status: "queue_label_applied",
        summary: "Queue label \"queue\" applied to PR #101",
      }),
      makeFeedEvent({
        id: 6,
        at: "2026-03-25T10:00:05.000Z",
        kind: "github",
        status: "pr_merged",
        summary: "GitHub: pr_merged on PR #101",
      }),
    ],
    null,
    null,
  );

  const rows = buildTimelineRows(timeline, "compact").filter((row) => row.kind === "feed");
  assert.equal(rows.length, 2);
  assert.equal(rows[0]?.feed.status, "queue_label_applied");
  assert.equal(rows[0]?.repeatCount, 2);
  assert.equal(rows[0]?.at, "2026-03-25T10:00:04.000Z");
  assert.equal(rows[1]?.feed.status, "pr_merged");
});

test("buildTimelineRows keeps verbose runs focused on meaningful items", () => {
  const entries: TimelineEntry[] = [
    {
      id: "run-start-1",
      at: "2026-03-25T10:00:00.000Z",
      kind: "run-start",
      runId: 1,
      run: { runType: "implementation", status: "completed", startedAt: "2026-03-25T10:00:00.000Z", endedAt: "2026-03-25T10:05:00.000Z" },
    },
    {
      id: "item-1",
      at: "2026-03-25T10:00:10.000Z",
      kind: "item",
      runId: 1,
      item: { id: "msg-1", type: "agentMessage", status: "completed", text: "First progress update." },
    },
    {
      id: "item-2",
      at: "2026-03-25T10:00:20.000Z",
      kind: "item",
      runId: 1,
      item: { id: "msg-2", type: "agentMessage", status: "completed", text: "Final summary update." },
    },
    {
      id: "item-3",
      at: "2026-03-25T10:00:30.000Z",
      kind: "item",
      runId: 1,
      item: { id: "cmd-1", type: "commandExecution", status: "completed", command: "npm test", exitCode: 0 },
    },
    {
      id: "run-end-1",
      at: "2026-03-25T10:05:00.000Z",
      kind: "run-end",
      runId: 1,
      run: { runType: "implementation", status: "completed", startedAt: "2026-03-25T10:00:00.000Z", endedAt: "2026-03-25T10:05:00.000Z" },
    },
  ];

  const rows = buildTimelineRows(entries);
  const runRow = rows.find((row) => row.kind === "run");
  assert.ok(runRow && runRow.kind === "run");
  // Items are now always inlined from the run accumulator
  assert.ok(runRow.items.length >= 2, "run should include items");
});

// ─── Feed Events ─────────────────────────────────────────────

test("feed-snapshot sets feed events", () => {
  const events = [makeFeedEvent({ id: 1 }), makeFeedEvent({ id: 2 })];
  const state = reduce(initialWatchState, { type: "feed-snapshot", events });
  assert.equal(state.feedEvents.length, 2);
});

test("feed-new-event appends to feed events", () => {
  const initial = stateWith({ feedEvents: [makeFeedEvent({ id: 1 })] });
  const state = reduce(initial, { type: "feed-new-event", event: makeFeedEvent({ id: 2 }) });
  assert.equal(state.feedEvents.length, 2);
});

// ─── Aggregates ──────────────────────────────────────────────

test("computeAggregates counts active, done, failed", () => {
  const issues = [
    makeIssue("USE-1", { factoryState: "implementing", activeRunType: "implementation" }),
    makeIssue("USE-2", { factoryState: "delegated", sessionState: "done" }),
    makeIssue("USE-3", { factoryState: "implementing", sessionState: "failed" }),
    makeIssue("USE-4", { factoryState: "escalated" }),
    makeIssue("USE-5", { factoryState: "pr_open" }),
    makeIssue("USE-6", { factoryState: "implementing", activeRunType: "implementation" }),
  ];
  const agg = computeAggregates(issues);
  assert.equal(agg.active, 2);
  assert.equal(agg.done, 1);
  assert.equal(agg.failed, 2); // failed + escalated
  assert.equal(agg.total, 6);
});

test("computeAggregates returns zeros for empty list", () => {
  const agg = computeAggregates([]);
  assert.deepEqual(agg, { active: 0, blocked: 0, ready: 0, done: 0, failed: 0, total: 0 });
});

// ─── Timeline Rehydration with Issue Context ─────────────────

test("timeline-rehydrate stores issueContext", () => {
  const ctx = {
    description: "Fix the widget",
    currentLinearState: "In Progress",
    priority: 2,
    estimate: 3,
    ciRepairAttempts: 0,
    queueRepairAttempts: 0,
    reviewFixAttempts: 0,
    runCount: 1,
  };
  const state = reduce(initialWatchState, {
    type: "timeline-rehydrate",
    runs: [],
    feedEvents: [],
    liveThread: null,
    activeRunId: null,
    issueContext: ctx,
  });
  assert.equal(state.issueContext?.description, "Fix the widget");
  assert.equal(state.issueContext?.priority, 2);
  assert.equal(state.issueContext?.estimate, 3);
});

// ─── Immutability ─────────────────────────────────────────────────

test("codex-notification does not mutate original timeline", () => {
  const timeline = [{
    id: "live-item_1",
    at: "2026-03-25T10:00:00.000Z",
    kind: "item" as const,
    item: { id: "item_1", type: "agentMessage", status: "inProgress" },
  }];
  const initial = stateWith({ timeline });
  reduce(initial, {
    type: "codex-notification",
    method: "item/agentMessage/delta",
    params: { itemId: "item_1", delta: "new text" },
  });
  assert.equal(initial.timeline[0]?.item?.text, undefined);
});
