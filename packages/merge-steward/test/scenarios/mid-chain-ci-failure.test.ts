import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHarness, type SimPR } from "../harness.ts";

const prA: SimPR = { number: 1, branch: "feat-a", files: [{ path: "a.ts", content: "a" }] };
const prB: SimPR = { number: 2, branch: "feat-b", files: [{ path: "b.ts", content: "b" }] };
const prC: SimPR = { number: 3, branch: "feat-c", files: [{ path: "c.ts", content: "c" }] };

describe("mid-chain CI failure", () => {
  it("evicts PR with persistent CI failure after repair budget exhausted", async () => {
    const h = await createHarness({
      // b.ts always fails CI.
      ciRule: (files) => (files.includes("b.ts") ? "fail" : "pass"),
      repairBudget: 2,
    });
    await h.enqueue(prA);
    await h.enqueue(prB);
    await h.enqueue(prC);
    await h.runUntilStable({ maxTicks: 50 });

    // A should merge (a.ts passes).
    assert.ok(h.merged.includes(1), "PR #1 should merge");
    // B should be evicted (b.ts always fails, budget exhausted).
    assert.strictEqual(h.entryStatus(prB), "evicted");
    // C should merge (c.ts passes, B was evicted so C becomes head).
    assert.ok(h.merged.includes(3), "PR #3 should merge after #2 evicted");

    h.assertInvariants();
  });
});
