import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHarness, type SimPR } from "../harness.ts";

const prA: SimPR = { number: 1, branch: "feat-a", files: [{ path: "a.ts", content: "a" }] };
const prB: SimPR = { number: 2, branch: "feat-b", files: [{ path: "b.ts", content: "b" }] };
const prC: SimPR = { number: 3, branch: "feat-c", files: [{ path: "c.ts", content: "c" }] };

describe("queue blocking under adversarial conditions", () => {
  it("keeps the first failing PR repairable and preserves the rest of the queue", async () => {
    const h = await createHarness({
      ciRule: () => "fail",
      maxRetries: 1,
      flakyRetries: 0,
    });
    await h.enqueue(prA);
    await h.enqueue(prB);
    await h.enqueue(prC);
    await h.runUntilStable({ maxTicks: 60 });

    assert.strictEqual(h.activeEntries.length, 3);
    assert.strictEqual(h.entryStatus(prA), "validating");
    assert.strictEqual(h.evicted.length, 0);
    assert.strictEqual(h.merged.length, 0, "Nothing should merge");
    h.assertInvariants();
  });

  it("lands the green prefix then waits on the first failing candidate", async () => {
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
    assert.ok(!h.merged.includes(3), "PR #3 must not bypass #2");
    assert.strictEqual(h.entryStatus(prB), "validating");
    assert.strictEqual(h.activeEntries.length, 2);
    h.assertInvariants();
  });
});
