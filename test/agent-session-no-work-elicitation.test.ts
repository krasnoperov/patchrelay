import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import pino from "pino";
import { PatchRelayDatabase } from "../src/db.ts";
import { AgentSessionHandler } from "../src/webhooks/agent-session-handler.ts";
import type { AppConfig, FactoryState } from "../src/types.ts";
import type { NormalizedEvent } from "../src/linear-types.ts";

const PROJECT = "inventory";

function run(factoryState: FactoryState, fn: (activities: Array<{ content: { type: string; body?: string } }>) => Promise<void>): Promise<void> {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-no-work-"));
  return (async () => {
    const db = new PatchRelayDatabase(path.join(baseDir, "patchrelay.sqlite"), false);
    db.runMigrations();
    db.upsertIssue({ projectId: PROJECT, linearIssueId: "issue-1", issueKey: "INV-14", factoryState, delegatedToPatchRelay: true } as never);

    const activities: Array<{ content: { type: string; body?: string } }> = [];
    const linear = { createAgentActivity: async (a: { content: { type: string; body?: string } }) => { activities.push(a); } };
    const handler = new AgentSessionHandler(
      {} as AppConfig,
      db,
      { forProject: async () => linear } as never,
      {} as never,
      {} as never,
      pino({ level: "silent" }),
    );

    const normalized = {
      triggerEvent: "agentSessionCreated",
      agentSession: { id: "sess-1" },
      issue: { id: "issue-1", identifier: "INV-14" },
    } as unknown as NormalizedEvent;

    await handler.handle({
      normalized,
      project: { id: PROJECT } as never,
      trackedIssue: undefined,
      runnableTaskRunType: undefined,
      delegated: true,
      peekRunnableWorkflowTaskRunType: () => undefined,
      isDirectReplyToOutstandingQuestion: () => false,
    });

    await fn(activities);
    rmSync(baseDir, { recursive: true, force: true });
  })();
}

test("an in-progress issue does not get the misleading 'no work queued' nudge", async () => {
  await run("implementing", async (activities) => {
    const bodies = activities.map((a) => a.content.body ?? "");
    assert.ok(!bodies.some((b) => b.includes("no work is queued")), "should not nudge while actively implementing");
  });
});

test("a delegated-but-idle issue is not nudged synchronously on session creation", async () => {
  await run("delegated", async (activities) => {
    const bodies = activities.map((a) => a.content.body ?? "");
    assert.ok(!bodies.some((b) => b.includes("no work is queued")), "creation can race task projection and must not conclude idle");
  });
});
