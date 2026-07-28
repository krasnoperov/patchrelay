import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHarness, type SimPR } from "../harness.ts";

describe("non-spinning retry", () => {
  it("does not rebuild a conflicting downstream child while its prospective base is unchanged", async () => {
    const h = await createHarness({
      ciRule: () => "pending",
      speculativeDepth: 2,
      maxRetries: 2,
    });
    await h.enqueue({
      number: 1,
      branch: "feat-parent",
      files: [{ path: "shared.ts", content: "parent" }],
    });
    await h.enqueue({
      number: 2,
      branch: "feat-child",
      files: [{ path: "shared.ts", content: "child" }],
    });

    await h.tick(); // promote both
    await h.tick(); // parent candidate; child observes its first conflict
    for (let i = 0; i < 5; i++) await h.tick();

    const child = h.entries.find((entry) => entry.prNumber === 2)!;
    assert.equal(child.status, "preparing_head");
    assert.equal(
      h.reconcileEvents.filter((event) =>
        event.prNumber === 2 && event.action === "integration_build_conflict").length,
      1,
      "the same downstream base/head pair must be merged only once",
    );
    assert.ok(
      h.reconcileEvents.some((event) =>
        event.prNumber === 2 && event.action === "retry_gated"),
      "later ticks should consult the deterministic conflict cache",
    );
  });

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

    const bFinal = h.entries.find((e) => e.prNumber === 2)!;
    assert.strictEqual(bFinal.status, "evicted");
    assert.equal(bFinal.retryAttempts, 0, "deterministic conflicts do not spend a retry budget");
    assert.equal(
      h.reconcileEvents.filter((event) =>
        event.prNumber === 2 && event.action === "integration_build_conflict").length,
      1,
      "the same base/head conflict must be built only once",
    );

    h.assertInvariants();
  });

  it("evicts a deterministic conflict regardless of the push retry budget", async () => {
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

    const h = await createHarness({ ciRule: () => "pass", maxRetries: 100 });
    await h.enqueue(prA);
    await h.enqueue(prB);

    await h.runUntilStable({ maxTicks: 30 });
    assert.ok(h.merged.includes(1), "A should merge");

    const bFinal = h.entries.find((e) => e.prNumber === 2)!;
    assert.strictEqual(bFinal.status, "evicted");

    const incidents = h.store.listIncidents(bFinal.id);
    assert.ok(incidents.length > 0);

    h.assertInvariants();
  });

  it("does not let GitHub's mergeability guess override a proven local conflict", async () => {
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

    // CLEAN is only a GitHub approximation; the exact local merge inputs
    // still prove the integration candidate cannot be created.
    h.githubSim.setMergeStateStatus(2, "CLEAN");

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
