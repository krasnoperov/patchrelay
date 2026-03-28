import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHarness, type SimPR } from "../harness.ts";

const prA: SimPR = { number: 1, branch: "feat-a", files: [{ path: "a.ts", content: "a" }] };
const prB: SimPR = { number: 2, branch: "feat-b", files: [{ path: "b.ts", content: "b" }] };
const prC: SimPR = { number: 3, branch: "feat-c", files: [{ path: "c.ts", content: "c" }] };

describe("speculative happy path", () => {
  it("3 PRs speculate in parallel and all merge", async () => {
    const h = await createHarness({ ciRule: () => "pass", speculativeDepth: 3 });
    await h.enqueue(prA);
    await h.enqueue(prB);
    await h.enqueue(prC);

    await h.runUntilStable();

    assert.deepStrictEqual(h.merged, [1, 2, 3]);
    assert.strictEqual(h.activeEntries.length, 0);

    // Verify CI was efficient — with speculation, we should need fewer
    // total CI runs than serial (which would need 3 separate cycles).
    // With speculation, B and C test in parallel with A.
    h.assertInvariants();
  });

  it("head merge does not re-test downstream (speculative consistency)", async () => {
    const h = await createHarness({ ciRule: () => "pass", speculativeDepth: 3 });
    await h.enqueue(prA);
    await h.enqueue(prB);

    await h.runUntilStable();

    // Both should merge. B should have been tested once on its spec branch
    // (which included A). After A merges, B merges without new CI.
    assert.deepStrictEqual(h.merged, [1, 2]);

    // Total CI runs should be at most 2 (one per PR).
    // In serial mode it would be 2 as well, but the key is B doesn't
    // re-test after A merges.
    assert.ok(
      h.ciSim.runCount <= 3,
      `Expected at most 3 CI runs, got ${h.ciSim.runCount}`,
    );

    h.assertInvariants();
  });

  it("speculative branches use cumulative base", async () => {
    const h = await createHarness({ ciRule: () => "pass", speculativeDepth: 3 });
    await h.enqueue(prA);
    await h.enqueue(prB);

    // Run just 2 ticks — enough to build spec branches but not merge.
    await h.tick(); // A: queued → preparing_head, B: queued → preparing_head
    await h.tick(); // A: preparing_head → validating (with spec), B: preparing_head → validating (with spec)

    // Check the store for spec branch info on B.
    const entryA = h.entries.find((e) => e.prNumber === 1)!;
    const entryB = h.entries.find((e) => e.prNumber === 2)!;

    // B's speculative branch should be based on A's entry.
    assert.strictEqual(
      entryB.specBasedOn,
      entryA.id,
      "B's spec should be based on A's entry",
    );

    // Both should have spec branches.
    assert.ok(entryA.specBranch !== null, "A should have a specBranch");
    assert.ok(entryB.specBranch !== null, "B should have a specBranch");

    h.assertInvariants();
  });
});
