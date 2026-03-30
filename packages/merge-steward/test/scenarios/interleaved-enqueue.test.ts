import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHarness, type SimPR } from "../harness.ts";

describe("interleaved enqueue during processing", () => {
  it("PR enqueued while head is validating gets processed after head merges", async () => {
    const h = await createHarness({ ciRule: () => "pass" });
    const prA: SimPR = { number: 1, branch: "feat-a", files: [{ path: "a.ts", content: "a" }] };
    await h.enqueue(prA);

    // Advance A to validating.
    await h.tick(); // queued → preparing_head
    await h.tick(); // preparing_head → validating

    assert.strictEqual(h.entries[0]!.status, "validating");

    // Enqueue B while A is validating.
    const prB: SimPR = { number: 2, branch: "feat-b", files: [{ path: "b.ts", content: "b" }] };
    await h.enqueue(prB);

    // Run to completion.
    await h.runUntilStable();

    assert.deepStrictEqual(h.merged, [1, 2], "Both should merge in order");
    h.assertInvariants();
  });

  it("multiple PRs enqueued mid-processing all drain correctly", async () => {
    const h = await createHarness({ ciRule: () => "pass" });
    const prA: SimPR = { number: 1, branch: "feat-a", files: [{ path: "a.ts", content: "a" }] };
    await h.enqueue(prA);

    await h.tick(); // A: queued → preparing_head

    const prB: SimPR = { number: 2, branch: "feat-b", files: [{ path: "b.ts", content: "b" }] };
    const prC: SimPR = { number: 3, branch: "feat-c", files: [{ path: "c.ts", content: "c" }] };
    await h.enqueue(prB);

    await h.tick(); // A: preparing_head → validating

    await h.enqueue(prC);

    await h.runUntilStable();

    assert.deepStrictEqual(h.merged, [1, 2, 3]);
    assert.strictEqual(h.activeEntries.length, 0);
    h.assertInvariants();
  });

  it("dequeue mid-processing advances to next entry", async () => {
    const h = await createHarness({ ciRule: () => "pass" });
    const prA: SimPR = { number: 1, branch: "feat-a", files: [{ path: "a.ts", content: "a" }] };
    const prB: SimPR = { number: 2, branch: "feat-b", files: [{ path: "b.ts", content: "b" }] };
    await h.enqueue(prA);
    await h.enqueue(prB);

    await h.tick(); // A: queued → preparing_head

    // Dequeue A before it finishes.
    h.dequeueByPR(1);

    await h.runUntilStable();

    assert.strictEqual(h.entryStatus(prA), "dequeued");
    assert.deepStrictEqual(h.merged, [2], "B should merge after A is dequeued");
    h.assertInvariants();
  });

  it("force-push during validating resets and eventually merges", async () => {
    const h = await createHarness({ ciRule: () => "pass" });
    const prA: SimPR = { number: 1, branch: "feat-a", files: [{ path: "a.ts", content: "a" }] };
    await h.enqueue(prA);

    await h.tick(); // queued → preparing_head
    await h.tick(); // preparing_head → validating

    // Force-push while validating.
    await h.forcePush(1);

    // Entry should be reset to queued.
    const entry = h.entries.find((e) => e.prNumber === 1)!;
    assert.strictEqual(entry.status, "queued");
    assert.strictEqual(entry.generation, 1);

    // Should still eventually merge.
    await h.runUntilStable();
    assert.deepStrictEqual(h.merged, [1]);
    h.assertInvariants();
  });
});
