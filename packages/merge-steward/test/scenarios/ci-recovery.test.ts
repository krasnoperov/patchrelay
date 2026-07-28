import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHarness, type SimPR } from "../harness.ts";

describe("CI recovery scenarios", () => {
  it("evicts a failed exact head without manufacturing a duplicate candidate", async () => {
    const h = await createHarness({
      ciRule: () => "fail",
      maxRetries: 2,
      flakyRetries: 0,
    });

    const prA: SimPR = { number: 1, branch: "feat-a", files: [{ path: "a.ts", content: "a" }] };
    await h.enqueue(prA);
    await h.runUntilStable({ maxTicks: 30 });

    assert.deepStrictEqual(h.merged, []);
    assert.strictEqual(h.entryStatus(prA), "evicted");
    assert.strictEqual(h.ciSim.runCount, 0, "failed head checks must not create synthetic CI");
    h.assertInvariants();
  });

  it("reruns flaky exact-head checks on the same SHA without a synthetic commit", async () => {
    let calls = 0;
    const h = await createHarness({
      ciRule: () => ++calls === 1 ? "fail" : "pass",
      flakyRetries: 1,
    });
    const prA: SimPR = {
      number: 11,
      branch: "feat-flaky-head",
      files: [{ path: "flaky.ts", content: "flaky" }],
    };
    const inserted = await h.enqueue(prA);

    await h.runUntilStable();

    assert.deepStrictEqual(h.merged, [11]);
    assert.equal(h.ciSim.runCount, 1, "only one real rerun is requested");
    assert.deepEqual(
      [...h.ciSim.allRuns.values()].map((run) => run.sha),
      [inserted.headSha],
    );
    assert.equal(h.entries[0]?.candidateKind, "head");
    assert.equal(h.entries[0]?.candidateRef, null);
    h.assertInvariants();
  });

  it("bounds unavailable reruns and lets an independent root proceed", async () => {
    const h = await createHarness({
      ciRule: (files) => files.includes("bad.ts") ? "fail" : "pass",
      flakyRetries: 2,
      speculativeDepth: 2,
    });
    await h.enqueue({
      number: 21,
      branch: "feat-bad-external-ci",
      files: [{ path: "bad.ts", content: "bad" }],
    });
    await h.enqueue({
      number: 22,
      branch: "feat-independent-good",
      files: [{ path: "good.ts", content: "good" }],
    });
    let rerunAttempts = 0;
    h.ciSim.rerunRun = async () => {
      rerunAttempts += 1;
      throw new Error("required check belongs to a non-Actions CI App");
    };

    await h.runUntilStable({ maxTicks: 40 });

    assert.ok(rerunAttempts <= 4, "each invalidated candidate must consume only its bounded flaky budget");
    assert.equal(
      h.reconcileEvents.filter((event) =>
        event.prNumber === 21 && event.action === "ci_flaky_retry").length,
      2,
      "the failed root consumes exactly its configured retry budget",
    );
    assert.ok(h.evicted.includes(21));
    assert.ok(h.merged.includes(22), "the unrelated root must recover after the failed root is evicted");
    assert.ok(h.reconcileEvents.some((event) =>
      event.prNumber === 21
      && event.action === "ci_failed"
      && event.detail?.includes("rerun unavailable")));
  });

  it("evicts a skipped required head check as a policy block when it cannot be rerun", async () => {
    const h = await createHarness({
      ciRule: () => "pass",
      flakyRetries: 1,
      requiredCheckRules: [{ name: "Tests", appId: 15368 }],
    });
    const inserted = await h.enqueue({
      number: 23,
      branch: "feat-skipped-required",
      files: [{ path: "conditional.ts", content: "conditional" }],
    });
    h.githubSim.setRefChecks(inserted.headSha, [{
      name: "Tests",
      appId: 15368,
      conclusion: "skipped",
      runId: 1,
    }]);
    h.ciSim.rerunRun = async () => {
      throw new Error("no failed GitHub Actions workflow exists");
    };

    await h.runUntilStable({ maxTicks: 20 });

    const entry = h.entries[0]!;
    assert.equal(entry.status, "evicted");
    assert.equal(h.store.listIncidents(entry.id)[0]?.failureClass, "policy_blocked");
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

  it("reruns a flaky integration candidate on the same SHA without rebuilding", async () => {
    let ciCalls = 0;
    const h = await createHarness({
      ciRule: () => {
        ciCalls++;
        // Enqueue-time head checks pass; first integration run fails; rerun passes.
        return ciCalls === 2 ? "fail" : "pass";
      },
      maxRetries: 1,
      flakyRetries: 2,
    });

    const prA: SimPR = { number: 1, branch: "feat-a", files: [{ path: "a.ts", content: "a" }] };
    await h.enqueue(prA);
    await h.advanceMain();
    await h.runUntilStable();

    assert.deepStrictEqual(h.merged, [1]);
    const entry = h.entries.find((e) => e.prNumber === 1)!;
    assert.strictEqual(entry.retryAttempts, 0, "Flaky retry should not count toward retryAttempts");
    assert.strictEqual(h.ciSim.runCount, 2);
    assert.strictEqual(
      new Set([...h.ciSim.allRuns.values()].map((run) => run.sha)).size,
      1,
      "flaky rerun must stay bound to the same candidate SHA",
    );
    h.assertInvariants();
  });
});
