import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import pino from "pino";
import { PatchRelayDatabase } from "../src/db.ts";
import { StageTurnInputDispatcher } from "../src/stage-turn-input-dispatcher.ts";

class FakeCodexClient {
  readonly steers: Array<{ threadId: string; turnId: string; input: string }> = [];
  failAfter?: number;

  async steerTurn(params: { threadId: string; turnId: string; input: string }): Promise<void> {
    if (this.failAfter !== undefined && this.steers.length >= this.failAfter) {
      throw new Error("steer failed");
    }
    this.steers.push(params);
  }
}

test("dispatcher routes and flushes pending inputs in order and stops after failure", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-turn-dispatcher-"));
  try {
    const db = new PatchRelayDatabase(path.join(baseDir, "patchrelay.sqlite"), true);
    db.runMigrations();
    const codex = new FakeCodexClient();
    const dispatcher = new StageTurnInputDispatcher(db, codex as never, pino({ enabled: false }));

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
