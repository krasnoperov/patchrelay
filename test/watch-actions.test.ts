import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import test from "node:test";
import type { TimelineEntry } from "../src/cli/watch/timeline-builder.ts";
import {
  buildWatchDetailExportText,
  exportWatchTextToTempFile,
  findLastAssistantMessage,
  findLastCommand,
  findLastCommandOutput,
  openTextInPager,
  writeTextToClipboard,
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
    width: 100,
  });

  assert.match(text, /USE-17/);
  assert.match(text, /Stabilize transcript view/);
  assert.match(text, /Latest assistant update\./);
  assert.match(text, /\$ npm test -- watch/);
});

test("writeTextToClipboard refuses empty text and non-TTY streams", () => {
  const writes: string[] = [];
  const ttyStream = {
    isTTY: true,
    write(chunk: string) {
      writes.push(chunk);
      return true;
    },
  } as NodeJS.WriteStream;
  const nonTtyStream = {
    isTTY: false,
    write() {
      return true;
    },
  } as NodeJS.WriteStream;

  assert.equal(writeTextToClipboard("", ttyStream), false);
  assert.equal(writeTextToClipboard("copied text", nonTtyStream), false);
  assert.equal(writes.length, 0);
});

test("writeTextToClipboard writes OSC 52 payloads for interactive streams", () => {
  const writes: string[] = [];
  const ttyStream = {
    isTTY: true,
    write(chunk: string) {
      writes.push(chunk);
      return true;
    },
  } as NodeJS.WriteStream;

  assert.equal(writeTextToClipboard("copied text", ttyStream), true);
  assert.equal(writes.length, 1);
  assert.equal((writes[0] ?? "").startsWith("\u001b]52;c;"), true);
  assert.equal((writes[0] ?? "").endsWith("\u0007"), true);
});

test("exportWatchTextToTempFile writes transcript text to a sanitized path", () => {
  const filePath = exportWatchTextToTempFile("hello transcript\n", "USE/17:bad key");
  try {
    assert.match(filePath, /USE-17-bad-key-transcript\.txt$/);
    assert.equal(readFileSync(filePath, "utf8"), "hello transcript\n");
  } finally {
    rmSync(filePath, { force: true });
    rmSync(filePath.replace(/\/[^/]+$/, ""), { recursive: true, force: true });
  }
});

test("openTextInPager reports a clear reason when no interactive TTY is available", () => {
  const stream = {
    isTTY: false,
    write() {
      return true;
    },
  } as NodeJS.WriteStream;

  assert.deepEqual(openTextInPager("hello", stream), {
    ok: false,
    reason: "interactive TTY required",
  });
});
