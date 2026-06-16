import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { PatchRelayDatabase } from "../src/db.ts";
import { LinearProgressReporter } from "../src/linear-progress-reporter.ts";
import type { LinearAgentActivityContent } from "../src/types.ts";

function createDatabase(): { baseDir: string; db: PatchRelayDatabase } {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-linear-progress-"));
  const db = new PatchRelayDatabase(path.join(baseDir, "patchrelay.sqlite"), true);
  db.runMigrations();
  return { baseDir, db };
}

test("progress reporter emits deduped ephemeral and durable root-cause updates", async () => {
  const { baseDir, db } = createDatabase();
  try {
    const issue = db.upsertIssue({
      projectId: "project-1",
      linearIssueId: "issue-1",
      issueKey: "TST-1",
      factoryState: "repairing_ci",
      delegatedToPatchRelay: true,
      agentSessionId: "session-1",
    });
    const run = db.runs.createRun({
      issueId: issue.id,
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      runType: "ci_repair",
    });
    db.upsertIssue({
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      activeRunId: run.id,
    });

    const emitted: Array<{ content: LinearAgentActivityContent; options?: { ephemeral?: boolean } }> = [];
    const reporter = new LinearProgressReporter(
      db,
      async (_issue, content, options) => {
        emitted.push({ content, options });
      },
    );

    const notification = {
      method: "item/completed",
      params: {
        item: {
          id: "item-1",
          type: "agentMessage",
          status: "completed",
          text: "Narrowed the CI failure to one React hook lint rule in GameRoundPage.tsx.",
        },
      },
    };

    reporter.maybeEmitProgress(notification, run);
    reporter.maybeEmitProgress(notification, run);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(emitted.length, 2);
    assert.deepEqual(emitted[0], {
      content: {
        type: "thought",
        body: "Narrowed the CI failure to one React hook lint rule in GameRoundPage.tsx.",
      },
      options: { ephemeral: true },
    });
    assert.deepEqual(emitted[1], {
      content: {
        type: "thought",
        body: "Narrowed the CI failure to one React hook lint rule in GameRoundPage.tsx.",
      },
      options: undefined,
    });
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("progress reporter retries once after a transient SQLite schema read error", async () => {
  const { baseDir, db } = createDatabase();
  try {
    const issue = db.upsertIssue({
      projectId: "project-1",
      linearIssueId: "issue-schema-retry",
      issueKey: "TST-SCHEMA",
      factoryState: "implementing",
      delegatedToPatchRelay: true,
      agentSessionId: "session-1",
    });
    const run = db.runs.createRun({
      issueId: issue.id,
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      runType: "implementation",
    });
    db.upsertIssue({
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      activeRunId: run.id,
    });

    const originalGetIssue = db.getIssue.bind(db);
    let lookupCount = 0;
    let schemaGuardCount = 0;
    const mutableDb = db as unknown as {
      getIssue: typeof db.getIssue;
      assertSchemaReady: typeof db.assertSchemaReady;
    };
    mutableDb.getIssue = ((projectId: string, linearIssueId: string) => {
      lookupCount += 1;
      if (lookupCount === 1) {
        throw new Error("no such table: issues");
      }
      return originalGetIssue(projectId, linearIssueId);
    }) as typeof db.getIssue;
    mutableDb.assertSchemaReady = () => {
      schemaGuardCount += 1;
    };

    const emitted: Array<{ content: LinearAgentActivityContent; options?: { ephemeral?: boolean } }> = [];
    const reporter = new LinearProgressReporter(
      db,
      async (_issue, content, options) => {
        emitted.push({ content, options });
      },
    );

    reporter.maybeEmitProgress({
      method: "item/completed",
      params: {
        item: {
          id: "item-1",
          type: "agentMessage",
          status: "completed",
          text: "Narrowed the UI failure to the library item processing state.",
        },
      },
    }, run);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(schemaGuardCount, 1);
    assert.equal(lookupCount, 2);
    assert.equal(emitted.length, 2);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("progress reporter emits verification and publishing history alongside active plan steps", async () => {
  const { baseDir, db } = createDatabase();
  try {
    const issue = db.upsertIssue({
      projectId: "project-1",
      linearIssueId: "issue-2",
      issueKey: "TST-2",
      factoryState: "implementing",
      delegatedToPatchRelay: true,
      agentSessionId: "session-2",
      prNumber: 64,
    });
    const run = db.runs.createRun({
      issueId: issue.id,
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      runType: "implementation",
    });
    db.upsertIssue({
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      activeRunId: run.id,
    });

    const emitted: Array<{ content: LinearAgentActivityContent; options?: { ephemeral?: boolean } }> = [];
    const reporter = new LinearProgressReporter(
      db,
      async (_issue, content, options) => {
        emitted.push({ content, options });
      },
    );

    reporter.maybeEmitProgress({
      method: "turn/plan/updated",
      params: {
        plan: [
          { step: "Run targeted verification before publishing", status: "in_progress" },
          { step: "Publish the repair to GitHub", status: "pending" },
        ],
      },
    }, run);
    reporter.maybeEmitProgress({
      method: "turn/plan/updated",
      params: {
        plan: [
          { step: "Run targeted verification before publishing", status: "in_progress" },
        ],
      },
    }, run);
    reporter.maybeEmitProgress({
      method: "turn/plan/updated",
      params: {
        plan: [
          { step: "Publish the repair to GitHub", status: "in_progress" },
        ],
      },
    }, run);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(emitted.length, 4);
    assert.deepEqual(emitted[0], {
      content: {
        type: "action",
        action: "Verifying",
        parameter: "targeted verification before publishing",
      },
      options: { ephemeral: true },
    });
    assert.deepEqual(emitted[1], {
      content: {
        type: "action",
        action: "Verifying",
        parameter: "targeted verification before publishing",
      },
      options: undefined,
    });
    assert.deepEqual(emitted[2], {
      content: {
        type: "action",
        action: "Publishing",
        parameter: "the repair to GitHub",
      },
      options: { ephemeral: true },
    });
    assert.deepEqual(emitted[3], {
      content: {
        type: "action",
        action: "Publishing",
        parameter: "the repair to GitHub",
      },
      options: undefined,
    });
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("progress reporter surfaces generic active plan steps as 'Working on' updates", async () => {
  const { baseDir, db } = createDatabase();
  try {
    const issue = db.upsertIssue({
      projectId: "project-1",
      linearIssueId: "issue-steps",
      issueKey: "TST-STEPS",
      factoryState: "implementing",
      delegatedToPatchRelay: true,
      agentSessionId: "session-steps",
    });
    const run = db.runs.createRun({
      issueId: issue.id,
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      runType: "implementation",
    });

    const emitted: Array<{ content: LinearAgentActivityContent; options?: { ephemeral?: boolean } }> = [];
    const reporter = new LinearProgressReporter(
      db,
      async (_issue, content, options) => {
        emitted.push({ content, options });
      },
    );

    // First step becomes active → one ephemeral + one durable update.
    reporter.maybeEmitProgress({
      method: "turn/plan/updated",
      params: {
        plan: [
          { step: "Add the issues factory_state index", status: "in_progress" },
          { step: "Wire the reconciler to the new query", status: "pending" },
        ],
      },
    }, run);
    // Same active step again → deduped, no new updates.
    reporter.maybeEmitProgress({
      method: "turn/plan/updated",
      params: {
        plan: [
          { step: "Add the issues factory_state index", status: "completed" },
          { step: "Add the issues factory_state index", status: "in_progress" },
        ],
      },
    }, run);
    // Second step becomes active → another ephemeral + durable pair.
    reporter.maybeEmitProgress({
      method: "turn/plan/updated",
      params: {
        plan: [
          { step: "Wire the reconciler to the new query", status: "in_progress" },
        ],
      },
    }, run);
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(emitted, [
      { content: { type: "action", action: "Working on", parameter: "Add the issues factory_state index" }, options: { ephemeral: true } },
      { content: { type: "action", action: "Working on", parameter: "Add the issues factory_state index" }, options: undefined },
      { content: { type: "action", action: "Working on", parameter: "Wire the reconciler to the new query" }, options: { ephemeral: true } },
      { content: { type: "action", action: "Working on", parameter: "Wire the reconciler to the new query" }, options: undefined },
    ]);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("progress reporter ignores raw command chatter", async () => {
  const { baseDir, db } = createDatabase();
  try {
    const issue = db.upsertIssue({
      projectId: "project-1",
      linearIssueId: "issue-3",
      issueKey: "TST-3",
      factoryState: "implementing",
      delegatedToPatchRelay: true,
      agentSessionId: "session-3",
    });
    const run = db.runs.createRun({
      issueId: issue.id,
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      runType: "implementation",
    });

    const emitted: Array<{ content: LinearAgentActivityContent; options?: { ephemeral?: boolean } }> = [];
    const reporter = new LinearProgressReporter(
      db,
      async (_issue, content, options) => {
        emitted.push({ content, options });
      },
    );

    reporter.maybeEmitProgress({
      method: "item/completed",
      params: {
        item: {
          id: "cmd-1",
          type: "commandExecution",
          status: "completed",
          command: "npm test",
        },
      },
    }, run);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(emitted.length, 0);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("progress reporter re-emits durable history when the run meaning advances", async () => {
  const { baseDir, db } = createDatabase();
  try {
    const issue = db.upsertIssue({
      projectId: "project-1",
      linearIssueId: "issue-4",
      issueKey: "TST-4",
      factoryState: "implementing",
      delegatedToPatchRelay: true,
      agentSessionId: "session-4",
    });
    const run = db.runs.createRun({
      issueId: issue.id,
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      runType: "implementation",
    });

    const emitted: Array<{ content: LinearAgentActivityContent; options?: { ephemeral?: boolean } }> = [];
    const reporter = new LinearProgressReporter(
      db,
      async (_issue, content, options) => {
        emitted.push({ content, options });
      },
    );

    reporter.maybeEmitProgress({
      method: "turn/plan/updated",
      params: {
        plan: [{ step: "Run targeted verification before publishing", status: "in_progress" }],
      },
    }, run);
    reporter.maybeEmitProgress({
      method: "turn/plan/updated",
      params: {
        plan: [{ step: "Publish the repair to GitHub", status: "in_progress" }],
      },
    }, run);
    reporter.maybeEmitProgress({
      method: "turn/plan/updated",
      params: {
        plan: [{ step: "Run targeted verification before publishing", status: "in_progress" }],
      },
    }, run);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(emitted.length, 6);
    assert.deepEqual(
      emitted.map((entry) => [entry.content.type, entry.options?.ephemeral === true ? "ephemeral" : "durable"]),
      [
        ["action", "ephemeral"],
        ["action", "durable"],
        ["action", "ephemeral"],
        ["action", "durable"],
        ["action", "ephemeral"],
        ["action", "durable"],
      ],
    );
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("progress reporter ignores first-person operational chatter", async () => {
  const { baseDir, db } = createDatabase();
  try {
    const issue = db.upsertIssue({
      projectId: "project-1",
      linearIssueId: "issue-5",
      issueKey: "TST-5",
      factoryState: "implementing",
      delegatedToPatchRelay: true,
      agentSessionId: "session-5",
    });
    const run = db.runs.createRun({
      issueId: issue.id,
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      runType: "implementation",
    });

    const emitted: Array<{ content: LinearAgentActivityContent; options?: { ephemeral?: boolean } }> = [];
    const reporter = new LinearProgressReporter(
      db,
      async (_issue, content, options) => {
        emitted.push({ content, options });
      },
    );

    reporter.maybeEmitProgress({
      method: "item/completed",
      params: {
        item: {
          id: "item-5",
          type: "agentMessage",
          status: "completed",
          text: "The build output reached the packaging step cleanly and the session closed normally, so I’m on the final publish pass now: checking the exact changed files, rerunning the focused verification, and preparing the push.",
        },
      },
    }, run);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(emitted.length, 0);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("progress reporter emits a quiet-period heartbeat without durable history noise", async () => {
  const { baseDir, db } = createDatabase();
  try {
    const issue = db.upsertIssue({
      projectId: "project-1",
      linearIssueId: "issue-6",
      issueKey: "TST-6",
      factoryState: "implementing",
      delegatedToPatchRelay: true,
      agentSessionId: "session-6",
    });
    const run = db.runs.createRun({
      issueId: issue.id,
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      runType: "implementation",
    });

    let now = 1_000;
    const emitted: Array<{ content: LinearAgentActivityContent; options?: { ephemeral?: boolean } }> = [];
    const reporter = new LinearProgressReporter(
      db,
      async (_issue, content, options) => {
        emitted.push({ content, options });
      },
      { heartbeatIntervalMs: 5_000, now: () => now },
    );

    const notification = {
      method: "item/started",
      params: {
        item: {
          id: "cmd-6",
          type: "commandExecution",
          status: "running",
          command: "pnpm test",
        },
      },
    };

    reporter.maybeEmitProgress(notification, run);
    now += 4_999;
    reporter.maybeEmitProgress(notification, run);
    now += 1;
    reporter.maybeEmitProgress(notification, run);
    reporter.maybeEmitProgress(notification, run);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(emitted.length, 1);
    assert.deepEqual(emitted[0], {
      content: {
        type: "thought",
        body: "PatchRelay is still working on implementation. Latest signal: command pnpm test.",
      },
      options: { ephemeral: true },
    });
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("progress reporter resets heartbeat quiet window after meaningful progress", async () => {
  const { baseDir, db } = createDatabase();
  try {
    const issue = db.upsertIssue({
      projectId: "project-1",
      linearIssueId: "issue-7",
      issueKey: "TST-7",
      factoryState: "implementing",
      delegatedToPatchRelay: true,
      agentSessionId: "session-7",
    });
    const run = db.runs.createRun({
      issueId: issue.id,
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      runType: "implementation",
    });

    let now = 1_000;
    const emitted: Array<{ content: LinearAgentActivityContent; options?: { ephemeral?: boolean } }> = [];
    const reporter = new LinearProgressReporter(
      db,
      async (_issue, content, options) => {
        emitted.push({ content, options });
      },
      { heartbeatIntervalMs: 5_000, now: () => now },
    );

    const commandNotification = {
      method: "item/started",
      params: {
        item: {
          id: "cmd-7",
          type: "commandExecution",
          status: "running",
          command: "pnpm test",
        },
      },
    };

    reporter.maybeEmitProgress(commandNotification, run);
    now += 5_000;
    reporter.maybeEmitProgress(commandNotification, run);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(emitted.length, 1);

    now += 1_000;
    reporter.maybeEmitProgress({
      method: "turn/plan/updated",
      params: {
        plan: [{ step: "Run targeted verification before publishing", status: "in_progress" }],
      },
    }, run);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(emitted.length, 3);

    now += 4_999;
    reporter.maybeEmitProgress(commandNotification, run);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(emitted.length, 3);

    now += 1;
    reporter.maybeEmitProgress(commandNotification, run);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(emitted.length, 4);
    assert.deepEqual(emitted.at(-1), {
      content: {
        type: "thought",
        body: "PatchRelay is still working on implementation. Latest signal: command pnpm test.",
      },
      options: { ephemeral: true },
    });
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});
