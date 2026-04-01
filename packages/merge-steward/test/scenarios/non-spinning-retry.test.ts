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

    // B should be in preparing_head (waiting for base to change).
    const bEntry = h.entries.find((e) => e.prNumber === 2)!;
    assert.strictEqual(bEntry.status, "preparing_head");
    assert.strictEqual(bEntry.retryAttempts, 1);
    assert.ok(bEntry.lastFailedBaseSha !== null);

    // Tick several more times — should NOT advance (base hasn't changed).
    const retryBefore = bEntry.retryAttempts;
    await h.tick();
    await h.tick();
    await h.tick();
    const bAfter = h.entries.find((e) => e.prNumber === 2)!;
    assert.strictEqual(bAfter.retryAttempts, retryBefore,
      "Retry count should not increment when base is unchanged");
    assert.strictEqual(bAfter.status, "preparing_head");

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

    // maxRetries: 2 — allows first conflict + one retry, then evicts on second conflict.
    const h = await createHarness({ ciRule: () => "pass", maxRetries: 2 });
    await h.enqueue(prA);
    await h.enqueue(prB);

    // Run until A merges and B hits first conflict.
    await h.runUntilStable({ maxTicks: 20 });
    assert.ok(h.merged.includes(1));
    const bEntry = h.entries.find((e) => e.prNumber === 2)!;
    assert.strictEqual(bEntry.status, "preparing_head");
    assert.strictEqual(bEntry.retryAttempts, 1);

    // Advance main (simulates another PR merging or a direct push).
    await git.checkout({
      fs: h.gitSim.volume,
      dir: h.gitSim.repoDir,
      ref: "main",
      force: true,
    });
    await h.gitSim.commitFile("other.ts", "something", "advance main");

    // Now tick — base changed, so reconciler retries rebase.
    // B still conflicts (shared.ts), so retryAttempts hits 1 >= maxRetries → evict.
    await h.tick();
    // The retry increments to 2 > maxRetries(1), but since we had 1 attempt
    // and maxRetries is 1, the next conflict check will see retryAttempts(1) >= maxRetries(1) → evict.
    // Actually need one more tick for the rebase attempt.
    await h.runUntilStable({ maxTicks: 10 });

    const bFinal = h.entries.find((e) => e.prNumber === 2)!;
    assert.strictEqual(bFinal.status, "evicted");

    // Incident should be created.
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

    await h.runUntilStable({ maxTicks: 20 });
    assert.ok(h.merged.includes(1));

    const gatedEntry = h.entries.find((e) => e.prNumber === 2)!;
    assert.strictEqual(gatedEntry.status, "preparing_head");
    assert.strictEqual(gatedEntry.retryAttempts, 1);

    h.githubSim.setMergeStateStatus(2, "DIRTY");
    await h.tick();

    const bFinal = h.entries.find((e) => e.prNumber === 2)!;
    assert.strictEqual(bFinal.status, "evicted");
    assert.ok(h.evictionSim.evictions.length > 0);
    assert.strictEqual(h.evictionSim.evictions[0]!.incident.failureClass, "integration_conflict");

    h.assertInvariants();
  });
});
