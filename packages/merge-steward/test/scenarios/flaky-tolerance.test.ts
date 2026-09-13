import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHarness, type SimPR } from "../harness.ts";

const prA: SimPR = { number: 1, branch: "feat-a", files: [{ path: "a.ts", content: "a" }] };

describe("flaky test tolerance", () => {
  it("retries CI without eviction when within flaky retry budget", async () => {
    let ciCallCount = 0;
    const h = await createHarness({
      ciRule: () => {
        ciCallCount++;
        return ciCallCount === 2 ? "fail" : "pass";
      },
      flakyRetries: 2,
    });
    await h.enqueue(prA);
    await h.advanceMain();
    await h.runUntilStable();

    assert.deepStrictEqual(h.merged, [1], "PR should merge after flaky retry");
    assert.strictEqual(h.evictions.length, 0, "No eviction should occur");
    h.assertInvariants();
  });

  it("retains an integration workspace after flaky retries are exhausted", async () => {
    const h = await createHarness({
      ciRule: () => "fail",
      flakyRetries: 1,
      maxRetries: 1,
    });
    await h.enqueue(prA);
    await h.advanceMain();
    await h.runUntilStable({ maxTicks: 30 });

    assert.strictEqual(h.entryStatus(prA), "validating");
    assert.ok(h.entries[0]?.candidateRef, "Should publish a repair workspace");
    assert.strictEqual(h.evictions.length, 0);
    h.assertInvariants();
  });

  it("resumes a retained integration candidate when the same SHA rerun becomes green", async () => {
    let ciCallCount = 0;
    const h = await createHarness({
      ciRule: () => (++ciCallCount === 2 ? "fail" : "pass"),
      flakyRetries: 0,
    });
    await h.enqueue(prA);
    await h.advanceMain();
    await h.runUntilStable({ maxTicks: 20 });

    const retained = h.entries[0]!;
    assert.equal(retained.status, "validating");
    assert.equal(retained.candidateKind, "integration");
    assert.ok(retained.lastFailedBaseSha);

    h.githubSim.setRefChecks(retained.candidateSha!, [
      { name: "ci", conclusion: "success" },
    ]);
    await h.tick();
    await h.tick();

    assert.equal(h.entries[0]?.status, "merged");
    assert.deepEqual(h.evicted, []);
  });
});
