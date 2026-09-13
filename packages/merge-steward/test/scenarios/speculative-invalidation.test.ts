import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHarness, type SimPR } from "../harness.ts";

const prA: SimPR = { number: 1, branch: "feat-a", files: [{ path: "a.ts", content: "a" }] };
const prC: SimPR = { number: 3, branch: "feat-c", files: [{ path: "c.ts", content: "c" }] };

describe("speculative cascade invalidation", () => {
  it("a mid-chain repair hold invalidates downstream without letting C bypass", async () => {
    // B always fails CI. A and C should merge.
    const prB: SimPR = { number: 2, branch: "feat-b", files: [{ path: "b.ts", content: "b" }] };

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
    assert.strictEqual(h.entryStatus(prB), "validating", "B should await repair");
    assert.ok(!h.merged.includes(3), "C must not bypass B");

    h.assertInvariants();
  });

  it("conflict in spec branch remains repairable", async () => {
    // B and C both modify shared.ts. B merges, C conflicts.
    const prBConflict: SimPR = { number: 2, branch: "feat-b-shared", files: [{ path: "shared.ts", content: "B" }] };
    const prCConflict: SimPR = { number: 3, branch: "feat-c-shared", files: [{ path: "shared.ts", content: "C" }] };

    const h = await createHarness({
      ciRule: () => "pass",
      speculativeDepth: 3,
      maxRetries: 0,
    });
    await h.enqueue(prA);
    await h.enqueue(prBConflict);
    await h.enqueue(prCConflict);
    await h.runUntilStable({ maxTicks: 40 });

    // A merges, B merges (no conflict with A). C conflicts with B.
    assert.ok(h.merged.includes(1), "A should merge");
    assert.ok(h.merged.includes(2), "B should merge");
    assert.strictEqual(h.entryStatus(prCConflict), "validating", "C should await repair");
    assert.equal(h.evicted.length, 0);

    h.assertInvariants();
  });
});
