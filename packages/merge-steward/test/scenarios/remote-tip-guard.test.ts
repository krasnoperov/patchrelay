import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHarness, type SimPR } from "../harness.ts";

const prA: SimPR = { number: 1, branch: "feat-a", files: [{ path: "a.ts", content: "a" }] };

describe("remote tip guard", () => {
  it("detects external push to PR branch and resets entry", async () => {
    const h = await createHarness({ ciRule: () => "pass" });
    await h.enqueue(prA);

    // Tick 1: queued → preparing_head
    await h.tick();

    // Force-push to the PR branch (simulates external push).
    // forcePush calls store.updateHead which resets to "queued" + gen++.
    await h.forcePush(1);

    const afterPush = h.entries[0]!;
    assert.strictEqual(afterPush.status, "queued");
    assert.strictEqual(afterPush.generation, 1);

    // Should eventually merge after re-processing with new head
    await h.runUntilStable();
    assert.deepStrictEqual(h.merged, [1]);
    h.assertInvariants();
  });

  it("merges cleanly when PR branch is not externally pushed", async () => {
    const h = await createHarness({ ciRule: () => "pass" });
    await h.enqueue(prA);

    await h.runUntilStable();

    assert.deepStrictEqual(h.merged, [1]);
    assert.strictEqual(h.entries[0]!.status, "merged");
    h.assertInvariants();
  });
});
