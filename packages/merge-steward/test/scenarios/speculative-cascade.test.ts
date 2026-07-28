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

    // A reuses exact-head checks; B and C each run one integration CI.
    const ciTriggered = h.reconcileEvents.filter((e) => e.action === "ci_triggered");
    assert.strictEqual(ciTriggered.length, 2, "Only the two integration candidates should trigger CI");

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

  it("failed head push invalidates downstream specs", async () => {
    const h = await createHarness({ ciRule: () => "pass", speculativeDepth: 3 });
    await h.enqueue(prA);
    await h.enqueue(prB);
    await h.enqueue(prC);

    // Build phase: all three prepare and build spec branches.
    await h.tick(); // promote
    await h.tick(); // build specs, enter validating
    await h.tick(); // CI passes. A→merging, B/C stay validating

    assert.strictEqual(h.entries.find((e) => e.prNumber === 1)?.status, "merging");
    assert.strictEqual(h.entries.find((e) => e.prNumber === 2)?.status, "validating");
    assert.strictEqual(h.entries.find((e) => e.prNumber === 3)?.status, "validating");

    // Make the push to main fail for A.
    const originalPush = h.gitSim.push.bind(h.gitSim);
    let pushFailed = false;
    h.gitSim.push = async (branch?: string, force?: boolean, target?: string) => {
      if (target === "main" && !pushFailed) {
        pushFailed = true;
        throw new Error("push rejected: non-fast-forward");
      }
      return originalPush(branch, force, target);
    };

    // Tick 4: A tries to push spec:main → fails. A re-prepares.
    // B and C must be invalidated (their specs were based on A's old spec).
    await h.tick();

    assert.strictEqual(h.entries.find((e) => e.prNumber === 1)?.status, "preparing_head",
      "A should re-prepare after push failure");
    assert.strictEqual(h.entries.find((e) => e.prNumber === 2)?.status, "preparing_head",
      "B should be invalidated (downstream of failed head)");
    assert.strictEqual(h.entries.find((e) => e.prNumber === 3)?.status, "preparing_head",
      "C should be invalidated (downstream of failed head)");

    // Restore normal push — everything should eventually merge.
    h.gitSim.push = originalPush;
    await h.runUntilStable();
    assert.deepStrictEqual(h.merged, [1, 2, 3]);
    h.assertInvariants();
  });

  it("candidate chain is valid: B's integration SHA descends from A's exact head", async () => {
    const h = await createHarness({ ciRule: () => "pass", speculativeDepth: 3 });
    await h.enqueue(prA);
    await h.enqueue(prB);

    // Run until both are validating (specs built)
    await h.tick(); // promote
    await h.tick(); // build specs

    const entryA = h.entries.find((e) => e.prNumber === 1)!;
    const entryB = h.entries.find((e) => e.prNumber === 2)!;

    assert.equal(entryA.candidateKind, "head");
    assert.equal(entryA.candidateRef, null);
    assert.equal(entryA.candidateSha, entryA.headSha);
    assert.ok(entryB.candidateRef, "B should have an integration ref");
    assert.strictEqual(entryB.candidateBasedOn, entryA.id, "B's candidate should be based on A");

    // Verify in git that B's candidate is a descendant of A's candidate.
    const isDescendant = await h.gitSim.isAncestor(entryA.candidateSha!, entryB.candidateSha!);
    assert.ok(isDescendant, "B's candidate SHA should descend from A's candidate SHA");

    h.assertInvariants();
  });
});
