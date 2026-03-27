import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHarness, type SimPR } from "../harness.ts";

const prA: SimPR = { number: 1, branch: "feat-a", files: [{ path: "a.ts", content: "a" }] };
const prB: SimPR = { number: 2, branch: "feat-b", files: [{ path: "b.ts", content: "b" }] };

describe("crash recovery", () => {
  it("converges to correct state after restart mid-processing", async () => {
    const h = await createHarness({ ciRule: () => "pass" });
    await h.enqueue(prA);
    await h.enqueue(prB);

    // Partial progress — run a few ticks.
    await h.tick();
    await h.tick();
    await h.tick();

    // Simulate crash + restart.
    h.restart();

    // Continue until stable.
    await h.runUntilStable();

    // Both should eventually merge.
    assert.deepStrictEqual(h.merged, [1, 2]);
    h.assertInvariants();
  });

  it("reconciler is idempotent — ticks on terminal state are no-ops", async () => {
    const h = await createHarness({ ciRule: () => "pass" });
    await h.enqueue(prA);
    await h.runUntilStable();

    // Entry is now merged (terminal).
    const stateAfterDrain = h.entries.map((e) => `${e.prNumber}:${e.status}`).join(",");

    // Additional ticks on a drained queue should be no-ops.
    await h.tick();
    await h.tick();
    const stateAfterExtra = h.entries.map((e) => `${e.prNumber}:${e.status}`).join(",");

    assert.strictEqual(stateAfterDrain, stateAfterExtra, "Reconciler should be idempotent on terminal state");
    h.assertInvariants();
  });
});
