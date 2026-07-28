import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createHarness, type SimPR } from "../harness.ts";

const pr: SimPR = {
  number: 630,
  branch: "feature/already-green",
  files: [{ path: "src/already-green.ts", content: "export const ready = true;\n" }],
};

describe("exact candidate selection", () => {
  it("lands an approved green queue head without building or testing a duplicate spec", async () => {
    const h = await createHarness();
    const entry = await h.enqueue(pr);
    h.githubSim.setRefChecks(entry.headSha, [{ name: "checks", conclusion: "success" }]);
    const pushes: Array<{ source: string | undefined; target: string | undefined }> = [];
    const push = h.gitSim.push.bind(h.gitSim);
    h.gitSim.push = async (source, force, target) => {
      pushes.push({ source, target });
      await push(source, force, target);
    };

    await h.runUntilStable();

    assert.deepEqual(h.merged, [630]);
    assert.equal(h.ciSim.runCount, 0);
    assert.equal(h.entries[0]?.candidateRef, null);
    assert.ok(
      pushes.some(({ source, target }) => source === entry.headSha && target === "main"),
      "the landing refspec must use the immutable validated SHA, not the PR branch",
    );
    assert.ok(h.reconcileEvents.some((event) => event.action === "head_candidate_landed"));
  });

  it("waits on the exact head instead of manufacturing an identical-tree candidate", async () => {
    const h = await createHarness();
    await h.enqueue(pr);

    await h.tick();
    await h.tick();

    const entry = h.entries[0]!;
    assert.equal(entry.status, "validating");
    assert.equal(entry.candidateKind, "head");
    assert.equal(entry.candidateRef, null);
    assert.equal(entry.candidateSha, entry.headSha);
    assert.equal(h.ciSim.runCount, 0);
    assert.ok(!h.reconcileEvents.some((event) => event.action === "head_candidate_landed"));
  });

  it("revalidates checks immediately before push and waits on the same SHA when they changed", async () => {
    const h = await createHarness();
    const entry = await h.enqueue(pr);
    h.githubSim.setRefChecks(entry.headSha, [{ name: "checks", conclusion: "success" }]);

    await h.tick();
    await h.tick();
    await h.tick();
    assert.equal(h.entries[0]?.status, "merging");

    h.githubSim.setRefChecks(entry.headSha, [{ name: "checks", conclusion: "failure" }]);
    await h.tick();

    assert.equal(h.entries[0]?.status, "validating");
    assert.equal(h.entries[0]?.candidateSha, entry.headSha);
    assert.ok(!h.reconcileEvents.some((event) => event.action === "head_candidate_landed"));
  });

  it("does not accept a same-named required check from the wrong GitHub App", async () => {
    const h = await createHarness({
      requiredCheckRules: [{ name: "checks", appId: 42 }],
    });
    const entry = await h.enqueue(pr);
    h.githubSim.setRefChecks(entry.headSha, [
      { name: "checks", appId: 7, conclusion: "success" },
    ]);

    await h.tick();
    await h.tick();

    assert.equal(h.entries[0]?.candidateKind, "head");
    assert.equal(h.entries[0]?.candidateRef, null);
    assert.ok(!h.reconcileEvents.some((event) => event.action === "head_candidate_landed"));
  });

  it("preserves a compatible prepared downstream candidate", async () => {
    const h = await createHarness({ speculativeDepth: 2 });
    const head = await h.enqueue(pr);
    h.githubSim.setRefChecks(head.headSha, [{ name: "checks", conclusion: "success" }]);
    await h.enqueue({
      number: 631,
      branch: "feature/downstream",
      files: [{ path: "src/downstream.ts", content: "export const downstream = true;\n" }],
    });

    await h.tick();
    await h.tick();
    const downstream = h.entries.find((entry) => entry.prNumber === 631)!;
    assert.ok(downstream.candidateRef, "setup must have a prepared downstream spec");

    await h.runUntilStable();

    assert.deepEqual(h.merged, [630, 631]);
    assert.equal(h.ciSim.runCount, 1, "only the downstream integration candidate needs new CI");
    assert.ok(h.reconcileEvents.some((event) => event.action === "head_candidate_landed"));
  });

  it("fails closed when the policy refresh is unavailable and recovers on the same head", async () => {
    const h = await createHarness();
    await h.enqueue(pr);
    await h.tick();
    await h.tick();
    await h.tick();
    assert.equal(h.entries[0]?.status, "merging");

    const originalRefresh = h.policy.refreshBeforeLanding.bind(h.policy);
    h.policy.refreshBeforeLanding = async () => {
      throw new Error("rulesets unavailable");
    };
    await h.tick();

    assert.equal(h.entries[0]?.status, "preparing_head");
    assert.deepEqual(h.merged, []);

    h.policy.refreshBeforeLanding = originalRefresh;
    await h.runUntilStable();
    assert.deepEqual(h.merged, [630]);
  });

  it("does not land when GitHub status is unavailable and retries from remote truth", async () => {
    const h = await createHarness();
    await h.enqueue(pr);
    await h.tick();
    await h.tick();
    await h.tick();
    assert.equal(h.entries[0]?.status, "merging");

    const originalStatus = h.githubSim.getStatus.bind(h.githubSim);
    let unavailable = true;
    h.githubSim.getStatus = async (prNumber) => {
      if (unavailable) throw new Error("GitHub API unavailable");
      return await originalStatus(prNumber);
    };
    await assert.rejects(h.tick(), /GitHub API unavailable/);
    assert.equal(h.entries[0]?.status, "merging");
    assert.deepEqual(h.merged, []);

    unavailable = false;
    await h.runUntilStable();
    assert.deepEqual(h.merged, [630]);
  });

  it("rebuilds after a non-fast-forward push race without changing the tested head", async () => {
    const h = await createHarness();
    const inserted = await h.enqueue(pr);
    const originalPush = h.gitSim.push.bind(h.gitSim);
    let rejected = false;
    h.gitSim.push = async (source, force, target) => {
      if (target === "main" && !rejected) {
        rejected = true;
        throw new Error("remote rejected: non-fast-forward");
      }
      await originalPush(source, force, target);
    };

    for (let i = 0; i < 10 && !rejected; i++) await h.tick();

    assert.equal(rejected, true);
    assert.equal(h.entries[0]?.status, "preparing_head");
    assert.equal(h.entries[0]?.headSha, inserted.headSha);
    assert.deepEqual(h.merged, []);

    await h.runUntilStable();
    assert.deepEqual(h.merged, [630]);
  });
});
