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
  holdSteerUntil?: Promise<void>;

  async steerTurn(params: { threadId: string; turnId: string; input: string }): Promise<void> {
    if (this.failAfter !== undefined && this.steers.length >= this.failAfter) {
      throw new Error(this.failureMessage);
    }
    this.steers.push(params);
    if (this.holdSteerUntil) {
      await this.holdSteerUntil;
    }
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

function listInputObligations(db: PatchRelayDatabase, projectId: string, linearIssueId: string) {
  return db.connection
    .prepare(
      `
      SELECT id, source, status, run_lease_id, thread_id, turn_id, last_error
      FROM obligations
      WHERE project_id = ? AND linear_issue_id = ? AND kind = 'deliver_turn_input'
      ORDER BY id
      `,
    )
    .all(projectId, linearIssueId) as Array<Record<string, unknown>>;
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

    db.obligations.enqueueObligation({
      projectId: "proj",
      linearIssueId: "issue-1",
      kind: "deliver_turn_input",
      source: "one",
      payloadJson: JSON.stringify({ body: "first" }),
      runLeaseId: runLease.id,
    });
    db.obligations.enqueueObligation({
      projectId: "proj",
      linearIssueId: "issue-1",
      kind: "deliver_turn_input",
      source: "two",
      payloadJson: JSON.stringify({ body: "second" }),
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
    const remaining = db.obligations.listPendingObligations({ runLeaseId: runLease.id, kind: "deliver_turn_input" });
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0]?.source, "two");
    assert.equal(remaining[0]?.threadId, "thread-1");
    assert.equal(remaining[0]?.turnId, "turn-1");
    const obligations = listInputObligations(db, "proj", "issue-1");
    assert.equal(obligations[0]?.status, "completed");
    assert.equal(obligations[0]?.thread_id, "thread-1");
    assert.equal(obligations[0]?.turn_id, "turn-1");
    assert.equal(obligations[1]?.status, "pending");
    assert.equal(obligations[1]?.last_error, "steer failed");
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
    db.obligations.enqueueObligation({
      projectId: "proj",
      linearIssueId: "issue-7",
      kind: "deliver_turn_input",
      source: "linear-comment:comment-7",
      payloadJson: JSON.stringify({ body: "please retry this" }),
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
    const pending = db.obligations.listPendingObligations({ runLeaseId: runLease.id, kind: "deliver_turn_input" });
    assert.equal(pending.length, 1);
    assert.equal(pending[0]?.threadId, "thread-7");
    assert.equal(pending[0]?.turnId, "turn-7");
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("dispatcher ignores completed obligations once ledger delivery is complete", async () => {
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

    await dispatcher.flush({
      id: 9,
      projectId: "proj",
      linearIssueId: "issue-9",
      threadId: "thread-9",
      turnId: "turn-9",
    });

    assert.equal(codex.steers.length, 0);
    assert.equal(db.obligations.listPendingObligations({ runLeaseId: runLease.id, kind: "deliver_turn_input" }).length, 0);
    assert.equal(listInputObligations(db, "proj", "issue-9").length, 0);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("dispatcher does not redeliver in-progress obligations during overlapping flushes", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-turn-dispatcher-overlap-"));
  try {
    const db = new PatchRelayDatabase(path.join(baseDir, "patchrelay.sqlite"), true);
    db.runMigrations();
    const codex = new FakeCodexClient();
    let releaseSteer: (() => void) | undefined;
    codex.holdSteerUntil = new Promise<void>((resolve) => {
      releaseSteer = resolve;
    });
    const { logger } = createCaptureLogger();
    const dispatcher = new StageTurnInputDispatcher(db, codex as never, logger);

    const issueControl = db.issueControl.upsertIssueControl({
      projectId: "proj",
      linearIssueId: "issue-10",
      lifecycleStatus: "running",
    });
    const workspace = db.workspaceOwnership.upsertWorkspaceOwnership({
      projectId: "proj",
      linearIssueId: "issue-10",
      branchName: "proj/issue-10",
      worktreePath: "/tmp/worktree-10",
      status: "active",
    });
    const runLease = db.runLeases.createRunLease({
      issueControlId: issueControl.id,
      projectId: "proj",
      linearIssueId: "issue-10",
      workspaceOwnershipId: workspace.id,
      stage: "development",
      status: "running",
    });
    db.issueControl.upsertIssueControl({
      projectId: "proj",
      linearIssueId: "issue-10",
      activeWorkspaceOwnershipId: workspace.id,
      activeRunLeaseId: runLease.id,
      lifecycleStatus: "running",
    });
    db.obligations.enqueueObligation({
      projectId: "proj",
      linearIssueId: "issue-10",
      kind: "deliver_turn_input",
      source: "linear-comment:comment-10",
      payloadJson: JSON.stringify({ body: "only once" }),
      runLeaseId: runLease.id,
    });

    const firstFlush = dispatcher.flush({
      id: 10,
      projectId: "proj",
      linearIssueId: "issue-10",
      threadId: "thread-10",
      turnId: "turn-10",
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    await dispatcher.flush({
      id: 10,
      projectId: "proj",
      linearIssueId: "issue-10",
      threadId: "thread-10",
      turnId: "turn-10",
    });

    assert.deepEqual(codex.steers.map((entry) => entry.input), ["only once"]);
    assert.equal(listInputObligations(db, "proj", "issue-10")[0]?.status, "in_progress");

    releaseSteer?.();
    await firstFlush;

    assert.deepEqual(codex.steers.map((entry) => entry.input), ["only once"]);
    assert.equal(listInputObligations(db, "proj", "issue-10")[0]?.status, "completed");
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("dispatcher leaves failed obligations dead-lettered instead of retrying them", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-turn-dispatcher-failed-dead-letter-"));
  try {
    const db = new PatchRelayDatabase(path.join(baseDir, "patchrelay.sqlite"), true);
    db.runMigrations();
    const codex = new FakeCodexClient();
    const { logger } = createCaptureLogger();
    const dispatcher = new StageTurnInputDispatcher(db, codex as never, logger);

    const issueControl = db.issueControl.upsertIssueControl({
      projectId: "proj",
      linearIssueId: "issue-11",
      lifecycleStatus: "running",
    });
    const workspace = db.workspaceOwnership.upsertWorkspaceOwnership({
      projectId: "proj",
      linearIssueId: "issue-11",
      branchName: "proj/issue-11",
      worktreePath: "/tmp/worktree-11",
      status: "active",
    });
    const runLease = db.runLeases.createRunLease({
      issueControlId: issueControl.id,
      projectId: "proj",
      linearIssueId: "issue-11",
      workspaceOwnershipId: workspace.id,
      stage: "development",
      status: "running",
    });
    db.issueControl.upsertIssueControl({
      projectId: "proj",
      linearIssueId: "issue-11",
      activeWorkspaceOwnershipId: workspace.id,
      activeRunLeaseId: runLease.id,
      lifecycleStatus: "running",
    });
    db.obligations.enqueueObligation({
      projectId: "proj",
      linearIssueId: "issue-11",
      kind: "deliver_turn_input",
      source: "linear-comment:comment-11",
      payloadJson: JSON.stringify({}),
      runLeaseId: runLease.id,
    });

    await dispatcher.flush({
      id: 11,
      projectId: "proj",
      linearIssueId: "issue-11",
      threadId: "thread-11",
      turnId: "turn-11",
    });
    await dispatcher.flush({
      id: 11,
      projectId: "proj",
      linearIssueId: "issue-11",
      threadId: "thread-11",
      turnId: "turn-11",
    });

    assert.equal(codex.steers.length, 0);
    assert.equal(listInputObligations(db, "proj", "issue-11")[0]?.status, "failed");
    assert.equal(db.obligations.listPendingObligations({ runLeaseId: runLease.id, kind: "deliver_turn_input" }).length, 0);
    assert.equal(
      db.obligations.listPendingObligations({
        runLeaseId: runLease.id,
        kind: "deliver_turn_input",
        includeInProgress: true,
      }).length,
      0,
    );
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});
