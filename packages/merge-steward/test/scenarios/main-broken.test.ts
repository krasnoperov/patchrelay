import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHarness, type SimPR } from "../harness.ts";
import type { CIStatus } from "../../src/types.ts";

const prA: SimPR = { number: 1, branch: "feat-a", files: [{ path: "a.ts", content: "a" }] };
const prPriority: SimPR = { number: 2, branch: "feat-priority", files: [{ path: "priority.ts", content: "priority" }], priority: 1 };

// The queue gates only on its own speculative-SHA CI. main's own CI is information-only
// and never controls queue advancement.
describe("main CI is ignored by the queue", () => {
  it("does not pause the queue when main CI is red — a green spec lands anyway", async () => {
    const h = await createHarness({ ciRule: () => "pass" });
    // main is red the whole time.
    h.ciSim.getMainStatus = async () => "fail";

    await h.enqueue(prA);
    await h.runUntilStable();

    assert.deepStrictEqual(h.merged, [1], "green spec should land even though main CI is red");
    h.assertInvariants();
  });

  it("does not wait for main CI when it is pending — lands immediately", async () => {
    const h = await createHarness({ ciRule: () => "pass" });
    // main never settles (its own post-merge CI keeps running).
    h.ciSim.getMainStatus = async () => "pending";

    await h.enqueue(prA);
    await h.runUntilStable();

    assert.deepStrictEqual(h.merged, [1], "should land without waiting for main CI to settle");
    h.assertInvariants();
  });

  it("lands downstream entries back-to-back without waiting for main's post-merge CI", async () => {
    const h = await createHarness({ ciRule: () => "pass", speculativeDepth: 2 });
    // main's own CI is perpetually pending; the queue must not wait for it between landings.
    h.ciSim.getMainStatus = async () => "pending";

    await h.enqueue(prA);
    await h.enqueue({ number: 3, branch: "feat-b", files: [{ path: "b.ts", content: "b" }] });
    await h.runUntilStable();

    assert.deepStrictEqual(h.merged, [1, 3], "both entries should land without main-CI gating between them");
    h.assertInvariants();
  });

  it("keeps merge order while ignoring red main — priority lands first, both land", async () => {
    const mainStatus: CIStatus = "fail";
    const h = await createHarness({ ciRule: () => "pass" });
    h.ciSim.getMainStatus = async () => mainStatus;

    await h.enqueue(prA);
    await h.enqueue(prPriority);
    await h.runUntilStable();

    assert.deepStrictEqual(h.merged, [2, 1], "priority merges first; both land despite red main");
    h.assertInvariants();
  });
});
