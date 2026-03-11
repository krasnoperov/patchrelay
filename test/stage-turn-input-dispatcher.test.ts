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

    db.stageEvents.enqueueTurnInput({
      stageRunId: 1,
      source: "one",
      body: "first",
    });
    db.stageEvents.enqueueTurnInput({
      stageRunId: 1,
      source: "two",
      body: "second",
    });

    dispatcher.routePendingInputs(1, "thread-1", "turn-1");
    codex.failAfter = 1;
    await dispatcher.flush(
      {
        id: 1,
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

    db.stageEvents.enqueueTurnInput({
      stageRunId: 7,
      threadId: "thread-7",
      turnId: "turn-7",
      source: "linear-comment:comment-7",
      body: "please retry this",
    });

    codex.failAfter = 0;
    codex.failureMessage = "authorization=Bearer secret-token";
    await dispatcher.flush({
      id: 7,
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
