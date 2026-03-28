import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHarness, type SimPR } from "../harness.ts";

const prA: SimPR = { number: 1, branch: "feat-a", files: [{ path: "a.ts", content: "a" }] };

describe("revalidation before merge", () => {
  it("evicts PR when approval is withdrawn before merge", async () => {
    const h = await createHarness({ ciRule: () => "pass" });
    await h.enqueue(prA);

    // Advance to merging.
    await h.tick(); // queued → preparing_head
    await h.tick(); // preparing_head → validating
    await h.tick(); // validating → merging

    assert.strictEqual(h.entries[0]!.status, "merging");

    // Withdraw approval.
    h.githubSim.setReviewApproved(1, false);

    // Tick — revalidation should catch the withdrawn approval.
    await h.tick();
    assert.strictEqual(h.entries[0]!.status, "evicted",
      "Should evict when approval is withdrawn");

    assert.strictEqual(h.merged.length, 0, "Should not merge");
    h.assertInvariants();
  });

  it("resets to queued when PR head SHA changes before merge", async () => {
    const h = await createHarness({ ciRule: () => "pass" });
    await h.enqueue(prA);

    // Advance to merging.
    await h.tick(); // queued → preparing_head
    await h.tick(); // preparing_head → validating
    await h.tick(); // validating → merging

    assert.strictEqual(h.entries[0]!.status, "merging");

    // Simulate external force-push (GitHub shows different SHA).
    h.githubSim.updateSha(1, "externally-pushed-sha");

    // Tick — revalidation should detect SHA mismatch.
    await h.tick();
    assert.strictEqual(h.entries[0]!.status, "queued",
      "Should reset to queued on SHA mismatch");
    assert.strictEqual(h.entries[0]!.headSha, "externally-pushed-sha",
      "Should adopt the new SHA");
    assert.strictEqual(h.entries[0]!.generation, 1,
      "Generation should increment");

    h.assertInvariants();
  });

  it("acknowledges externally merged PR", async () => {
    const h = await createHarness({ ciRule: () => "pass" });
    await h.enqueue(prA);

    // Advance to merging.
    await h.tick(); // queued → preparing_head
    await h.tick(); // preparing_head → validating
    await h.tick(); // validating → merging

    // Mark as merged externally (e.g., someone merged via GitHub UI).
    await h.githubSim.mergePR(1);

    // Tick — revalidation should acknowledge the external merge.
    await h.tick();
    assert.strictEqual(h.entries[0]!.status, "merged");
    assert.deepStrictEqual(h.merged, [1]);

    h.assertInvariants();
  });
});
