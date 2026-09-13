import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHarness } from "../harness.ts";

describe("ordinary integration failures are not eviction incidents", () => {
  it("keeps a conflict in the queue and exposes repair through ancestry", async () => {
    const h = await createHarness({ ciRule: () => "pass", maxRetries: 0 });
    await h.enqueue({ number: 1, branch: "feat-a", files: [{ path: "shared.ts", content: "A" }] });
    await h.enqueue({ number: 2, branch: "feat-b", files: [{ path: "shared.ts", content: "B" }] });
    await h.runUntilStable({ maxTicks: 30 });

    const entry = h.entries.find((candidate) => candidate.prNumber === 2)!;
    assert.equal(entry.status, "validating");
    assert.equal(entry.candidateRef, "merge-steward/main/pr-2");
    assert.equal(await h.gitSim.isAncestor(entry.headSha, entry.candidateSha!), false);
    assert.equal(h.store.listIncidents(entry.id).length, 0);
    assert.equal(h.evictions.length, 0);
  });

  it("keeps a settled CI failure on a workspace", async () => {
    const h = await createHarness({ ciRule: () => "fail", maxRetries: 0, flakyRetries: 0 });
    await h.enqueue({ number: 7, branch: "feat-failing", files: [{ path: "bad.ts", content: "bad" }] });
    await h.runUntilStable({ maxTicks: 20 });

    const entry = h.entries[0]!;
    assert.equal(entry.status, "validating");
    assert.equal(entry.candidateRef, "merge-steward/main/pr-7");
    assert.match(entry.waitDetail ?? "", /awaits repair/);
    assert.equal(h.store.listIncidents(entry.id).length, 0);
    assert.equal(h.evictions.length, 0);
  });
});
