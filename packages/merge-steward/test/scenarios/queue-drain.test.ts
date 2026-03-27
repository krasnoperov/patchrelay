import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHarness, type SimPR } from "../harness.ts";

const prA: SimPR = { number: 1, branch: "feat-a", files: [{ path: "a.ts", content: "a" }] };
const prB: SimPR = { number: 2, branch: "feat-b", files: [{ path: "b.ts", content: "b" }] };
const prC: SimPR = { number: 3, branch: "feat-c", files: [{ path: "c.ts", content: "c" }] };

describe("queue drain under adversarial conditions", () => {
  it("drains queue via eviction when all PRs fail CI", async () => {
    const h = await createHarness({
      ciRule: () => "fail",
      maxRetries: 1,
      flakyRetries: 0,
    });
    await h.enqueue(prA);
    await h.enqueue(prB);
    await h.enqueue(prC);
    await h.runUntilStable({ maxTicks: 60 });

    // Queue must drain — nothing stuck.
    assert.strictEqual(h.activeEntries.length, 0, "Queue should be fully drained");
    assert.strictEqual(h.evicted.length, 3, "All 3 PRs should be evicted");
    assert.strictEqual(h.merged.length, 0, "Nothing should merge");
    h.assertInvariants();
  });

  it("mixes merged and evicted when some pass and some fail", async () => {
    const h = await createHarness({
      ciRule: (files) => {
        // Only b.ts fails.
        if (files.includes("b.ts")) return "fail";
        return "pass";
      },
      maxRetries: 0, // Evict immediately on failure.
    });
    await h.enqueue(prA);
    await h.enqueue(prB);
    await h.enqueue(prC);
    await h.runUntilStable({ maxTicks: 50 });

    assert.ok(h.merged.includes(1), "PR #1 should merge");
    assert.ok(h.merged.includes(3), "PR #3 should merge");
    assert.strictEqual(h.entryStatus(prB), "evicted");
    assert.strictEqual(h.activeEntries.length, 0);
    h.assertInvariants();
  });
});
