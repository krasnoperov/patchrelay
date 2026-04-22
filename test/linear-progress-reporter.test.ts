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
