import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHarness, type SimPR } from "../harness.ts";

describe("repair lifecycle", () => {
  it("queue pauses at repair_in_progress until completeRepair is called", async () => {
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

    // autoCompleteRepairs OFF — we control repair timing.
    const h = await createHarness({
      ciRule: () => "pass",
      repairBudget: 2,
      autoCompleteRepairs: false,
    });
    await h.enqueue(prA);
    await h.enqueue(prB);

    // Run until A merges and B hits the conflict.
    for (let i = 0; i < 20; i++) await h.tick();

    assert.ok(h.merged.includes(1), "PR #1 should merge");
    const bEntry = h.entries.find((e) => e.prNumber === 2)!;
    assert.strictEqual(bEntry.status, "repair_in_progress",
      "PR #2 should be paused in repair_in_progress");

    // Tick several more times — queue should NOT advance.
    const statusBefore = bEntry.status;
    await h.tick();
    await h.tick();
    await h.tick();
    assert.strictEqual(bEntry.status, "repair_in_progress",
      "PR #2 should still be in repair_in_progress after multiple ticks");

    // Verify a repair request was dispatched.
    assert.ok(h.repairRequests.length > 0, "Should have dispatched repair");
    assert.strictEqual(h.repairRequests[0]!.failureClass, "integration_conflict");

    // Now simulate PatchRelay completing the repair.
    // (In reality, the agent would fix the branch and call back.)
    // We still need to fix the actual conflict in git for the rebase to succeed.
    const git = await import("isomorphic-git");
    const vol = h.gitSim.volume;
    const dir = h.gitSim.repoDir;
    await git.default.deleteBranch({ fs: vol, dir, ref: prB.branch });
    const mainSha = await git.default.resolveRef({ fs: vol, dir, ref: "main" });
    await git.default.branch({ fs: vol, dir, ref: prB.branch, object: mainSha });
    await git.default.checkout({ fs: vol, dir, ref: prB.branch, force: true });
    await h.gitSim.commitFile("readme.md", "version A + B", "resolve conflict");
    await git.default.checkout({ fs: vol, dir, ref: "main", force: true });

    // Complete the repair via callback.
    const completed = h.completeRepair(bEntry.id);
    assert.ok(completed, "completeRepair should return true");
    assert.strictEqual(bEntry.status, "preparing_head",
      "PR #2 should be back to preparing_head after repair");

    // Now run to completion.
    for (let i = 0; i < 20; i++) await h.tick();
    assert.ok(h.merged.includes(2), "PR #2 should merge after repair");

    h.assertInvariants();
  });

  it("completeRepair returns false for non-repair_in_progress entries", async () => {
    const h = await createHarness({ autoCompleteRepairs: false });
    const prA: SimPR = { number: 1, branch: "feat-a", files: [{ path: "a.ts", content: "a" }] };
    await h.enqueue(prA);

    const entry = h.entries[0]!;
    assert.strictEqual(entry.status, "queued");
    assert.strictEqual(h.completeRepair(entry.id), false,
      "Should reject completeRepair on non-repair_in_progress entry");
    assert.strictEqual(h.completeRepair("nonexistent"), false,
      "Should reject completeRepair for unknown entry");
  });

  it("repair budget is enforced across the pause boundary", async () => {
    const prA: SimPR = {
      number: 1,
      branch: "feat-a",
      files: [{ path: "shared.ts", content: "version A" }],
    };
    const prB: SimPR = {
      number: 2,
      branch: "feat-b",
      files: [{ path: "shared.ts", content: "version B" }],
    };

    // Budget of 1 — one repair attempt, then evict.
    const h = await createHarness({
      ciRule: () => "pass",
      repairBudget: 1,
      autoCompleteRepairs: false,
    });
    await h.enqueue(prA);
    await h.enqueue(prB);

    // Run until B hits repair_in_progress.
    for (let i = 0; i < 20; i++) await h.tick();
    assert.ok(h.merged.includes(1), "PR #1 should merge");
    const bEntry = h.entries.find((e) => e.prNumber === 2)!;
    assert.strictEqual(bEntry.status, "repair_in_progress");
    assert.strictEqual(bEntry.repairAttempts, 1);

    // Complete repair but DON'T fix the conflict — branch still conflicts.
    h.completeRepair(bEntry.id);

    // Run more ticks — B should hit repair_requested again but now
    // budget is exhausted, so it goes to evicted.
    for (let i = 0; i < 20; i++) await h.tick();
    assert.strictEqual(bEntry.status, "evicted",
      "PR #2 should be evicted after repair budget exhausted");

    h.assertInvariants();
  });
});
