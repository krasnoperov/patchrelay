import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHarness, type SimPR } from "../harness.ts";

const prA: SimPR = { number: 1, branch: "feat-a", files: [{ path: "a.ts", content: "a" }] };

describe("revalidation before merge", () => {
  it("waits for re-approval when approval is withdrawn before merge", async () => {
    const h = await createHarness({ ciRule: () => "pass" });
    await h.enqueue(prA);

    // Advance to merging.
    await h.tick(); // queued → preparing_head
    await h.tick(); // preparing_head → validating
    await h.tick(); // validating → merging

    assert.strictEqual(h.entries[0]!.status, "merging");
    // Withdraw approval.
    h.githubSim.setReviewApproved(1, false);

    // Tick — should wait, not evict. Entry stays in merging.
    await h.tick();
    assert.strictEqual(h.entries[0]!.status, "merging",
      "Should stay in merging and wait for re-approval");
    assert.strictEqual(h.merged.length, 0, "Should not merge yet");
    assert.ok(
      h.reconcileEvents.some((e) => e.action === "merge_waiting_approval"),
      "Should emit merge_waiting_approval event",
    );

    // Re-approve — should merge on next tick.
    h.githubSim.setReviewApproved(1, true);
    await h.tick();
    assert.deepStrictEqual(h.merged, [1], "Should merge after re-approval");
    h.assertInvariants();
  });

  it("revokes admission when PR head SHA changes before merge", async () => {
    const h = await createHarness({ ciRule: () => "pass" });
    await h.enqueue(prA);

    // Advance to merging.
    await h.tick(); // queued → preparing_head
    await h.tick(); // preparing_head → validating
    await h.tick(); // validating → merging

    assert.strictEqual(h.entries[0]!.status, "merging");
    const admittedHeadSha = h.entries[0]!.headSha;

    // Simulate external force-push (GitHub shows different SHA).
    h.githubSim.updateSha(1, "externally-pushed-sha");

    // Tick — revalidation should detect SHA mismatch.
    await h.tick();
    assert.strictEqual(h.entries[0]!.status, "superseded",
      "The old immutable admission should leave the active train");
    assert.strictEqual(h.entries[0]!.headSha, admittedHeadSha,
      "The unreviewed new SHA must not inherit the old admission");
    assert.strictEqual(h.entries[0]!.generation, 0);

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
