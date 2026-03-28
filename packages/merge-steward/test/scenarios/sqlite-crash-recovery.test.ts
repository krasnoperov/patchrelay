import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import { SqliteStore } from "../../src/db/sqlite-store.ts";
import { GitSim } from "../../src/sim/git-sim.ts";
import { CISim } from "../../src/sim/ci-sim.ts";
import { GitHubSim, EvictionReporterSim } from "../../src/sim/github-sim.ts";
import { reconcile } from "../../src/reconciler.ts";
import type { QueueEntry } from "../../src/types.ts";
import { assertInvariants } from "../invariants.ts";

function tempDbPath(): string {
  return join(tmpdir(), `steward-test-${randomUUID()}.sqlite`);
}

function makeEntry(id: string, prNumber: number, position: number): QueueEntry {
  return {
    id,
    repoId: "test-repo",
    prNumber,
    branch: `feat-${prNumber}`,
    headSha: `sha-${prNumber}`,
    baseSha: "base-sha",
    status: "queued",
    position,
    priority: 0,
    generation: 0,
    ciRunId: null,
    ciRetries: 0,
    retryAttempts: 0,
    maxRetries: 3,
    lastFailedBaseSha: null,
    issueKey: null,
    specBranch: null,
    specSha: null,
    specBasedOn: null,
    enqueuedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

describe("SQLite crash recovery", () => {
  it("state survives store destruction and reconstruction", async () => {
    const dbPath = tempDbPath();
    after(() => { try { unlinkSync(dbPath); } catch {} });

    // Create store, insert entries, advance some state.
    const store1 = new SqliteStore(dbPath);
    const gitSim = new GitSim();
    await gitSim.init("main");

    store1.insert(makeEntry("e1", 1, 1));
    store1.insert(makeEntry("e2", 2, 2));
    store1.insert(makeEntry("e3", 3, 3));

    // Advance e1 to preparing_head.
    store1.transition("e1", "preparing_head");

    // Verify state before "crash".
    const head = store1.getHead("test-repo");
    assert.ok(head);
    assert.strictEqual(head.id, "e1");
    assert.strictEqual(head.status, "preparing_head");

    // "Crash" — close the connection.
    store1.close();

    // Reconstruct from the same file.
    const store2 = new SqliteStore(dbPath);

    // State should be preserved.
    const recoveredHead = store2.getHead("test-repo");
    assert.ok(recoveredHead);
    assert.strictEqual(recoveredHead.id, "e1");
    assert.strictEqual(recoveredHead.status, "preparing_head");

    const allEntries = store2.listAll("test-repo");
    assert.strictEqual(allEntries.length, 3);
    assert.strictEqual(allEntries[0]!.status, "preparing_head");
    assert.strictEqual(allEntries[1]!.status, "queued");
    assert.strictEqual(allEntries[2]!.status, "queued");

    // Events should be persisted.
    const e1Events = store2.listEvents("e1");
    assert.strictEqual(e1Events.length, 2); // insert event + transition event
    assert.strictEqual(e1Events[0]!.toStatus, "queued");
    assert.strictEqual(e1Events[1]!.toStatus, "preparing_head");

    store2.close();
  });

  it("event logging is transactional with state changes", () => {
    const dbPath = tempDbPath();
    after(() => { try { unlinkSync(dbPath); } catch {} });

    const store = new SqliteStore(dbPath);
    store.insert(makeEntry("e1", 1, 1));
    store.transition("e1", "preparing_head");
    store.transition("e1", "validating", { ciRunId: "ci-1" });
    store.transition("e1", "merging");
    store.transition("e1", "merged");

    const events = store.listEvents("e1");
    assert.strictEqual(events.length, 5);
    assert.deepStrictEqual(
      events.map((e) => e.toStatus),
      ["queued", "preparing_head", "validating", "merging", "merged"],
    );
    assert.strictEqual(events[0]!.fromStatus, null); // insert
    assert.strictEqual(events[1]!.fromStatus, "queued");
    assert.strictEqual(events[2]!.fromStatus, "preparing_head");

    store.close();
  });

  it("one active entry per PR enforced by unique index", () => {
    const dbPath = tempDbPath();
    after(() => { try { unlinkSync(dbPath); } catch {} });

    const store = new SqliteStore(dbPath);
    store.insert(makeEntry("e1", 1, 1));

    // Inserting a second active entry for the same PR should fail.
    assert.throws(
      () => store.insert(makeEntry("e2", 1, 2)),
      /UNIQUE constraint failed/,
    );

    // But after the first is terminal, a new one is allowed.
    store.transition("e1", "merged");
    store.insert(makeEntry("e3", 1, 3)); // should succeed
    assert.strictEqual(store.getEntryByPR("test-repo", 1)!.id, "e3");

    store.close();
  });
});
