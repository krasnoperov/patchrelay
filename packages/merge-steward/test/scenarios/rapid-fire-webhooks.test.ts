import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHarness, type SimPR } from "../harness.ts";

describe("rapid-fire webhook events", () => {
  it("force-push then immediate dequeue — entry ends dequeued", async () => {
    const h = await createHarness({ ciRule: () => "pass" });
    const pr: SimPR = { number: 1, branch: "feat-x", files: [{ path: "x.ts", content: "x" }] };

    await h.enqueue(pr);
    await h.tick(); // queued → preparing_head
    await h.tick(); // preparing_head → validating

    // Rapid-fire: force-push resets to queued, then dequeue terminates
    await h.forcePush(1);
    h.dequeueByPR(1);

    assert.strictEqual(h.entryStatus(pr), "dequeued");

    // Ticking should not resurrect the entry
    await h.tick();
    await h.tick();
    assert.strictEqual(h.entryStatus(pr), "dequeued");
    assert.strictEqual(h.activeEntries.length, 0);
    h.assertInvariants();
  });

  it("enqueue then immediate dequeue — entry is dequeued", async () => {
    const h = await createHarness({ ciRule: () => "pass" });
    const pr: SimPR = { number: 1, branch: "feat-y", files: [{ path: "y.ts", content: "y" }] };

    await h.enqueue(pr);
    h.dequeueByPR(1);

    assert.strictEqual(h.entryStatus(pr), "dequeued");
    assert.strictEqual(h.activeEntries.length, 0);

    await h.runUntilStable();
    assert.deepStrictEqual(h.merged, []);
    h.assertInvariants();
  });

  it("two PRs enqueued simultaneously both merge in order", async () => {
    const h = await createHarness({ ciRule: () => "pass" });
    const prA: SimPR = { number: 1, branch: "feat-a", files: [{ path: "a.ts", content: "a" }] };
    const prB: SimPR = { number: 2, branch: "feat-b", files: [{ path: "b.ts", content: "b" }] };

    // Enqueue both before any tick
    await h.enqueue(prA);
    await h.enqueue(prB);

    assert.strictEqual(h.entries.length, 2);
    assert.strictEqual(h.entries[0]!.status, "queued");
    assert.strictEqual(h.entries[1]!.status, "queued");

    await h.runUntilStable();
    assert.deepStrictEqual(h.merged, [1, 2]);
    h.assertInvariants();
  });

  it("force-push during validating resets and eventually merges", async () => {
    const h = await createHarness({ ciRule: () => "pass" });
    const pr: SimPR = { number: 1, branch: "feat-z", files: [{ path: "z.ts", content: "z" }] };

    await h.enqueue(pr);
    await h.tick(); // queued → preparing_head
    await h.tick(); // preparing_head → validating

    assert.strictEqual(h.entryStatus(pr), "validating");

    // Force-push resets to queued
    await h.forcePush(1);
    assert.strictEqual(h.entryStatus(pr), "queued");

    // Should recover and merge
    await h.runUntilStable();
    assert.deepStrictEqual(h.merged, [1]);
    h.assertInvariants();
  });
});
