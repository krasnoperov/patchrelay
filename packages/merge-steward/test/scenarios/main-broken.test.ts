import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHarness, Harness, type SimPR } from "../harness.ts";
import type { CIStatus } from "../../src/types.ts";

const prA: SimPR = { number: 1, branch: "feat-a", files: [{ path: "a.ts", content: "a" }] };
const prPriority: SimPR = { number: 2, branch: "feat-priority", files: [{ path: "priority.ts", content: "priority" }], priority: 1 };

describe("main branch broken", () => {
  it("pauses queue when main CI is red, resumes when green", async () => {
    let mainStatus: CIStatus = "pass";

    const h = await createHarness({ ciRule: () => "pass" });

    // Inject getMainStatus into CI sim.
    h.ciSim.getMainStatus = async () => mainStatus;

    await h.enqueue(prA);

    // First tick promotes to preparing_head.
    await h.tick();
    assert.strictEqual(h.entries[0]!.status, "preparing_head");

    // Main goes red.
    mainStatus = "fail";

    // Tick — should stay in preparing_head (not rebase against broken main).
    await h.tick();
    assert.strictEqual(h.entries[0]!.status, "preparing_head",
      "Should stay in preparing_head when main is broken");

    // Tick again — still waiting for main to recover.
    await h.tick();
    assert.strictEqual(h.entries[0]!.status, "preparing_head");

    // Main goes green.
    mainStatus = "pass";

    // Now it should proceed.
    await h.tick();
    assert.strictEqual(h.entries[0]!.status, "validating",
      "Should advance to validating once main is green");

    await h.runUntilStable();
    assert.deepStrictEqual(h.merged, [1]);

    // mainGreen was set to false by onMainBroken (informational), but
    // the invariant is that no PR was merged while main was broken —
    // reset for the final invariant check since main recovered before merge.
    h.mainGreen = true;
    h.assertInvariants();
  });

  it("holds a ready-to-merge entry in merging when main is only pending, preserving spec + CI", async () => {
    // When main is pending (its own post-merge CI still running), the gate
    // must not throw away the green spec — the next entry has to stay in
    // merging so that a single tick can land it as soon as main settles.
    let mainStatus: CIStatus = "pass";
    const h = await createHarness({ ciRule: () => "pass" });
    h.ciSim.getMainStatus = async () => mainStatus;

    await h.enqueue(prA);
    // Drive the entry up to merging with a fully green spec.
    for (let i = 0; i < 20 && h.entries[0]?.status !== "merging"; i++) {
      await h.tick();
    }
    const entry = h.entries[0]!;
    assert.strictEqual(entry.status, "merging", "entry should reach merging");
    const specBranchBefore = entry.specBranch;
    const specShaBefore = entry.specSha;
    const ciRunIdBefore = entry.ciRunId;
    assert.ok(specBranchBefore, "spec branch should be set before the merge gate");
    assert.ok(specShaBefore, "spec SHA should be set before the merge gate");

    // Main turns pending (its own verification workflow is still running).
    mainStatus = "pending";

    await h.tick();
    const held = h.entries[0]!;
    assert.strictEqual(held.status, "merging", "pending main must not demote to preparing_head");
    assert.strictEqual(held.specBranch, specBranchBefore, "spec branch preserved");
    assert.strictEqual(held.specSha, specShaBefore, "spec SHA preserved");
    assert.strictEqual(held.ciRunId, ciRunIdBefore, "CI run ID preserved");

    // Main resolves green; the next tick should land it without re-running CI.
    mainStatus = "pass";
    await h.runUntilStable();
    assert.deepStrictEqual(h.merged, [1]);
  });

  it("lets a priority entry bypass red main while normal entries stay blocked behind it", async () => {
    let mainStatus: CIStatus = "fail";
    const h = await createHarness({ ciRule: () => "pass" });
    h.ciSim.getMainStatus = async () => mainStatus;

    await h.enqueue(prA);
    await h.enqueue(prPriority);

    await h.runUntilStable();

    assert.deepStrictEqual(h.merged, [2], "priority entry should merge ahead of the normal queue");
    assert.strictEqual(h.entryStatus(prA), "preparing_head", "normal entry should remain blocked on broken main");
    assert.strictEqual(h.entryStatus(prPriority), "merged");

    mainStatus = "pass";
    await h.runUntilStable();
    assert.deepStrictEqual(h.merged, [2, 1]);
  });
});
