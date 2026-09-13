import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHarness, type SimPR } from "../harness.ts";

describe("serial conflict handling", () => {
  it("retains a conflicting PR with a GitHub-visible repair workspace", async () => {
    const prA: SimPR = {
      number: 1,
      branch: "feat-a",
      files: [{ path: "readme.md", content: "version A" }],
    };
    const prB: SimPR = {
      number: 2,
      branch: "feat-b",
      files: [{ path: "readme.md", content: "version B" }],
    };

    // maxRetries: 0 — evict immediately on conflict.
    const h = await createHarness({ ciRule: () => "pass", maxRetries: 0 });
    await h.enqueue(prA);
    await h.enqueue(prB);
    await h.runUntilStable({ maxTicks: 30 });

    assert.ok(h.merged.includes(1), "PR #1 should merge");
    assert.strictEqual(h.entryStatus(prB), "validating");
    const entry = h.entries.find((e) => e.prNumber === 2)!;
    assert.equal(entry.candidateRef, "merge-steward/main/pr-2");
    assert.equal(await h.gitSim.isAncestor(entry.headSha, entry.candidateSha!), false);
    assert.equal(h.store.listIncidents(entry.id).length, 0);
    assert.equal(h.evictions.length, 0);

    h.assertInvariants();
  });
});
