import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHarness, type SimPR } from "../harness.ts";

describe("re-admission after terminal state", () => {
  it("re-enqueue after dequeue succeeds and merges", async () => {
    const h = await createHarness({ ciRule: () => "pass" });
    const pr: SimPR = { number: 1, branch: "feat-x", files: [{ path: "x.ts", content: "x" }] };

    const entry1 = await h.enqueue(pr);
    await h.tick(); // queued → preparing_head

    // Dequeue (simulates label removal)
    h.dequeueByPR(1);
    assert.strictEqual(h.entryStatus(pr), "dequeued");

    // Re-enqueue the same PR number with a fresh branch
    const entry2 = await h.enqueue({ number: 1, branch: "feat-x-v2", files: [{ path: "x.ts", content: "x-v2" }] });
    assert.notStrictEqual(entry1.id, entry2.id, "should create a new entry");
    assert.strictEqual(entry2.status, "queued");

    await h.runUntilStable();
    assert.deepStrictEqual(h.merged, [1]);
    h.assertInvariants();
  });

  it("re-enqueue after eviction succeeds and merges", async () => {
    const pr: SimPR = { number: 1, branch: "feat-a", files: [{ path: "shared.ts", content: "A" }] };
    const blocker: SimPR = { number: 2, branch: "feat-b", files: [{ path: "shared.ts", content: "B" }] };

    // Set up: blocker merges first, PR conflicts and gets evicted (maxRetries: 0)
    const h = await createHarness({ ciRule: () => "pass", maxRetries: 0 });
    await h.enqueue(blocker);
    await h.enqueue(pr);
    await h.runUntilStable({ maxTicks: 30 });

    assert.deepStrictEqual(h.merged, [2]);
    assert.ok(h.evicted.includes(1), "PR 1 should be evicted");

    // Re-enqueue PR 1 with fresh content that doesn't conflict
    const entry2 = await h.enqueue({ number: 1, branch: "feat-a-v2", files: [{ path: "a-only.ts", content: "no conflict" }] });
    assert.strictEqual(entry2.status, "queued");

    await h.runUntilStable();
    assert.ok(h.merged.includes(1), "PR 1 should merge on second attempt");
    h.assertInvariants();
  });
});
