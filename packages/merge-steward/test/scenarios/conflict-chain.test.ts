import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHarness, type SimPR } from "../harness.ts";

describe("conflict chains", () => {
  it("A merges and B remains repairable while C waits behind it", async () => {
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
    assert.strictEqual(h.entryStatus(prB), "validating");
    assert.notStrictEqual(h.entryStatus(prC), "merged");
    assert.strictEqual(h.activeEntries.length, 2);
    assert.deepEqual(h.evicted, []);
    h.assertInvariants();
  });

  it("preserves serial order even when a later PR is independent", async () => {
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
    assert.strictEqual(h.entryStatus(prB), "validating", "B should await repair");
    assert.notStrictEqual(h.entryStatus(prC), "merged", "C must not bypass B");
    h.assertInvariants();
  });

  it("the first unresolved conflict blocks the later train without eviction", async () => {
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
    assert.strictEqual(h.entryStatus(prB), "validating", "B should await repair");
    assert.notStrictEqual(h.entryStatus(prC), "merged", "C should wait behind B");
    assert.notStrictEqual(h.entryStatus(prD), "merged", "D should wait behind B");
    h.assertInvariants();
  });
});
