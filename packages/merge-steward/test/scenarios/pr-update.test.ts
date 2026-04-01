import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHarness, type SimPR } from "../harness.ts";

describe("PR update (force-push) handling", () => {
  it("updateHead resets all SHA-bound state and increments generation", async () => {
    const h = await createHarness({ ciRule: () => "pass" });
    const prA: SimPR = { number: 1, branch: "feat-a", files: [{ path: "a.ts", content: "a" }] };
    await h.enqueue(prA);

    await h.tick(); // queued → preparing_head
    await h.tick(); // preparing_head → validating

    const before = h.entries.find((e) => e.prNumber === 1)!;
    assert.strictEqual(before.status, "validating");
    assert.ok(before.ciRunId !== null);
    assert.strictEqual(before.generation, 0);

    h.store.updateHead(before.id, "new-sha-after-force-push");

    const after = h.entries.find((e) => e.prNumber === 1)!;
    assert.strictEqual(after.status, "queued");
    assert.strictEqual(after.generation, 1);
    assert.strictEqual(after.headSha, "new-sha-after-force-push");
    assert.strictEqual(after.ciRunId, null);
    assert.strictEqual(after.ciRetries, 0);
    assert.strictEqual(after.retryAttempts, 0);
    assert.strictEqual(after.lastFailedBaseSha, null);

    const events = h.store.listEvents(before.id);
    const lastEvent = events[events.length - 1]!;
    assert.strictEqual(lastEvent.toStatus, "queued");
    assert.ok(lastEvent.detail?.includes("generation 1"));

    h.assertInvariants();
  });

  it("updateHead is a no-op on terminal entries", async () => {
    const h = await createHarness({ ciRule: () => "pass" });
    const prA: SimPR = { number: 1, branch: "feat-a", files: [{ path: "a.ts", content: "a" }] };
    await h.enqueue(prA);
    await h.runUntilStable();

    assert.strictEqual(h.entries[0]!.status, "merged");
    const sha = h.entries[0]!.headSha;

    h.store.updateHead(h.entries[0]!.id, "should-not-apply");

    assert.strictEqual(h.entries[0]!.status, "merged");
    assert.strictEqual(h.entries[0]!.headSha, sha);
  });

  it("updateHeadByPR ignores synchronize webhooks that repeat the current head", async () => {
    const h = await createHarness({ ciRule: () => "pass" });
    const prA: SimPR = { number: 1, branch: "feat-a", files: [{ path: "a.ts", content: "a" }] };
    const service = (await import("../../src/service.ts")).MergeStewardService;
    await h.enqueue(prA);
    await h.tick(); // queued -> preparing_head
    await h.tick(); // preparing_head -> validating

    const entry = h.entries[0]!;
    const currentGeneration = entry.generation;
    const currentEventCount = h.store.listEvents(entry.id).length;

    const steward = new service(
      {
        repoId: "test-repo",
        repoFullName: "test/repo",
        baseBranch: "main",
        clonePath: "/tmp/test-clone",
        gitBin: "git",
        maxRetries: 3,
        flakyRetries: 0,
        requiredChecks: [],
        pollIntervalMs: 60_000,
        admissionLabel: "queue",
        mergeQueueCheckName: "merge-steward/queue",
        excludeBranches: [],
        server: { bind: "127.0.0.1", port: 0 },
        database: { path: ":memory:", wal: true },
        logging: { level: "silent" },
        speculativeDepth: 1,
      },
      h.store,
      h.gitSim as any,
      h.ciSim as any,
      h.githubSim,
      h.evictionSim,
      null,
      (await import("pino")).default({ level: "silent" }),
    );

    steward.updateHeadByPR(1, entry.headSha);

    const after = h.entries[0]!;
    assert.strictEqual(after.status, "validating");
    assert.strictEqual(after.generation, currentGeneration);
    assert.strictEqual(h.store.listEvents(entry.id).length, currentEventCount);
  });
});
