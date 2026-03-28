import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHarness, type SimPR } from "../harness.ts";

const prA: SimPR = { number: 1, branch: "feat-a", files: [{ path: "a.ts", content: "a" }] };
const prB: SimPR = { number: 2, branch: "feat-b", files: [{ path: "b.ts", content: "b" }] };
const prC: SimPR = { number: 3, branch: "feat-c", files: [{ path: "c.ts", content: "c" }] };
const prD: SimPR = { number: 4, branch: "feat-d", files: [{ path: "d.ts", content: "d" }] };

describe("speculative depth limit", () => {
  it("only speculativeDepth entries get spec branches", async () => {
    const h = await createHarness({ ciRule: () => "pass", speculativeDepth: 2 });
    await h.enqueue(prA);
    await h.enqueue(prB);
    await h.enqueue(prC);
    await h.enqueue(prD);

    // Run a few ticks to build speculative branches.
    for (let i = 0; i < 8; i++) await h.tick();

    const entries = h.entries;
    const withSpec = entries.filter((e) => e.specBranch !== null);
    assert.ok(
      withSpec.length <= 2,
      `Expected at most 2 spec branches (depth=2), got ${withSpec.length}: ${withSpec.map((e) => `#${e.prNumber}`).join(", ")}`,
    );

    // C and D should still be in queued (not speculated).
    const cEntry = entries.find((e) => e.prNumber === 3)!;
    const dEntry = entries.find((e) => e.prNumber === 4)!;
    assert.strictEqual(cEntry.status, "queued", "C should be queued (outside depth)");
    assert.strictEqual(dEntry.status, "queued", "D should be queued (outside depth)");

    h.assertInvariants();
  });

  it("depth window advances as head merges", async () => {
    const h = await createHarness({ ciRule: () => "pass", speculativeDepth: 2 });
    await h.enqueue(prA);
    await h.enqueue(prB);
    await h.enqueue(prC);

    // Run until A merges.
    await h.runUntilStable({ maxTicks: 30 });

    // All should merge because the depth window slides.
    // A merges → B is head, C enters depth window → B merges → C merges.
    assert.deepStrictEqual(h.merged, [1, 2, 3]);
    h.assertInvariants();
  });

  it("depth 1 behaves like serial mode — only one entry processing at a time", async () => {
    const h = await createHarness({ ciRule: () => "pass", speculativeDepth: 1 });
    await h.enqueue(prA);
    await h.enqueue(prB);

    // After 2 ticks: A should be preparing_head or validating,
    // B should still be queued (not speculated in parallel).
    await h.tick(); // A: queued → preparing_head
    await h.tick(); // A: preparing_head → validating

    const bEntry = h.entries.find((e) => e.prNumber === 2)!;
    assert.strictEqual(bEntry.status, "queued", "B should still be queued while A is validating (depth-1)");
    assert.strictEqual(bEntry.specBranch, null, "B should have no spec branch in depth-1 mode");

    await h.runUntilStable();
    assert.deepStrictEqual(h.merged, [1, 2]);
    h.assertInvariants();
  });
});
