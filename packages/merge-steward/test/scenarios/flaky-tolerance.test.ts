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
        return ciCallCount <= 1 ? "fail" : "pass";
      },
      flakyRetries: 2,
    });
    await h.enqueue(prA);
    await h.runUntilStable();

    assert.deepStrictEqual(h.merged, [1], "PR should merge after flaky retry");
    assert.strictEqual(h.evictions.length, 0, "No eviction should occur");
    h.assertInvariants();
  });

  it("evicts after flaky retries and retry budget exhausted", async () => {
    const h = await createHarness({
      ciRule: () => "fail",
      flakyRetries: 1,
      maxRetries: 1,
    });
    await h.enqueue(prA);
    await h.runUntilStable({ maxTicks: 30 });

    assert.strictEqual(h.entryStatus(prA), "evicted");
    assert.ok(h.evictions.length > 0, "Should report eviction");
    h.assertInvariants();
  });
});
