import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { QueueEntryStatus } from "../../src/types.ts";
import { createHarness } from "../harness.ts";

const ACTIVE_PHASES: QueueEntryStatus[] = [
  "queued",
  "preparing_head",
  "validating",
  "merging",
  "merged",
];

describe("restart recovery across persisted phases", () => {
  for (const phase of ACTIVE_PHASES) {
    it(`converges exactly once after restart from ${phase}`, async () => {
      const h = await createHarness();
      await h.enqueue({
        number: 700,
        branch: "feature/restart",
        files: [{ path: "restart.ts", content: phase }],
      });

      for (let i = 0; i < 10 && h.entries[0]?.status !== phase; i++) {
        await h.tick();
      }
      assert.equal(h.entries[0]?.status, phase);

      h.restart();
      await h.runUntilStable();

      assert.deepEqual(h.merged, [700]);
      assert.equal(
        h.reconcileEvents.filter((event) =>
          event.prNumber === 700
          && (event.action === "merge_succeeded" || event.action === "merge_external")).length,
        1,
      );
      h.assertInvariants();
    });
  }

  it("recovers a remote push that succeeded before the terminal row was persisted", async () => {
    const h = await createHarness();
    await h.enqueue({
      number: 701,
      branch: "feature/pushed-before-crash",
      files: [{ path: "pushed.ts", content: "landed" }],
    });
    for (let i = 0; i < 10 && h.entries[0]?.status !== "merging"; i++) {
      await h.tick();
    }
    const entry = h.entries[0]!;
    assert.equal(entry.status, "merging");
    assert.equal(entry.candidateKind, "head");

    let pushesToMain = 0;
    const originalPush = h.gitSim.push.bind(h.gitSim);
    h.gitSim.push = async (source, force, target) => {
      if (target === "main") pushesToMain += 1;
      await originalPush(source, force, target);
    };
    await h.gitSim.push(entry.candidateSha!, false, "main");

    h.restart();
    await h.runUntilStable();

    assert.equal(pushesToMain, 1, "recovery must recognize remote truth instead of pushing twice");
    assert.deepEqual(h.merged, [701]);
    assert.equal(h.entries[0]?.status, "merged");
  });

  it("does not test main again while GitHub is still recognizing an external merge", async () => {
    const h = await createHarness();
    await h.enqueue({
      number: 704,
      branch: "feature/merge-recognition-lag",
      files: [{ path: "lag.ts", content: "landed" }],
    });

    // Advance main independently so the external merge creates a commit that
    // contains the PR head rather than simply pointing main at that head.
    await h.gitSim.commitFile("main-only.ts", "main", "advance main");
    const merged = await h.gitSim.merge("feature/merge-recognition-lag", "main");
    assert.equal(merged.success, true);

    await h.tick(); // queued -> preparing_head
    await h.tick(); // observe that main already contains the PR head

    const waiting = h.entries[0]!;
    assert.equal(waiting.status, "preparing_head");
    assert.equal(waiting.candidateKind, null);
    assert.equal(waiting.candidateSha, null);
    assert.equal(h.ciSim.runCount, 0, "current main must not be re-tested as an integration candidate");
    assert.match(waiting.waitDetail ?? "", /already contained in main/);
    assert.equal(
      h.reconcileEvents.filter((event) => event.action === "merge_waiting_recognition").length,
      1,
    );

    await h.tick();
    assert.equal(
      h.reconcileEvents.filter((event) => event.action === "merge_waiting_recognition").length,
      1,
      "unchanged recognition lag must not emit or transition repeatedly",
    );

    h.githubSim.markMergedByBranch("feature/merge-recognition-lag");
    await h.tick();
    assert.equal(h.entries[0]?.status, "merged");
    assert.deepEqual(h.merged, [704]);
  });

  it("keeps an integration candidate and its CI run across restart", async () => {
    const h = await createHarness({ speculativeDepth: 2 });
    await h.enqueue({
      number: 702,
      branch: "feature/first",
      files: [{ path: "first.ts", content: "first" }],
    });
    await h.enqueue({
      number: 703,
      branch: "feature/second",
      files: [{ path: "second.ts", content: "second" }],
    });
    await h.tick();
    await h.tick();

    const before = h.entries.find((entry) => entry.prNumber === 703)!;
    assert.equal(before.status, "validating");
    assert.equal(before.candidateKind, "integration");
    assert.ok(before.candidateSha);
    assert.ok(before.ciRunId);
    const runCount = h.ciSim.runCount;

    h.restart();
    await h.runUntilStable();

    assert.deepEqual(h.merged, [702, 703]);
    assert.equal(h.ciSim.runCount, runCount, "restart must not duplicate candidate CI");
  });
});
