import assert from "node:assert/strict";
import test from "node:test";
import type { TimelineEntry } from "../src/cli/watch/timeline-builder.ts";
import {
  buildWatchDetailExportText,
  findLastAssistantMessage,
  findLastCommand,
  findLastCommandOutput,
} from "../src/cli/watch/watch-actions.ts";

const timeline: TimelineEntry[] = [
  {
    id: "run-start-1",
    at: "2026-03-25T10:00:00.000Z",
    kind: "run-start",
    runId: 1,
    run: { runType: "implementation", status: "running", startedAt: "2026-03-25T10:00:00.000Z" },
  },
  {
    id: "item-msg-1",
    at: "2026-03-25T10:00:01.000Z",
    kind: "item",
    runId: 1,
    item: { id: "msg-1", type: "agentMessage", status: "completed", text: "Earlier note." },
  },
  {
    id: "item-cmd-1",
    at: "2026-03-25T10:00:02.000Z",
    kind: "item",
    runId: 1,
    item: { id: "cmd-1", type: "commandExecution", status: "completed", command: "npm test", output: "PASS old\n" },
  },
  {
    id: "item-msg-2",
    at: "2026-03-25T10:00:03.000Z",
    kind: "item",
    runId: 1,
    item: { id: "msg-2", type: "agentMessage", status: "inProgress", text: "Latest assistant update." },
  },
  {
    id: "item-cmd-2",
    at: "2026-03-25T10:00:04.000Z",
    kind: "item",
    runId: 1,
    item: { id: "cmd-2", type: "commandExecution", status: "inProgress", command: "npm test -- watch", output: "PASS updated\n" },
  },
];

test("watch action selectors find the latest assistant and command context", () => {
  assert.equal(findLastAssistantMessage(timeline), "Latest assistant update.");
  assert.equal(findLastCommand(timeline), "npm test -- watch");
  assert.equal(findLastCommandOutput(timeline), "PASS updated\n");
});

test("buildWatchDetailExportText renders the current detail surface as plain text", () => {
  const text = buildWatchDetailExportText({
    issue: {
      issueKey: "USE-17",
      projectId: "test-project",
      title: "Stabilize transcript view",
      factoryState: "implementing",
      blockedByCount: 0,
      blockedByKeys: [],
      readyForExecution: false,
      updatedAt: "2026-03-25T10:00:00.000Z",
      activeRunType: "implementation",
    },
    timeline,
    activeRunStartedAt: "2026-03-25T10:00:00.000Z",
    activeRunId: 1,
    tokenUsage: null,
    diffSummary: null,
    plan: null,
    issueContext: null,
    detailTab: "timeline",
    rawRuns: [],
    rawFeedEvents: [],
    follow: true,
    connected: true,
    lastServerMessageAt: Date.now(),
    width: 100,
  });

  assert.match(text, /USE-17/);
  assert.match(text, /Stabilize transcript view/);
  assert.match(text, /Latest assistant update\./);
  assert.match(text, /\$ npm test -- watch/);
});
