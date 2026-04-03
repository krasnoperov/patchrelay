import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHarness, type SimPR } from "../harness.ts";

const prA: SimPR = { number: 1, branch: "feat-a", files: [{ path: "a.ts", content: "a" }] };
const prB: SimPR = { number: 2, branch: "feat-b", files: [{ path: "b.ts", content: "b" }] };
const prC: SimPR = { number: 3, branch: "feat-c", files: [{ path: "c.ts", content: "c" }] };

describe("mid-queue dequeue does not contaminate downstream specs", () => {
  it("dequeuing a mid-chain entry invalidates downstream specs built on it", async () => {
    const h = await createHarness({
      ciRule: () => "pass",
      speculativeDepth: 3,
      maxRetries: 0,
    });
    await h.enqueue(prA);
    await h.enqueue(prB);
    await h.enqueue(prC);

    // Advance until all three specs are built and validating.
    for (let i = 0; i < 15; i++) {
      await h.tick();
      const active = h.activeEntries;
      if (active.length >= 3 && active.every((e) => e.status === "validating" || e.status === "merging")) break;
    }

    // C's spec should be built on B's spec (cumulative chain).
    const cBefore = h.entries.find((e) => e.prNumber === 3);
    assert.ok(cBefore?.specBasedOn, "C should have specBasedOn set (built on B's spec)");

    // Dequeue B (simulates label removal / PR close).
    h.dequeueByPR(prB.number);

    // Run to completion.
    await h.runUntilStable({ maxTicks: 40 });

    assert.ok(h.merged.includes(1), "A should merge");
    assert.strictEqual(h.entryStatus(prB), "dequeued", "B should be dequeued");
    assert.ok(h.merged.includes(3), "C should merge after rebuild without B");

    // C must have been invalidated — check for a preparing_head transition
    // triggered by the dequeue (service-level or reconciler stale-dep guard).
    const cEvents = h.store.listEvents(cBefore!.id);
    const rePrepared = cEvents.some(
      (e) => e.toStatus === "preparing_head" && e.detail?.includes("dequeued"),
    );
    assert.ok(rePrepared, "C should have been reset to preparing_head after B was dequeued");

    // After rebuild, C's spec should no longer reference B.
    const cAfter = h.entries.find((e) => e.prNumber === 3);
    assert.strictEqual(cAfter?.specBasedOn, null, "C's final specBasedOn should be null (rebuilt as head on main)");

    h.assertInvariants();
  });

  it("normal merge of head does NOT invalidate speculative downstream", async () => {
    // Regression guard: when A merges, B's spec (built on A) must remain
    // valid — that is the whole point of speculative cumulative branches.
    const h = await createHarness({
      ciRule: () => "pass",
      speculativeDepth: 3,
      maxRetries: 0,
    });
    await h.enqueue(prA);
    await h.enqueue(prB);
    await h.enqueue(prC);
    await h.runUntilStable({ maxTicks: 40 });

    assert.ok(h.merged.includes(1), "A should merge");
    assert.ok(h.merged.includes(2), "B should merge");
    assert.ok(h.merged.includes(3), "C should merge");

    // B should NOT have been invalidated due to A merging.
    const bStaleDep = h.reconcileEvents.filter(
      (e) => e.prNumber === 2 && e.action === "invalidated" && e.detail?.includes("stale dependency"),
    );
    assert.strictEqual(bStaleDep.length, 0, "B must not be invalidated when A merges (speculative consistency)");

    h.assertInvariants();
  });
});
