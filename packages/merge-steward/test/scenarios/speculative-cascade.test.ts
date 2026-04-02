import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHarness, type SimPR } from "../harness.ts";

const prA: SimPR = { number: 1, branch: "feat-a", files: [{ path: "a.ts", content: "a" }] };
const prB: SimPR = { number: 2, branch: "feat-b", files: [{ path: "b.ts", content: "b" }] };
const prC: SimPR = { number: 3, branch: "feat-c", files: [{ path: "c.ts", content: "c" }] };

describe("speculative cascade merge", () => {
  it("B and C merge without re-CI after A merges", async () => {
    const h = await createHarness({ ciRule: () => "pass", speculativeDepth: 3 });
    await h.enqueue(prA);
    await h.enqueue(prB);
    await h.enqueue(prC);

    // Build phase: all three prepare and build spec branches.
    // Tick 1: all three promoted queued → preparing_head
    await h.tick();
    // Tick 2: all three build specs and enter validating (CI triggered)
    await h.tick();
    // Tick 3: CI passes for all three. A (head) → merging. B, C stay validating.
    await h.tick();
    // Tick 4: A merges (spec pushed to main). B is now head with CI already passed → merging.
    await h.tick();

    assert.deepStrictEqual(h.merged, [1], "A should have merged");
    assert.strictEqual(h.entries.find((e) => e.prNumber === 2)?.status, "merging",
      "B should be in merging (CI already passed, now head)");

    // Tick 5: B merges. C is now head with CI already passed → merging.
    await h.tick();
    assert.deepStrictEqual(h.merged, [1, 2], "A and B should have merged");

    // Tick 6: C merges.
    await h.tick();
    assert.deepStrictEqual(h.merged, [1, 2, 3], "All three should have merged");

    // Count CI triggers: each PR should have exactly ONE CI run (no re-CI after cascade).
    const ciTriggered = h.reconcileEvents.filter((e) => e.action === "ci_triggered");
    assert.strictEqual(ciTriggered.length, 3, "Should have exactly 3 CI triggers (one per PR, no re-CI)");

    h.assertInvariants();
  });

  it("evicting B rebuilds C without A", async () => {
    const h = await createHarness({
      ciRule: (files) => files.includes("b.ts") ? "fail" : "pass",
      speculativeDepth: 3,
      maxRetries: 0,
    });
    await h.enqueue(prA);
    await h.enqueue(prB);
    await h.enqueue(prC);

    await h.runUntilStable({ maxTicks: 30 });

    // A merges, B is evicted (CI fails), C rebuilds and merges
    assert.ok(h.merged.includes(1), "A should merge");
    assert.ok(h.merged.includes(3), "C should merge after rebuild");
    assert.ok(h.evicted.includes(2), "B should be evicted");

    // Verify merge order: A first, then C
    const aIdx = h.merged.indexOf(1);
    const cIdx = h.merged.indexOf(3);
    assert.ok(aIdx < cIdx, "A should merge before C");

    h.assertInvariants();
  });

  it("spec chain is valid: B's spec is descendant of A's spec", async () => {
    const h = await createHarness({ ciRule: () => "pass", speculativeDepth: 3 });
    await h.enqueue(prA);
    await h.enqueue(prB);

    // Run until both are validating (specs built)
    await h.tick(); // promote
    await h.tick(); // build specs

    const entryA = h.entries.find((e) => e.prNumber === 1)!;
    const entryB = h.entries.find((e) => e.prNumber === 2)!;

    assert.ok(entryA.specBranch, "A should have a spec branch");
    assert.ok(entryB.specBranch, "B should have a spec branch");
    assert.strictEqual(entryB.specBasedOn, entryA.id, "B's spec should be based on A's entry");

    // Verify in git that B's spec is a descendant of A's spec
    const isDescendant = await h.gitSim.isAncestor(entryA.specSha!, entryB.specSha!);
    assert.ok(isDescendant, "B's spec SHA should be a descendant of A's spec SHA");

    h.assertInvariants();
  });
});
