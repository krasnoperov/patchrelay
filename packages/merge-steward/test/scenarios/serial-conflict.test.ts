import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHarness, type SimPR } from "../harness.ts";

describe("serial conflict handling", () => {
  it("evicts conflicting PR with incident record", async () => {
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

    // maxRetries: 0 — evict immediately on conflict.
    const h = await createHarness({ ciRule: () => "pass", maxRetries: 0 });
    await h.enqueue(prA);
    await h.enqueue(prB);
    await h.runUntilStable({ maxTicks: 30 });

    assert.ok(h.merged.includes(1), "PR #1 should merge");
    assert.strictEqual(h.entryStatus(prB), "evicted");

    // Eviction reported with incident.
    assert.ok(h.evictions.length > 0, "Should report eviction");
    assert.strictEqual(h.evictions[0]!.incident.failureClass, "integration_conflict");

    // Durable incident in store.
    const entry = h.entries.find((e) => e.prNumber === 2)!;
    const incidents = h.store.listIncidents(entry.id);
    assert.ok(incidents.length > 0);
    assert.strictEqual(incidents[0]!.outcome, "open");

    h.assertInvariants();
  });
});
