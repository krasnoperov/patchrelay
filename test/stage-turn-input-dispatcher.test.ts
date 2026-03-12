import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { Logger } from "pino";
import { PatchRelayDatabase } from "../src/db.ts";
import { StageTurnInputDispatcher } from "../src/stage-turn-input-dispatcher.ts";

class FakeCodexClient {
  readonly steers: Array<{ threadId: string; turnId: string; input: string }> = [];
  failAfter?: number;
  failureMessage = "steer failed";

  async steerTurn(params: { threadId: string; turnId: string; input: string }): Promise<void> {
    if (this.failAfter !== undefined && this.steers.length >= this.failAfter) {
      throw new Error(this.failureMessage);
    }
    this.steers.push(params);
  }
}

function createCaptureLogger() {
  const warnings: Array<{ bindings: Record<string, unknown>; message: string }> = [];
  const logger = {
    fatal() {},
    error() {},
    warn(bindings: Record<string, unknown>, message: string) {
      warnings.push({ bindings, message });
    },
    info() {},
    debug() {},
    trace() {},
    silent() {},
    child() {
      return logger;
    },
    level: "debug",
  } as unknown as Logger;
  return { logger, warnings };
}

test("dispatcher routes and flushes pending inputs in order and stops after failure", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-turn-dispatcher-"));
  try {
    const db = new PatchRelayDatabase(path.join(baseDir, "patchrelay.sqlite"), true);
    db.runMigrations();
    const codex = new FakeCodexClient();
    const { logger } = createCaptureLogger();
    const dispatcher = new StageTurnInputDispatcher(db, codex as never, logger);

    const issueControl = db.issueControl.upsertIssueControl({
      projectId: "proj",
      linearIssueId: "issue-1",
      lifecycleStatus: "running",
    });
    const workspace = db.workspaceOwnership.upsertWorkspaceOwnership({
      projectId: "proj",
      linearIssueId: "issue-1",
      branchName: "proj/issue-1",
      worktreePath: "/tmp/worktree-1",
      status: "active",
    });
    const runLease = db.runLeases.createRunLease({
      issueControlId: issueControl.id,
      projectId: "proj",
      linearIssueId: "issue-1",
      workspaceOwnershipId: workspace.id,
      stage: "development",
      status: "running",
    });
    db.issueControl.upsertIssueControl({
      projectId: "proj",
      linearIssueId: "issue-1",
      activeWorkspaceOwnershipId: workspace.id,
      activeRunLeaseId: runLease.id,
      lifecycleStatus: "running",
    });

    const firstQueuedInputId = db.stageEvents.enqueueTurnInput({
      stageRunId: 1,
      source: "one",
      body: "first",
    });
    const secondQueuedInputId = db.stageEvents.enqueueTurnInput({
      stageRunId: 1,
      source: "two",
      body: "second",
    });
    db.obligations.enqueueObligation({
      projectId: "proj",
      linearIssueId: "issue-1",
      kind: "deliver_turn_input",
      source: "one",
      payloadJson: JSON.stringify({ body: "first", queuedInputId: firstQueuedInputId }),
      runLeaseId: runLease.id,
    });
    db.obligations.enqueueObligation({
      projectId: "proj",
      linearIssueId: "issue-1",
      kind: "deliver_turn_input",
      source: "two",
      payloadJson: JSON.stringify({ body: "second", queuedInputId: secondQueuedInputId }),
      runLeaseId: runLease.id,
    });

    dispatcher.routePendingInputs({ id: 1, projectId: "proj", linearIssueId: "issue-1" }, "thread-1", "turn-1");
    codex.failAfter = 1;
    await dispatcher.flush(
      {
        id: 1,
        projectId: "proj",
        linearIssueId: "issue-1",
        threadId: "thread-1",
        turnId: "turn-1",
      },
      { issueKey: "USE-25", logFailures: true },
    );

    assert.deepEqual(codex.steers.map((entry) => entry.input), ["first"]);
    const remaining = db.stageEvents.listPendingTurnInputs(1);
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0]?.body, "second");
    assert.equal(remaining[0]?.threadId, "thread-1");
    assert.equal(remaining[0]?.turnId, "turn-1");
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("dispatcher logs queued input delivery failures by default", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-turn-dispatcher-log-"));
  try {
    const db = new PatchRelayDatabase(path.join(baseDir, "patchrelay.sqlite"), true);
    db.runMigrations();
    const codex = new FakeCodexClient();
    const { logger, warnings } = createCaptureLogger();
    const dispatcher = new StageTurnInputDispatcher(db, codex as never, logger);

    const issueControl = db.issueControl.upsertIssueControl({
      projectId: "proj",
      linearIssueId: "issue-7",
      lifecycleStatus: "running",
    });
    const workspace = db.workspaceOwnership.upsertWorkspaceOwnership({
      projectId: "proj",
      linearIssueId: "issue-7",
      branchName: "proj/issue-7",
      worktreePath: "/tmp/worktree-7",
      status: "active",
    });
    const runLease = db.runLeases.createRunLease({
      issueControlId: issueControl.id,
      projectId: "proj",
      linearIssueId: "issue-7",
      workspaceOwnershipId: workspace.id,
      stage: "development",
      status: "running",
    });
    db.issueControl.upsertIssueControl({
      projectId: "proj",
      linearIssueId: "issue-7",
      activeWorkspaceOwnershipId: workspace.id,
      activeRunLeaseId: runLease.id,
      lifecycleStatus: "running",
    });
    const queuedInputId = db.stageEvents.enqueueTurnInput({
      stageRunId: 7,
      threadId: "thread-7",
      turnId: "turn-7",
      source: "linear-comment:comment-7",
      body: "please retry this",
    });
    db.obligations.enqueueObligation({
      projectId: "proj",
      linearIssueId: "issue-7",
      kind: "deliver_turn_input",
      source: "linear-comment:comment-7",
      payloadJson: JSON.stringify({ body: "please retry this", queuedInputId }),
      runLeaseId: runLease.id,
      threadId: "thread-7",
      turnId: "turn-7",
    });

    codex.failAfter = 0;
    codex.failureMessage = "authorization=Bearer secret-token";
    await dispatcher.flush({
      id: 7,
      projectId: "proj",
      linearIssueId: "issue-7",
      threadId: "thread-7",
      turnId: "turn-7",
    });

    assert.equal(warnings.length, 1);
    assert.equal(warnings[0]?.message, "Failed to deliver queued turn input");
    assert.equal(warnings[0]?.bindings.threadId, "thread-7");
    assert.equal(warnings[0]?.bindings.turnId, "turn-7");
    assert.equal(warnings[0]?.bindings.source, "linear-comment:comment-7");
    assert.equal(warnings[0]?.bindings.error, "authorization=Bearer [redacted]");
    assert.equal(db.stageEvents.listPendingTurnInputs(7).length, 1);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("dispatcher ignores mirrored legacy queue rows once ledger obligations are complete", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-turn-dispatcher-ledger-first-"));
  try {
    const db = new PatchRelayDatabase(path.join(baseDir, "patchrelay.sqlite"), true);
    db.runMigrations();
    const codex = new FakeCodexClient();
    const { logger } = createCaptureLogger();
    const dispatcher = new StageTurnInputDispatcher(db, codex as never, logger);

    const issueControl = db.issueControl.upsertIssueControl({
      projectId: "proj",
      linearIssueId: "issue-9",
      lifecycleStatus: "running",
    });
    const workspace = db.workspaceOwnership.upsertWorkspaceOwnership({
      projectId: "proj",
      linearIssueId: "issue-9",
      branchName: "proj/issue-9",
      worktreePath: "/tmp/worktree-9",
      status: "active",
    });
    const runLease = db.runLeases.createRunLease({
      issueControlId: issueControl.id,
      projectId: "proj",
      linearIssueId: "issue-9",
      workspaceOwnershipId: workspace.id,
      stage: "development",
      status: "running",
    });
    db.issueControl.upsertIssueControl({
      projectId: "proj",
      linearIssueId: "issue-9",
      activeWorkspaceOwnershipId: workspace.id,
      activeRunLeaseId: runLease.id,
      lifecycleStatus: "running",
    });

    db.stageEvents.enqueueTurnInput({
      stageRunId: 9,
      threadId: "thread-9",
      turnId: "turn-9",
      source: "legacy-only",
      body: "stale mirrored queue row",
    });

    await dispatcher.flush({
      id: 9,
      projectId: "proj",
      linearIssueId: "issue-9",
      threadId: "thread-9",
      turnId: "turn-9",
    });

    assert.equal(codex.steers.length, 0);
    assert.equal(db.stageEvents.listPendingTurnInputs(9).length, 1);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});
