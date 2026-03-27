import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHarness, type SimPR } from "../harness.ts";

describe("PR update (force-push) handling", () => {
  it("updateHead resets all SHA-bound state and increments generation", async () => {
    const h = await createHarness({ ciRule: () => "pass" });
    const prA: SimPR = { number: 1, branch: "feat-a", files: [{ path: "a.ts", content: "a" }] };
    await h.enqueue(prA);

    // Advance to validating.
    await h.tick(); // queued → preparing_head
    await h.tick(); // preparing_head → validating

    const before = h.entries.find((e) => e.prNumber === 1)!;
    assert.strictEqual(before.status, "validating");
    assert.ok(before.ciRunId !== null, "Should have a CI run");
    assert.strictEqual(before.generation, 0);

    // Simulate force-push: update head SHA.
    h.store.updateHead(before.id, "new-sha-after-force-push");

    const after = h.entries.find((e) => e.prNumber === 1)!;
    assert.strictEqual(after.status, "queued", "Should reset to queued");
    assert.strictEqual(after.generation, 1, "Generation should increment");
    assert.strictEqual(after.headSha, "new-sha-after-force-push");
    assert.strictEqual(after.ciRunId, null, "ciRunId should be cleared");
    assert.strictEqual(after.ciRetries, 0, "ciRetries should be reset");
    assert.strictEqual(after.repairAttempts, 0, "repairAttempts should be reset");

    // Events should show the reset.
    const events = h.store.listEvents(before.id);
    const lastEvent = events[events.length - 1]!;
    assert.strictEqual(lastEvent.toStatus, "queued");
    assert.ok(lastEvent.detail?.includes("generation 1"));

    h.assertInvariants();
  });

  it("updateHead abandons pending repair requests", async () => {
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

    const h = await createHarness({
      ciRule: () => "pass",
      repairBudget: 3,
      autoCompleteRepairs: false,
    });
    await h.enqueue(prA);
    await h.enqueue(prB);

    // Run until B hits repair_in_progress.
    for (let i = 0; i < 20; i++) await h.tick();
    assert.ok(h.merged.includes(1));
    const bEntry = h.entries.find((e) => e.prNumber === 2)!;
    assert.strictEqual(bEntry.status, "repair_in_progress");

    // Force-push on B.
    h.store.updateHead(bEntry.id, "new-b-sha");

    const updated = h.entries.find((e) => e.prNumber === 2)!;
    assert.strictEqual(updated.status, "queued");
    assert.strictEqual(updated.repairAttempts, 0, "Repair budget should reset per-generation");

    // Check repair request was abandoned.
    const repairs = h.store.listRepairRequests(bEntry.id);
    assert.ok(repairs.length > 0);
    assert.ok(repairs.every((r) => r.outcome !== "pending"), "All repair requests should be abandoned");

    h.assertInvariants();
  });

  it("updateHead is a no-op on terminal entries", async () => {
    const h = await createHarness({ ciRule: () => "pass" });
    const prA: SimPR = { number: 1, branch: "feat-a", files: [{ path: "a.ts", content: "a" }] };
    await h.enqueue(prA);
    await h.runUntilStable();

    assert.strictEqual(h.entries[0]!.status, "merged");
    const sha = h.entries[0]!.headSha;

    h.store.updateHead(h.entries[0]!.id, "should-not-apply");

    assert.strictEqual(h.entries[0]!.status, "merged", "Terminal entry should not change");
    assert.strictEqual(h.entries[0]!.headSha, sha, "SHA should not change on terminal");
  });
});
