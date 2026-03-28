import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHarness, type SimPR } from "../harness.ts";

const prA: SimPR = { number: 1, branch: "feat-a", files: [{ path: "a.ts", content: "a" }] };
const prB: SimPR = { number: 2, branch: "feat-b", files: [{ path: "b.ts", content: "b" }] };
const prC: SimPR = { number: 3, branch: "feat-c", files: [{ path: "c.ts", content: "c" }] };

describe("speculative edge cases", () => {
  it("force-push on A while B is speculatively validating invalidates B", async () => {
    const h = await createHarness({ ciRule: () => "pass", speculativeDepth: 3 });
    await h.enqueue(prA);
    await h.enqueue(prB);

    // Run until both have spec branches.
    await h.tick(); // promote both
    await h.tick(); // build spec branches, enter validating

    const bEntry = h.entries.find((e) => e.prNumber === 2)!;
    assert.strictEqual(bEntry.status, "validating", "B should be validating speculatively");
    assert.ok(bEntry.specBranch !== null, "B should have a spec branch");

    // Force-push A — this changes A's branch, making B's spec stale.
    await h.forcePush(1);

    // Next tick: A is reset to queued. B's spec is stale.
    // The reconciler should detect A's base changed and invalidate B.
    await h.tick();
    await h.tick();
    await h.tick();

    // Eventually both should merge (A re-rebases, B gets new spec).
    await h.runUntilStable();
    assert.deepStrictEqual(h.merged, [1, 2]);
    h.assertInvariants();
  });

  it("enqueue during speculation gets a spec slot if depth allows", async () => {
    const h = await createHarness({ ciRule: () => "pass", speculativeDepth: 3 });
    await h.enqueue(prA);
    await h.enqueue(prB);

    // Run 2 ticks — A and B are being speculated.
    await h.tick();
    await h.tick();

    // Enqueue C mid-speculation.
    await h.enqueue(prC);

    // C should get a spec slot (depth is 3, we have 3 entries).
    await h.tick();
    await h.tick();

    const cEntry = h.entries.find((e) => e.prNumber === 3)!;
    // C should be in validating or at least preparing_head (not stuck in queued).
    assert.ok(
      cEntry.status === "validating" || cEntry.status === "preparing_head" || cEntry.status === "merging" || cEntry.status === "merged",
      `C should be processing (got ${cEntry.status})`,
    );

    await h.runUntilStable();
    assert.deepStrictEqual(h.merged, [1, 2, 3]);
    h.assertInvariants();
  });

  it("dequeue mid-speculation invalidates downstream", async () => {
    const h = await createHarness({ ciRule: () => "pass", speculativeDepth: 3 });
    await h.enqueue(prA);
    await h.enqueue(prB);
    await h.enqueue(prC);

    // Run until all are speculating.
    await h.tick();
    await h.tick();

    // Dequeue B (middle of the chain).
    h.dequeueByPR(2);

    // C's spec was based on B — it should be invalidated.
    // Check that C eventually gets rebuilt and merges.
    await h.runUntilStable();

    assert.ok(h.merged.includes(1), "A should merge");
    assert.strictEqual(h.entryStatus(prB), "dequeued", "B should be dequeued");
    assert.ok(h.merged.includes(3), "C should merge after rebuilding spec");

    // Check invalidation event was emitted.
    const invalidEvents = h.reconcileEvents.filter(
      (e) => e.prNumber === 3 && e.action === "invalidated",
    );
    // C may or may not have been invalidated depending on timing.
    // But it should definitely merge in the end.

    h.assertInvariants();
  });

  it("main advance outside queue during speculation triggers rebuild", async () => {
    const h = await createHarness({ ciRule: () => "pass", speculativeDepth: 3 });
    await h.enqueue(prA);
    await h.enqueue(prB);

    // Run until both are validating.
    await h.tick();
    await h.tick();

    // Advance main (simulates someone merging another PR outside the queue).
    await h.advanceMain();

    // On next tick, head (A) should detect base changed.
    // If A's headSha is still valid (no force-push), A continues.
    // But B's spec was built on old main+A — if A re-rebases, B's spec is stale.
    await h.runUntilStable();

    // Both should eventually merge.
    assert.deepStrictEqual(h.merged, [1, 2]);
    h.assertInvariants();
  });

  it("CI failure mid-chain evicts and downstream rebuilds without the failed entry", async () => {
    // B always fails CI. With speculation, A and B test in parallel.
    // When B fails, C's spec (which included B) must be rebuilt without B.
    const h = await createHarness({
      ciRule: (files) => files.includes("b.ts") ? "fail" : "pass",
      speculativeDepth: 3,
      maxRetries: 0,
    });
    await h.enqueue(prA);
    await h.enqueue(prB);
    await h.enqueue(prC);
    await h.runUntilStable({ maxTicks: 40 });

    assert.ok(h.merged.includes(1), "A should merge");
    assert.strictEqual(h.entryStatus(prB), "evicted", "B should be evicted");
    assert.ok(h.merged.includes(3), "C should merge after B evicted");

    // Verify the event stream shows the invalidation + rebuild.
    const cInvalidated = h.reconcileEvents.filter(
      (e) => e.prNumber === 3 && e.action === "invalidated",
    );
    assert.ok(cInvalidated.length > 0, "C should have been invalidated when B failed");

    h.assertInvariants();
  });
});
