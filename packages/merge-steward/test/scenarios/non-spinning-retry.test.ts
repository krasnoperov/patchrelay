import { describe, it } from "node:test";
import assert from "node:assert/strict";
import git from "isomorphic-git";
import { createHarness, type SimPR } from "../harness.ts";

describe("non-spinning retry", () => {
  it("does not spin on conflict when base has not changed", async () => {
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

    const h = await createHarness({ ciRule: () => "pass", maxRetries: 2 });
    await h.enqueue(prA);
    await h.enqueue(prB);

    // Run until A merges and B hits first conflict.
    await h.runUntilStable({ maxTicks: 20 });
    assert.ok(h.merged.includes(1));

    // B should have conflicted at least once.
    const bEntry = h.entries.find((e) => e.prNumber === 2)!;
    assert.ok(bEntry.retryAttempts >= 1, "B should have conflicted at least once");

    // GitHubSim reports CLEAN by default, so the gate-clearing logic
    // will retry — but the real conflict persists. B should eventually
    // evict after exhausting retries.
    await h.runUntilStable({ maxTicks: 20 });
    const bFinal = h.entries.find((e) => e.prNumber === 2)!;
    assert.strictEqual(bFinal.status, "evicted", "B should evict after retries exhausted");

    h.assertInvariants();
  });

  it("retries after base advances and evicts on second conflict", async () => {
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

    // With GitHub reporting CLEAN, the gate clears and B retries until
    // budget exhausted. B truly conflicts (shared.ts), so all retries fail.
    const h = await createHarness({ ciRule: () => "pass", maxRetries: 2 });
    await h.enqueue(prA);
    await h.enqueue(prB);

    await h.runUntilStable({ maxTicks: 30 });
    assert.ok(h.merged.includes(1), "A should merge");

    const bFinal = h.entries.find((e) => e.prNumber === 2)!;
    assert.strictEqual(bFinal.status, "evicted",
      "B should evict after retries exhausted on real conflict");

    const incidents = h.store.listIncidents(bFinal.id);
    assert.ok(incidents.length > 0);

    h.assertInvariants();
  });

  it("evicts a retry-gated head when GitHub reports the PR is still dirty", async () => {
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

    const h = await createHarness({ ciRule: () => "pass", maxRetries: 2 });
    await h.enqueue(prA);
    await h.enqueue(prB);

    // Set DIRTY before B hits the retry gate — this prevents the
    // CLEAN gate-clearing path and triggers immediate eviction.
    h.githubSim.setMergeStateStatus(2, "DIRTY");

    await h.runUntilStable({ maxTicks: 20 });
    assert.ok(h.merged.includes(1));

    const bFinal = h.entries.find((e) => e.prNumber === 2)!;
    assert.strictEqual(bFinal.status, "evicted");
    assert.ok(h.evictionSim.evictions.length > 0);
    const eviction = h.evictionSim.evictions.find((ev) => ev.entry.prNumber === 2);
    assert.ok(eviction);
    assert.strictEqual(eviction!.incident.failureClass, "integration_conflict");

    h.assertInvariants();
  });
});
