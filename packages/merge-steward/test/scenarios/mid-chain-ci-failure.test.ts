import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHarness, type SimPR } from "../harness.ts";

const prA: SimPR = { number: 1, branch: "feat-a", files: [{ path: "a.ts", content: "a" }] };
const prB: SimPR = { number: 2, branch: "feat-b", files: [{ path: "b.ts", content: "b" }] };
const prC: SimPR = { number: 3, branch: "feat-c", files: [{ path: "c.ts", content: "c" }] };

describe("mid-chain CI failure", () => {
  it("retains PR with persistent CI failure and blocks later landing", async () => {
    const h = await createHarness({
      // b.ts always fails CI.
      ciRule: (files) => (files.includes("b.ts") ? "fail" : "pass"),
      maxRetries: 2,
    });
    await h.enqueue(prA);
    await h.enqueue(prB);
    await h.enqueue(prC);
    await h.runUntilStable({ maxTicks: 50 });

    // A should merge (a.ts passes).
    assert.ok(h.merged.includes(1), "PR #1 should merge");
    assert.strictEqual(h.entryStatus(prB), "validating");
    assert.ok(h.entries.find((entry) => entry.prNumber === 2)?.candidateRef);
    assert.ok(!h.merged.includes(3), "PR #3 must not bypass #2");
    assert.deepEqual(h.evicted, []);
    const blocked = h.entries.find((entry) => entry.prNumber === 2)!;
    h.store.transition(blocked.id, blocked.status, { waitDetail: "presentation text changed" });
    const cRunsBefore = h.reconcileEvents.filter((event) =>
      event.prNumber === 3 && event.action === "ci_triggered").length;
    for (let i = 0; i < 5; i++) await h.tick();
    assert.equal(
      h.reconcileEvents.filter((event) => event.prNumber === 3 && event.action === "ci_triggered").length,
      cRunsBefore,
      "C must not rebuild or rerun while B still awaits repair",
    );

    h.assertInvariants();
  });
});
