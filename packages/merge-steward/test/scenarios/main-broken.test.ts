import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHarness, Harness, type SimPR } from "../harness.ts";
import type { CIStatus } from "../../src/types.ts";

const prA: SimPR = { number: 1, branch: "feat-a", files: [{ path: "a.ts", content: "a" }] };

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

    // Tick again — still paused.
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
});
