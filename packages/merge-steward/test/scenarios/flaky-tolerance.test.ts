import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHarness, type SimPR } from "../harness.ts";

const prA: SimPR = { number: 1, branch: "feat-a", files: [{ path: "a.ts", content: "a" }] };

describe("flaky test tolerance", () => {
  it("retries CI without agent repair when within flaky retry budget", async () => {
    let ciCallCount = 0;
    const h = await createHarness({
      ciRule: () => {
        ciCallCount++;
        // First call fails, subsequent calls pass.
        return ciCallCount <= 1 ? "fail" : "pass";
      },
      flakyRetries: 2,
    });
    await h.enqueue(prA);
    await h.runUntilStable();

    assert.deepStrictEqual(h.merged, [1], "PR should merge after flaky retry");
    assert.strictEqual(h.repairRequests.length, 0, "No agent repair should be requested");
    h.assertInvariants();
  });

  it("escalates to repair after flaky retries exhausted", async () => {
    const h = await createHarness({
      // Always fails.
      ciRule: () => "fail",
      flakyRetries: 2,
      repairBudget: 1,
    });
    await h.enqueue(prA);
    await h.runUntilStable({ maxTicks: 30 });

    // Should have tried flaky retries first, then escalated.
    assert.ok(
      h.repairRequests.length > 0 || h.entryStatus(prA) === "evicted",
      "Should escalate to repair or evict",
    );
    h.assertInvariants();
  });
});
