import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHarness, type SimPR } from "../harness.ts";

const prB: SimPR = {
  number: 2,
  branch: "feat-b",
  files: [{ path: "readme.md", content: "version B" }],
};

function getEntry(h: ReturnType<Awaited<typeof createHarness>>, prNumber: number) {
  return h.entries.find((e) => e.prNumber === prNumber)!;
}

describe("repair lifecycle", () => {
  it("queue pauses at repair_in_progress until completeRepair is called", async () => {
    const prA: SimPR = {
      number: 1,
      branch: "feat-a",
      files: [{ path: "readme.md", content: "version A" }],
    };

    const h = await createHarness({
      ciRule: () => "pass",
      repairBudget: 2,
      autoCompleteRepairs: false,
    });
    await h.enqueue(prA);
    await h.enqueue(prB);

    for (let i = 0; i < 20; i++) await h.tick();

    assert.ok(h.merged.includes(1), "PR #1 should merge");
    assert.strictEqual(getEntry(h, 2).status, "repair_in_progress",
      "PR #2 should be paused in repair_in_progress");

    // Tick several more times — queue should NOT advance.
    await h.tick();
    await h.tick();
    await h.tick();
    assert.strictEqual(getEntry(h, 2).status, "repair_in_progress",
      "PR #2 should still be in repair_in_progress after multiple ticks");

    assert.ok(h.repairRequests.length > 0, "Should have dispatched repair");
    assert.strictEqual(h.repairRequests[0]!.failureClass, "integration_conflict");

    // Fix the conflict in git, then complete repair.
    const git = await import("isomorphic-git");
    const vol = h.gitSim.volume;
    const dir = h.gitSim.repoDir;
    await git.default.deleteBranch({ fs: vol, dir, ref: prB.branch });
    const mainSha = await git.default.resolveRef({ fs: vol, dir, ref: "main" });
    await git.default.branch({ fs: vol, dir, ref: prB.branch, object: mainSha });
    await git.default.checkout({ fs: vol, dir, ref: prB.branch, force: true });
    await h.gitSim.commitFile("readme.md", "version A + B", "resolve conflict");
    await git.default.checkout({ fs: vol, dir, ref: "main", force: true });

    const entryId = getEntry(h, 2).id;
    const completed = h.completeRepair(entryId);
    assert.ok(completed, "completeRepair should return true");
    assert.strictEqual(getEntry(h, 2).status, "preparing_head",
      "PR #2 should be back to preparing_head after repair");

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
    const prBShared: SimPR = {
      number: 2,
      branch: "feat-b-shared",
      files: [{ path: "shared.ts", content: "version B" }],
    };

    const h = await createHarness({
      ciRule: () => "pass",
      repairBudget: 1,
      autoCompleteRepairs: false,
    });
    await h.enqueue(prA);
    await h.enqueue(prBShared);

    for (let i = 0; i < 20; i++) await h.tick();
    assert.ok(h.merged.includes(1), "PR #1 should merge");
    assert.strictEqual(getEntry(h, 2).status, "repair_in_progress");
    assert.strictEqual(getEntry(h, 2).repairAttempts, 1);

    // Complete repair but DON'T fix the conflict.
    h.completeRepair(getEntry(h, 2).id);

    // B should hit repair_requested again but budget is exhausted → evicted.
    for (let i = 0; i < 20; i++) await h.tick();
    assert.strictEqual(getEntry(h, 2).status, "evicted",
      "PR #2 should be evicted after repair budget exhausted");

    h.assertInvariants();
  });
});
