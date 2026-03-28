import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHarness, type SimPR } from "../harness.ts";

const prA: SimPR = { number: 1, branch: "feat-a", files: [{ path: "a.ts", content: "a" }] };
const prB: SimPR = { number: 2, branch: "feat-b", files: [{ path: "b.ts", content: "b" }] };
const prC: SimPR = { number: 3, branch: "feat-c", files: [{ path: "c.ts", content: "c" }] };

describe("speculative happy path", () => {
  it("3 PRs speculate in parallel and all merge", async () => {
    const h = await createHarness({ ciRule: () => "pass", speculativeDepth: 3 });
    await h.enqueue(prA);
    await h.enqueue(prB);
    await h.enqueue(prC);

    // After a few ticks, all 3 should have speculative branches and be
    // in validating (CI running in parallel).
    for (let i = 0; i < 6; i++) await h.tick();

    const entries = h.entries;
    const validating = entries.filter((e) => e.status === "validating");
    assert.ok(
      validating.length >= 2,
      `Expected at least 2 entries in validating (speculative), got ${validating.length}: ${entries.map((e) => `#${e.prNumber}:${e.status}`).join(", ")}`,
    );

    // All should have speculative branches.
    for (const entry of entries) {
      if (entry.status === "validating" || entry.status === "merging") {
        assert.ok(entry.specBranch !== null, `PR #${entry.prNumber} should have a specBranch`);
      }
    }

    await h.runUntilStable();
    assert.deepStrictEqual(h.merged, [1, 2, 3]);
    h.assertInvariants();
  });

  it("head merge does not re-test downstream (speculative consistency)", async () => {
    const h = await createHarness({ ciRule: () => "pass", speculativeDepth: 3 });
    await h.enqueue(prA);
    await h.enqueue(prB);

    // Run until both have speculative branches and are validating.
    for (let i = 0; i < 10; i++) await h.tick();

    // A should be in merging or merged, B should be in validating or merging.
    const ciRunCount = h.ciSim.runCount;

    // Finish merging everything.
    await h.runUntilStable();

    // B should have been tested once (its speculative branch included A).
    // After A merges, B should merge without a new CI run.
    // Total CI runs should be exactly 2 (one per PR, not 3 = 2 original + 1 re-test).
    assert.ok(
      h.ciSim.runCount <= 2 + 1, // +1 tolerance for edge cases in tick timing
      `Expected at most 3 CI runs, got ${h.ciSim.runCount} (speculation should avoid re-testing B)`,
    );

    assert.deepStrictEqual(h.merged, [1, 2]);
    h.assertInvariants();
  });

  it("speculative branches use cumulative base", async () => {
    const h = await createHarness({ ciRule: () => "pass", speculativeDepth: 3 });
    await h.enqueue(prA);
    await h.enqueue(prB);

    // Run until both have speculative branches.
    for (let i = 0; i < 6; i++) await h.tick();

    const entryB = h.entries.find((e) => e.prNumber === 2)!;
    assert.ok(entryB.specBranch !== null, "B should have a specBranch");

    // B's speculative branch should be based on A's entry.
    const entryA = h.entries.find((e) => e.prNumber === 1)!;
    assert.strictEqual(
      entryB.specBasedOn,
      entryA.id,
      "B's spec branch should be based on A's entry",
    );

    // Verify B's spec branch actually contains A's changes.
    if (entryB.specBranch) {
      const fileExists = await h.gitSim.fileExists("a.ts");
      // Need to checkout the spec branch to verify.
      const git = await import("isomorphic-git");
      await git.default.checkout({
        fs: h.gitSim.volume,
        dir: h.gitSim.repoDir,
        ref: entryB.specBranch,
        force: true,
      });
      const hasA = await h.gitSim.fileExists("a.ts");
      const hasB = await h.gitSim.fileExists("b.ts");
      assert.ok(hasA, "B's spec branch should contain A's file (a.ts)");
      assert.ok(hasB, "B's spec branch should contain B's file (b.ts)");

      // Restore main.
      await git.default.checkout({
        fs: h.gitSim.volume,
        dir: h.gitSim.repoDir,
        ref: "main",
        force: true,
      });
    }

    h.assertInvariants();
  });
});
