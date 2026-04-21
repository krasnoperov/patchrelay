import assert from "node:assert/strict";
import test from "node:test";
import { buildPatchRelayQueueObservations, buildPatchRelayStateGraph } from "../src/cli/watch/state-visualization.ts";
import type { StateHistoryNode } from "../src/cli/watch/history-builder.ts";
import type { OperatorFeedEvent } from "../src/operator-feed.ts";
import type { WatchIssue } from "../src/cli/watch/watch-state.ts";

function makeIssue(overrides?: Partial<WatchIssue>): WatchIssue {
  return {
    issueKey: "USE-88",
    projectId: "proj-1",
    factoryState: "awaiting_queue",
    blockedByCount: 0,
    blockedByKeys: [],
    readyForExecution: false,
    prNumber: 88,
    prReviewState: "approved",
    updatedAt: "2026-03-28T12:00:00.000Z",
    ...overrides,
  };
}

function makeEvent(overrides: Partial<OperatorFeedEvent>): OperatorFeedEvent {
  return {
    id: 1,
    at: "2026-03-28T12:00:00.000Z",
    level: "info",
    kind: "github",
    summary: "test event",
    ...overrides,
  };
}

test("patchrelay graph marks visited side trips and current node", () => {
  const history: StateHistoryNode[] = [
    {
      state: "implementing",
      enteredAt: "2026-03-28T11:00:00.000Z",
      isCurrent: false,
      runs: [],
      sideTrips: [],
    },
    {
      state: "pr_open",
      enteredAt: "2026-03-28T11:10:00.000Z",
      isCurrent: false,
      runs: [],
      sideTrips: [{
        state: "changes_requested",
        enteredAt: "2026-03-28T11:20:00.000Z",
        returnState: "awaiting_queue",
        returnedAt: "2026-03-28T11:30:00.000Z",
        runs: [],
      }],
    },
    {
      state: "awaiting_queue",
      enteredAt: "2026-03-28T11:30:00.000Z",
      isCurrent: true,
      runs: [],
      sideTrips: [],
    },
  ];

  const graph = buildPatchRelayStateGraph(history, "awaiting_queue");

  assert.equal(graph.main.find((node) => node.state === "awaiting_queue")?.status, "current");
  assert.equal(graph.main.find((node) => node.state === "implementing")?.status, "visited");
  assert.equal(graph.prLoops.find((node) => node.state === "changes_requested")?.status, "visited");
  assert.equal(graph.exits.find((node) => node.state === "failed")?.status, "upcoming");
});

test("patchrelay queue observations report handoff and external queue failure", () => {
  const issue = makeIssue({ factoryState: "repairing_queue", activeRunType: "queue_repair" });
  const events: OperatorFeedEvent[] = [
    makeEvent({
      id: 1,
      status: "queue_repair_queued",
      stage: "repairing_queue",
      summary: "Queue repair queued after external failure from merge-steward/queue",
    }),
    makeEvent({
      id: 2,
      status: "check_failed",
      stage: "repairing_queue",
      summary: "GitHub: check_failed on PR #88",
      detail: "merge-steward/queue",
      at: "2026-03-28T12:05:00.000Z",
    }),
  ];

  const observations = buildPatchRelayQueueObservations(issue, events);

  assert.equal(observations[0]?.text, "PatchRelay is actively repairing a queue eviction.");
  assert.match(observations[1]?.text ?? "", /External queue reported failure/);
  assert.match(observations[2]?.text ?? "", /Tracked PR: #88/);
});

test("patchrelay queue observations prefer session state and waiting reason", () => {
  const issue = makeIssue({
    factoryState: "awaiting_queue",
    sessionState: "waiting_input",
    waitingReason: "Waiting for the next instruction.",
  });

  const observations = buildPatchRelayQueueObservations(issue, []);

  assert.equal(observations[0]?.tone, "warn");
  assert.equal(observations[0]?.text, "Waiting for the next instruction.");
  assert.match(observations[1]?.text ?? "", /No downstream queue signal/);
});

test("patchrelay queue observations report merge completion", () => {
  const issue = makeIssue({ factoryState: "done" });
  const observations = buildPatchRelayQueueObservations(issue, [
    makeEvent({ status: "pr_merged", summary: "GitHub: pr_merged on PR #88" }),
  ]);

  assert.equal(observations[0]?.tone, "success");
  assert.match(observations[1]?.text ?? "", /merged/i);
});

test("patchrelay queue observations show closed PRs as historical", () => {
  const issue = makeIssue({
    factoryState: "done",
    delegatedToPatchRelay: true,
    prState: "closed",
    prReviewState: "commented",
  });

  const observations = buildPatchRelayQueueObservations(issue, []);

  assert.match(observations[1]?.text ?? "", /Previous PR: #88 \(closed\) \(commented\)/);
});

test("patchrelay queue observations show closed PR replacement work explicitly", () => {
  const issue = makeIssue({
    factoryState: "implementing",
    delegatedToPatchRelay: true,
    prState: "closed",
    prReviewState: "commented",
  });

  const observations = buildPatchRelayQueueObservations(issue, []);

  assert.match(observations[1]?.text ?? "", /Previous PR: #88 \(closed; replacement pending\) \(commented\)/);
});
