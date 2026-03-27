import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHarness, type SimPR } from "../harness.ts";

describe("conflict chains", () => {
  it("A merges, B and C conflict with A — both evicted (maxRetries: 0)", async () => {
    // All three PRs modify shared.ts. A merges first.
    // B and C both conflict after A merges.
    const prA: SimPR = { number: 1, branch: "feat-a", files: [{ path: "shared.ts", content: "A" }] };
    const prB: SimPR = { number: 2, branch: "feat-b", files: [{ path: "shared.ts", content: "B" }] };
    const prC: SimPR = { number: 3, branch: "feat-c", files: [{ path: "shared.ts", content: "C" }] };

    const h = await createHarness({ ciRule: () => "pass", maxRetries: 0 });
    await h.enqueue(prA);
    await h.enqueue(prB);
    await h.enqueue(prC);
    await h.runUntilStable({ maxTicks: 40 });

    assert.deepStrictEqual(h.merged, [1]);
    assert.ok(h.evicted.includes(2));
    assert.ok(h.evicted.includes(3));
    assert.strictEqual(h.activeEntries.length, 0);
    h.assertInvariants();
  });

  it("independent PRs pass through even when earlier PR is evicted", async () => {
    // A modifies shared.ts, B modifies shared.ts (conflicts), C modifies other.ts (independent).
    const prA: SimPR = { number: 1, branch: "feat-a", files: [{ path: "shared.ts", content: "A" }] };
    const prB: SimPR = { number: 2, branch: "feat-b", files: [{ path: "shared.ts", content: "B" }] };
    const prC: SimPR = { number: 3, branch: "feat-c", files: [{ path: "other.ts", content: "C" }] };

    const h = await createHarness({ ciRule: () => "pass", maxRetries: 0 });
    await h.enqueue(prA);
    await h.enqueue(prB);
    await h.enqueue(prC);
    await h.runUntilStable({ maxTicks: 40 });

    assert.ok(h.merged.includes(1), "A should merge");
    assert.strictEqual(h.entryStatus(prB), "evicted", "B should be evicted (conflicts)");
    assert.ok(h.merged.includes(3), "C should merge (no conflict)");
    h.assertInvariants();
  });

  it("two distinct conflict groups are handled independently", async () => {
    // A and B conflict (shared-1.ts), C and D conflict (shared-2.ts).
    // A and C should merge; B and D should be evicted.
    const prA: SimPR = { number: 1, branch: "feat-a", files: [{ path: "shared-1.ts", content: "A" }] };
    const prB: SimPR = { number: 2, branch: "feat-b", files: [{ path: "shared-1.ts", content: "B" }] };
    const prC: SimPR = { number: 3, branch: "feat-c", files: [{ path: "shared-2.ts", content: "C" }] };
    const prD: SimPR = { number: 4, branch: "feat-d", files: [{ path: "shared-2.ts", content: "D" }] };

    const h = await createHarness({ ciRule: () => "pass", maxRetries: 0 });
    await h.enqueue(prA);
    await h.enqueue(prB);
    await h.enqueue(prC);
    await h.enqueue(prD);
    await h.runUntilStable({ maxTicks: 60 });

    assert.ok(h.merged.includes(1), "A should merge");
    assert.strictEqual(h.entryStatus(prB), "evicted", "B should be evicted");
    assert.ok(h.merged.includes(3), "C should merge");
    assert.strictEqual(h.entryStatus(prD), "evicted", "D should be evicted");
    h.assertInvariants();
  });
});
