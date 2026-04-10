import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { PatchRelayDatabase } from "../src/db.ts";
import { IssueQueryService } from "../src/issue-query-service.ts";

test("getPublicAgentSessionStatus returns summarized run history for session-backed issues", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-issue-query-"));
  try {
    const db = new PatchRelayDatabase(path.join(baseDir, "patchrelay.sqlite"), true);
    db.runMigrations();

    const issue = db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-1",
      issueKey: "USE-1",
      title: "Summarize public session status",
      currentLinearState: "In Review",
      currentLinearStateType: "started",
      factoryState: "awaiting_queue",
      prNumber: 42,
      prUrl: "https://github.example/pr/42",
      prState: "open",
      prReviewState: "approved",
      prCheckStatus: "pending",
      queueRepairAttempts: 2,
      ciRepairAttempts: 1,
    });

    const run = db.runs.createRun({
      issueId: issue.id,
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      runType: "implementation",
      promptText: "Implement the flow",
    });
    db.runs.finishRun(run.id, {
      status: "completed",
      reportJson: JSON.stringify({
        runType: "implementation",
        status: "completed",
        prompt: "Implement the flow",
        assistantMessages: ["Implemented the public status payload."],
        plans: [],
        reasoning: [],
        commands: [{ command: "npm test", cwd: "/repo", status: "completed", exitCode: 0, durationMs: 100 }],
        fileChanges: [{ path: "src/app.ts" }],
        toolCalls: [{ type: "dynamic", name: "web.search", status: "completed", durationMs: 12 }],
        eventCounts: {},
      }),
    });

    const query = new IssueQueryService(
      db,
      { readThread: async () => ({ id: "thread-1", preview: "", cwd: "", status: "completed", turns: [] }) } as never,
      { getActiveRunStatus: async () => undefined },
    );

    const status = await query.getPublicAgentSessionStatus("USE-1");
    assert.ok(status);
    assert.equal(status?.issue.issueKey, "USE-1");
    assert.equal(status?.issue.prNumber, 42);
    assert.equal(status?.issue.prState, "open");
    assert.equal(status?.issue.prReviewState, "approved");
    assert.equal(status?.issue.prCheckStatus, "pending");
    assert.equal(status?.runs.length, 1);
    assert.equal(status?.runs[0]?.run.runType, "implementation");
    assert.deepEqual(status?.latestReportSummary, {
      assistantMessageCount: 1,
      commandCount: 1,
      fileChangeCount: 1,
      toolCallCount: 1,
      latestAssistantMessage: "Implemented the public status payload.",
    });
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("getPublicAgentSessionStatus returns undefined when the issue is unknown", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-issue-query-missing-"));
  try {
    const db = new PatchRelayDatabase(path.join(baseDir, "patchrelay.sqlite"), true);
    db.runMigrations();

    const query = new IssueQueryService(
      db,
      { readThread: async () => ({ id: "thread-1", preview: "", cwd: "", status: "completed", turns: [] }) } as never,
      { getActiveRunStatus: async () => undefined },
    );

    assert.equal(await query.getPublicAgentSessionStatus("USE-404"), undefined);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});
