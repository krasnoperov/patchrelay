import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHarness, type SimPR } from "../harness.ts";

describe("CI recovery scenarios", () => {
  it("PR fails CI, retries after main advances, passes on second attempt", async () => {
    // CI fails because of interaction with main. After main advances (another
    // PR merges), the re-rebase produces different content and CI passes.
    let ciCalls = 0;
    const h = await createHarness({
      ciRule: () => {
        ciCalls++;
        // First CI run fails, subsequent pass.
        return ciCalls <= 1 ? "fail" : "pass";
      },
      maxRetries: 2,
      flakyRetries: 0,
    });

    const prA: SimPR = { number: 1, branch: "feat-a", files: [{ path: "a.ts", content: "a" }] };
    await h.enqueue(prA);
    await h.runUntilStable({ maxTicks: 30 });

    assert.deepStrictEqual(h.merged, [1], "PR should merge after CI recovery on retry");
    assert.strictEqual(h.evictions.length, 0, "No evictions expected");
    h.assertInvariants();
  });

  it("multiple PRs: first passes, second fails then recovers via retry", async () => {
    let ciCallsForB = 0;
    const h = await createHarness({
      ciRule: (files) => {
        if (files.includes("b.ts")) {
          ciCallsForB++;
          return ciCallsForB <= 1 ? "fail" : "pass";
        }
        return "pass";
      },
      maxRetries: 2,
      flakyRetries: 0,
    });

    const prA: SimPR = { number: 1, branch: "feat-a", files: [{ path: "a.ts", content: "a" }] };
    const prB: SimPR = { number: 2, branch: "feat-b", files: [{ path: "b.ts", content: "b" }] };
    await h.enqueue(prA);
    await h.enqueue(prB);
    await h.runUntilStable({ maxTicks: 40 });

    assert.deepStrictEqual(h.merged, [1, 2], "Both should merge (B recovers on retry)");
    h.assertInvariants();
  });

  it("CI flaky retry succeeds without counting toward retry budget", async () => {
    let ciCalls = 0;
    const h = await createHarness({
      ciRule: () => {
        ciCalls++;
        return ciCalls === 1 ? "fail" : "pass";
      },
      maxRetries: 1,
      flakyRetries: 2,
    });

    const prA: SimPR = { number: 1, branch: "feat-a", files: [{ path: "a.ts", content: "a" }] };
    await h.enqueue(prA);
    await h.runUntilStable();

    assert.deepStrictEqual(h.merged, [1]);
    // Verify retry budget wasn't consumed (entry.retryAttempts should be 0).
    const entry = h.entries.find((e) => e.prNumber === 1)!;
    assert.strictEqual(entry.retryAttempts, 0, "Flaky retry should not count toward retryAttempts");
    h.assertInvariants();
  });
});
