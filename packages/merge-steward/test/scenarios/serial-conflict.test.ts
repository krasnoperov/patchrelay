import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHarness, type SimPR } from "../harness.ts";

describe("serial conflict handling", () => {
  it("detects conflict at head and dispatches repair before evicting", async () => {
    // A and B both modify readme.md — after A merges, B conflicts with main.
    const prA: SimPR = {
      number: 1,
      branch: "feat-a",
      files: [{ path: "readme.md", content: "version A" }],
    };
    const prB: SimPR = {
      number: 2,
      branch: "feat-b",
      files: [{ path: "readme.md", content: "version B" }],
    };

    const h = await createHarness({ ciRule: () => "pass", repairBudget: 2 });
    await h.enqueue(prA);
    await h.enqueue(prB);
    await h.runUntilStable({ maxTicks: 30 });

    // A should merge (no conflict with original main).
    assert.ok(h.merged.includes(1), "PR #1 should be merged");

    // Repair requests should have been dispatched for B's conflict.
    assert.ok(
      h.repairRequests.length > 0,
      "Should have dispatched at least one repair request",
    );
    assert.strictEqual(h.repairRequests[0]!.failureClass, "integration_conflict");

    // B is eventually evicted because the sim doesn't resolve the conflict.
    assert.strictEqual(
      h.entryStatus(prB),
      "evicted",
      "PR #2 should be evicted after repair budget exhausted",
    );

    h.assertInvariants();
  });

  it("merges conflicting PR when repair resolves the conflict", async () => {
    // A and B both modify readme.md, but repair will resolve B's conflict.
    const prA: SimPR = {
      number: 1,
      branch: "feat-a",
      files: [{ path: "readme.md", content: "version A" }],
    };
    const prB: SimPR = {
      number: 2,
      branch: "feat-b",
      files: [{ path: "readme.md", content: "version B" }],
    };

    let repairCalled = false;
    const h = await createHarness({ ciRule: () => "pass", repairBudget: 2 });

    // Override repair dispatcher to actually resolve the conflict.
    // Simulates what PatchRelay's queue_repair agent would do: rewrite the
    // branch so it applies cleanly on top of current main.
    const originalRepair = h.repairSim.requestRepair.bind(h.repairSim);
    h.repairSim.requestRepair = async (ctx) => {
      await originalRepair(ctx);
      if (!repairCalled) {
        repairCalled = true;
        const git = await import("isomorphic-git");
        const vol = h.gitSim.volume;
        const dir = h.gitSim.repoDir;

        // Delete the conflicting branch and recreate it from current main.
        await git.default.deleteBranch({ fs: vol, dir, ref: prB.branch });
        const mainSha = await git.default.resolveRef({ fs: vol, dir, ref: "main" });
        await git.default.branch({ fs: vol, dir, ref: prB.branch, object: mainSha });
        await git.default.checkout({ fs: vol, dir, ref: prB.branch, force: true });
        // Re-apply B's change on top of current main (which now includes A).
        await h.gitSim.commitFile("readme.md", "version A + B", "resolve conflict");
        await git.default.checkout({ fs: vol, dir, ref: "main", force: true });
      }
    };

    await h.enqueue(prA);
    await h.enqueue(prB);
    await h.runUntilStable({ maxTicks: 30 });

    assert.ok(h.merged.includes(1), "PR #1 should merge");
    assert.ok(h.merged.includes(2), "PR #2 should merge after repair resolves conflict");
    assert.ok(repairCalled, "Repair should have been called");
    h.assertInvariants();
  });
});
