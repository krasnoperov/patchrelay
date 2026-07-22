import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { Logger } from "pino";
import { PatchRelayDatabase } from "../src/db.ts";
import { RunNotificationHandler } from "../src/run-notification-handler.ts";
import type { CodexNotification } from "../src/codex-app-server.ts";
import type { CodexThreadSummary } from "../src/types.ts";

function createDatabase(): { baseDir: string; db: PatchRelayDatabase } {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-run-notification-"));
  const db = new PatchRelayDatabase(path.join(baseDir, "patchrelay.sqlite"), true);
  db.runMigrations();
  return { baseDir, db };
}

function createThread(threadId: string): CodexThreadSummary {
  return {
    id: threadId,
    preview: "",
    cwd: "",
    status: "completed",
    turns: [
      {
        id: "turn-1",
        status: "completed",
        items: [],
      },
    ],
  };
}

test("notification handler keeps completion authoritative when Linear progress reporting fails", async () => {
  const { baseDir, db } = createDatabase();
  try {
    const issue = db.upsertIssue({
      projectId: "project-1",
      linearIssueId: "issue-1",
      issueKey: "TST-1",
      workflowOutcome: undefined,
      delegatedToPatchRelay: true,
      agentSessionId: "session-1",
    });
    const run = db.runs.createRun({
      issueId: issue.id,
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      runType: "implementation",
    });
    db.runs.updateRunThread(run.id, { threadId: "thread-1", turnId: "turn-1" });
    db.upsertIssue({
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      activeRunId: run.id,
    });

    const warnings: Array<Record<string, unknown>> = [];
    const finalized: Array<Record<string, unknown>> = [];
    const handler = new RunNotificationHandler(
      db,
      {
        info: () => {},
        warn: (payload: Record<string, unknown>) => {
          warnings.push(payload);
        },
      } as unknown as Logger,
      {
        maybeEmitProgress: () => {
          throw new Error("no such table: issues");
        },
        syncCodexPlan: async () => {},
        emitActivity: async () => {},
        syncSession: async () => {},
        clearProgress: () => {},
      } as never,
      {
        finalizeCompletedRun: async (params: Record<string, unknown>) => {
          finalized.push(params);
        },
        recoverFailedImplementationRun: async () => false,
      } as never,
      async (threadId) => createThread(threadId),
      (_projectId, _linearIssueId, fn) => fn({ projectId: issue.projectId, linearIssueId: issue.linearIssueId, leaseId: "lease-1" }),
      () => true,
      () => {},
    );

    const progressNotification: CodexNotification = {
      method: "item/started",
      params: {
        threadId: "thread-1",
        item: {
          id: "item-1",
          type: "agentMessage",
          text: "Investigating the failure.",
        },
      },
    };
    await handler.handle(progressNotification);
    assert.equal(db.runs.getRunById(run.id)?.lastCodexActivitySummary, "Investigating the failure.");

    const completionNotification: CodexNotification = {
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: {
          id: "turn-1",
          status: "completed",
        },
      },
    };
    await handler.handle(completionNotification);

    const observedRun = db.runs.getRunById(run.id);
    assert.equal(observedRun?.lastCodexActivityKind, "turn/completed");
    assert.equal(observedRun?.lastCodexActivitySummary, undefined);

    assert.equal(finalized.length, 1);
    assert.equal(finalized[0]?.source, "notification");
    assert.equal(finalized[0]?.threadId, "thread-1");
    assert.equal(warnings.length, 2);
    assert.equal(warnings[0]?.error, "no such table: issues");
    assert.equal(warnings[0]?.method, "item/started");
    assert.equal(warnings[1]?.method, "turn/completed");
  } finally {
    db.close();
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("notification handler interrupts a stuck git push command", async () => {
  const { baseDir, db } = createDatabase();
  try {
    const issue = db.upsertIssue({
      projectId: "project-1",
      linearIssueId: "issue-push",
      issueKey: "TST-PUSH",
      workflowOutcome: undefined,
      delegatedToPatchRelay: true,
    });
    const run = db.runs.createRun({
      issueId: issue.id,
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      runType: "implementation",
    });
    db.runs.updateRunThread(run.id, { threadId: "thread-push", turnId: "turn-push" });
    db.upsertIssue({
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      activeRunId: run.id,
    });

    const warnings: Array<Record<string, unknown>> = [];
    const interrupts: Array<{ threadId: string; turnId: string }> = [];
    const handler = new RunNotificationHandler(
      db,
      {
        info: () => {},
        warn: (payload: Record<string, unknown>) => {
          warnings.push(payload);
        },
      } as unknown as Logger,
      {
        maybeEmitProgress: () => {},
        syncCodexPlan: async () => {},
        emitActivity: async () => {},
        syncSession: async () => {},
        clearProgress: () => {},
      } as never,
      {
        finalizeCompletedRun: async () => {},
        recoverFailedImplementationRun: async () => false,
      } as never,
      async (threadId) => createThread(threadId),
      (_projectId, _linearIssueId, fn) => fn({ projectId: issue.projectId, linearIssueId: issue.linearIssueId, leaseId: "lease-1" }),
      () => true,
      () => {},
      undefined,
      {
        publishCommandTimeoutMs: 10,
        interruptTurn: async (options) => {
          interrupts.push(options);
        },
      },
    );

    await handler.handle({
      method: "item/started",
      params: {
        threadId: "thread-push",
        turnId: "turn-push",
        item: {
          id: "cmd-push",
          type: "commandExecution",
          status: "inProgress",
          command: "git push origin feature-branch",
        },
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 40));

    assert.deepEqual(interrupts, [{ threadId: "thread-push", turnId: "turn-push" }]);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0]?.runId, run.id);
  } finally {
    db.close();
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("notification handler clears git push watchdog when the command completes", async () => {
  const { baseDir, db } = createDatabase();
  try {
    const issue = db.upsertIssue({
      projectId: "project-1",
      linearIssueId: "issue-push-complete",
      issueKey: "TST-PUSH-DONE",
      workflowOutcome: undefined,
      delegatedToPatchRelay: true,
    });
    const run = db.runs.createRun({
      issueId: issue.id,
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      runType: "implementation",
    });
    db.runs.updateRunThread(run.id, { threadId: "thread-push-done", turnId: "turn-push-done" });
    db.upsertIssue({
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      activeRunId: run.id,
    });

    const interrupts: Array<{ threadId: string; turnId: string }> = [];
    const handler = new RunNotificationHandler(
      db,
      { info: () => {}, warn: () => {} } as unknown as Logger,
      {
        maybeEmitProgress: () => {},
        syncCodexPlan: async () => {},
        emitActivity: async () => {},
        syncSession: async () => {},
        clearProgress: () => {},
      } as never,
      {
        finalizeCompletedRun: async () => {},
        recoverFailedImplementationRun: async () => false,
      } as never,
      async (threadId) => createThread(threadId),
      (_projectId, _linearIssueId, fn) => fn({ projectId: issue.projectId, linearIssueId: issue.linearIssueId, leaseId: "lease-1" }),
      () => true,
      () => {},
      undefined,
      {
        publishCommandTimeoutMs: 20,
        interruptTurn: async (options) => {
          interrupts.push(options);
        },
      },
    );

    await handler.handle({
      method: "item/started",
      params: {
        threadId: "thread-push-done",
        turnId: "turn-push-done",
        item: {
          id: "cmd-push",
          type: "commandExecution",
          status: "inProgress",
          command: "git push origin feature-branch",
        },
      },
    });
    await handler.handle({
      method: "item/completed",
      params: {
        threadId: "thread-push-done",
        turnId: "turn-push-done",
        item: {
          id: "cmd-push",
          type: "commandExecution",
          status: "completed",
          command: "git push origin feature-branch",
        },
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.deepEqual(interrupts, []);
  } finally {
    db.close();
    rmSync(baseDir, { recursive: true, force: true });
  }
});
