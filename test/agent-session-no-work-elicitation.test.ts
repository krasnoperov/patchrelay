import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import pino from "pino";
import { PatchRelayDatabase } from "../src/db.ts";
import { AgentSessionHandler } from "../src/webhooks/agent-session-handler.ts";
import type { AppConfig } from "../src/types.ts";
import type { NormalizedEvent } from "../src/linear-types.ts";

const PROJECT = "inventory";

async function run(active: boolean): Promise<Array<{ content: { type: string; body?: string } }>> {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-no-work-"));
  try {
    const db = new PatchRelayDatabase(path.join(baseDir, "patchrelay.sqlite"), false);
    db.runMigrations();
    const issue = db.upsertIssue({
      projectId: PROJECT,
      linearIssueId: "issue-1",
      issueKey: "INV-14",
      delegatedToPatchRelay: true,
    });
    if (active) {
      const workflowRun = db.runs.createRun({
        issueId: issue.id,
        projectId: PROJECT,
        linearIssueId: issue.linearIssueId,
        runType: "implementation",
      });
      db.upsertIssue({ projectId: PROJECT, linearIssueId: issue.linearIssueId, activeRunId: workflowRun.id });
    }

    const activities: Array<{ content: { type: string; body?: string } }> = [];
    const linear = { createAgentActivity: async (activity: { content: { type: string; body?: string } }) => { activities.push(activity); } };
    const handler = new AgentSessionHandler(
      {} as AppConfig,
      db,
      { forProject: async () => linear } as never,
      {} as never,
      {} as never,
      pino({ level: "silent" }),
    );
    await handler.handle({
      normalized: {
        triggerEvent: "agentSessionCreated",
        agentSession: { id: "sess-1" },
        issue: { id: "issue-1", identifier: "INV-14" },
      } as unknown as NormalizedEvent,
      project: { id: PROJECT } as never,
      trackedIssue: db.getIssue(PROJECT, "issue-1"),
      runnableTaskRunType: active ? undefined : "implementation",
      delegated: true,
      peekRunnableWorkflowTaskRunType: () => active ? undefined : "implementation",
      isDirectReplyToOutstandingQuestion: () => false,
    });
    return activities;
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
}

test("an active run does not get the misleading no-work nudge", async () => {
  const bodies = (await run(true)).map((activity) => activity.content.body ?? "");
  assert.ok(!bodies.some((body) => body.includes("no work is queued")));
});

test("a delegated runnable task is not nudged synchronously on session creation", async () => {
  const bodies = (await run(false)).map((activity) => activity.content.body ?? "");
  assert.ok(!bodies.some((body) => body.includes("no work is queued")));
});
