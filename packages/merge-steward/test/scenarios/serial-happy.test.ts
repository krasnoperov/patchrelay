import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHarness, type SimPR } from "../harness.ts";

const prA: SimPR = { number: 1, branch: "feat-a", files: [{ path: "a.ts", content: "a" }] };
const prB: SimPR = { number: 2, branch: "feat-b", files: [{ path: "b.ts", content: "b" }] };
const prC: SimPR = { number: 3, branch: "feat-c", files: [{ path: "c.ts", content: "c" }] };

describe("serial happy path", () => {
  it("merges 3 non-conflicting PRs in queue order", async () => {
    const h = await createHarness({ ciRule: () => "pass" });
    await h.enqueue(prA);
    await h.enqueue(prB);
    await h.enqueue(prC);
    await h.runUntilStable();

    assert.deepStrictEqual(h.merged, [1, 2, 3]);
    assert.strictEqual(h.activeEntries.length, 0);
    h.assertInvariants();
  });

  it("merges a single PR", async () => {
    const h = await createHarness({ ciRule: () => "pass" });
    await h.enqueue(prA);
    await h.runUntilStable();

    assert.deepStrictEqual(h.merged, [1]);
    h.assertInvariants();
  });

  it("handles empty queue without error", async () => {
    const h = await createHarness();
    await h.runUntilStable({ maxTicks: 5 });

    assert.strictEqual(h.merged.length, 0);
    assert.strictEqual(h.activeEntries.length, 0);
    h.assertInvariants();
  });
});
