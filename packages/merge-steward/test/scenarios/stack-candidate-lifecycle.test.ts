import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createHarness } from "../harness.ts";

describe("stack candidate lifecycle", () => {
  it("lands a three-PR linear stack from exact tested heads without synthetic CI", async () => {
    const h = await createHarness({ speculativeDepth: 3 });
    await h.enqueue({ number: 1, branch: "stack-parent", files: [{ path: "p.ts", content: "p" }] });
    await h.enqueue({
      number: 2,
      branch: "stack-child",
      baseRefName: "stack-parent",
      files: [{ path: "c.ts", content: "c" }],
    });
    await h.enqueue({
      number: 3,
      branch: "stack-grandchild",
      baseRefName: "stack-child",
      files: [{ path: "g.ts", content: "g" }],
    });

    await h.runUntilStable();

    assert.deepEqual(h.merged, [1, 2, 3]);
    assert.equal(h.ciSim.runCount, 0);
    for (const entry of h.entries) {
      assert.equal(entry.candidateKind, "head");
      assert.equal(entry.candidateSha, entry.headSha);
      assert.equal(entry.candidateRef, null);
    }
    h.assertInvariants();
  });

  it("applies priority only among dependency-ready PRs across interleaved stacks", async () => {
    const h = await createHarness({ speculativeDepth: 4 });
    await h.enqueue({ number: 10, branch: "stack-a-parent", files: [{ path: "ap.ts", content: "ap" }] });
    await h.enqueue({ number: 20, branch: "stack-b-parent", files: [{ path: "bp.ts", content: "bp" }] });
    await h.enqueue({
      number: 11,
      branch: "stack-a-child",
      baseRefName: "stack-a-parent",
      priority: 1,
      files: [{ path: "ac.ts", content: "ac" }],
    });
    await h.enqueue({
      number: 21,
      branch: "stack-b-child",
      baseRefName: "stack-b-parent",
      files: [{ path: "bc.ts", content: "bc" }],
    });

    await h.runUntilStable();

    assert.deepEqual(h.merged, [10, 11, 20, 21]);
    assert.equal(h.entries.find((entry) => entry.prNumber === 10)?.candidateKind, "head");
    assert.equal(h.entries.find((entry) => entry.prNumber === 11)?.candidateKind, "head");
    assert.equal(h.entries.find((entry) => entry.prNumber === 20)?.candidateKind, "integration");
    assert.equal(h.entries.find((entry) => entry.prNumber === 21)?.candidateKind, "integration");
    h.assertInvariants();
  });

  it("blocks only the failed stack, lets an independent PR land, then recovers after parent re-admission", async () => {
    let checkEvaluation = 0;
    const h = await createHarness({
      speculativeDepth: 4,
      ciRule: () => (++checkEvaluation === 1 ? "fail" : "pass"),
    });
    await h.enqueue({ number: 30, branch: "broken-parent", files: [{ path: "broken.ts", content: "broken" }] });
    await h.enqueue({
      number: 31,
      branch: "blocked-child",
      baseRefName: "broken-parent",
      priority: 1,
      files: [{ path: "child.ts", content: "child" }],
    });
    await h.enqueue({ number: 40, branch: "independent", files: [{ path: "independent.ts", content: "ok" }] });

    await h.runUntilStable({ maxTicks: 20 });

    assert.equal(h.entries.find((entry) => entry.prNumber === 30)?.status, "evicted");
    assert.ok(h.merged.includes(40), "independent work must not sit behind a failed stack");
    const blocked = h.entries.find((entry) => entry.prNumber === 31)!;
    assert.notEqual(blocked.status, "merged");
    assert.match(blocked.waitDetail ?? "", /stack parent broken-parent is evicted/);
    assert.equal(
      h.reconcileEvents.filter((event) =>
        event.prNumber === 31 && event.action === "stack_dependency_waiting").length,
      1,
      "unchanged dependency state should not emit on every tick",
    );
    const blockedHead = blocked.headSha;
    const mainAfterIndependent = await h.gitSim.headSha("main");
    assert.equal(
      await h.gitSim.isAncestor(blockedHead, mainAfterIndependent),
      false,
      "an independent root must rebuild without the now-blocked child",
    );

    // Model the repaired attempt as a fresh branch tip based on current main.
    await h.gitSim.deleteBranch("broken-parent");
    await h.enqueue({
      number: 30,
      branch: "broken-parent",
      files: [{ path: "repair.ts", content: "fixed" }],
    });
    await h.runUntilStable({ maxTicks: 30 });

    assert.deepEqual(h.merged, [40, 30, 31]);
    assert.equal(h.entries.filter((entry) => entry.prNumber === 30 && entry.status === "merged").length, 1);
    h.assertInvariants();
  });

  it("invalidates a prepared child when GitHub retargets its base", async () => {
    const h = await createHarness({ speculativeDepth: 2 });
    await h.enqueue({ number: 50, branch: "retarget-parent", files: [{ path: "p.ts", content: "p" }] });
    await h.enqueue({
      number: 51,
      branch: "retarget-child",
      baseRefName: "retarget-parent",
      files: [{ path: "c.ts", content: "c" }],
    });

    await h.tick();
    await h.tick();
    const before = h.entries.find((entry) => entry.prNumber === 51)!;
    assert.equal(before.candidateKind, "head");

    h.githubSim.setBaseRef(51, "main");
    await h.tick();

    const reset = h.entries.find((entry) => entry.prNumber === 51)!;
    assert.equal(reset.baseRefName, "main");
    assert.equal(reset.candidateKind, null);
    assert.equal(reset.candidateSha, null);
    await h.runUntilStable();
    assert.deepEqual(h.merged, [50, 51]);
    h.assertInvariants();
  });

  it("quarantines a malformed dependency cycle without blocking an independent root", async () => {
    const h = await createHarness({ speculativeDepth: 3 });
    const a = await h.enqueue({ number: 60, branch: "cycle-a", files: [{ path: "a.ts", content: "a" }] });
    const b = await h.enqueue({
      number: 61,
      branch: "cycle-b",
      baseRefName: "cycle-a",
      files: [{ path: "b.ts", content: "b" }],
    });
    await h.enqueue({ number: 62, branch: "cycle-independent", files: [{ path: "i.ts", content: "i" }] });
    h.store.updateBaseRef(a.id, "cycle-b");
    h.githubSim.setBaseRef(60, "cycle-b");
    h.store.updateBaseRef(b.id, "cycle-a");

    await h.runUntilStable({ maxTicks: 15 });

    assert.deepEqual(h.merged, [62]);
    assert.match(h.entries.find((entry) => entry.prNumber === 60)?.waitDetail ?? "", /itself blocked/);
    assert.match(h.entries.find((entry) => entry.prNumber === 61)?.waitDetail ?? "", /itself blocked/);
    assert.equal(h.ciSim.runCount, 0);
  });
});
