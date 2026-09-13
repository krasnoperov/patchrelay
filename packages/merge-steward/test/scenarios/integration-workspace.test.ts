import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createHarness } from "../harness.ts";

describe("GitHub-derived integration workspaces", () => {
  it("publishes a self-describing workspace at the prospective base and retains queue order on conflict", async () => {
    const h = await createHarness({ speculativeDepth: 3 });
    const a = { number: 101, branch: "feature/a", files: [{ path: "shared.ts", content: "a" }] };
    const b = { number: 102, branch: "feature/b", files: [{ path: "shared.ts", content: "b" }] };
    const c = { number: 103, branch: "feature/c", files: [{ path: "c.ts", content: "c" }] };
    await h.enqueue(a);
    await h.enqueue(b);
    await h.enqueue(c);

    for (let i = 0; i < 12; i++) await h.tick();

    const blocked = h.entries.find((entry) => entry.prNumber === b.number)!;
    assert.equal(blocked.status, "validating");
    assert.equal(blocked.candidateRef, "merge-steward/main/pr-102");
    assert.equal(await h.gitSim.headSha(blocked.candidateRef), blocked.candidateSha);
    assert.equal(await h.gitSim.isAncestor(blocked.headSha, blocked.candidateSha!), false);
    assert.equal(h.entries.find((entry) => entry.prNumber === c.number)!.candidateSha, null);
    assert.deepEqual(h.evicted, []);
  });

  it("detects a non-force conflict repair, gates it on integration review, and resumes the train", async () => {
    const h = await createHarness({ speculativeDepth: 2 });
    const a = { number: 201, branch: "feature/a", files: [{ path: "shared.ts", content: "a" }] };
    const b = { number: 202, branch: "feature/b", files: [{ path: "shared.ts", content: "b" }] };
    await h.enqueue(a);
    await h.enqueue(b);
    for (let i = 0; i < 10; i++) await h.tick();

    const blocked = h.entries.find((entry) => entry.prNumber === b.number)!;
    const repairedSha = await h.gitSim.repairWorkspace(blocked.candidateRef!, b.branch, [
      { path: "shared.ts", content: "a + b" },
    ]);
    await h.gitSim.push(blocked.candidateRef!, false);

    await h.tick(); // detect repaired ref
    for (let i = 0; i < 3; i++) await h.tick(); // CI passes, but integration review is absent
    let repaired = h.entries.find((entry) => entry.prNumber === b.number)!;
    assert.equal(repaired.candidateSha, repairedSha);
    assert.equal(repaired.status, "validating");
    assert.match(repaired.waitDetail ?? "", /review-quill\/integration/);

    h.githubSim.setRefChecks(repairedSha, [
      { name: "ci", conclusion: "success" },
      { name: "review-quill/integration", conclusion: "success" },
    ]);
    await h.tick();
    await h.tick();
    repaired = h.entries.find((entry) => entry.prNumber === b.number)!;
    assert.equal(repaired.status, "merged");
    assert.deepEqual(h.evicted, []);
  });

  it("reuses already-green exact-SHA checks after an external repair push", async () => {
    const h = await createHarness({ speculativeDepth: 2 });
    await h.enqueue({ number: 301, branch: "feature/a", files: [{ path: "shared.ts", content: "a" }] });
    await h.enqueue({ number: 302, branch: "feature/b", files: [{ path: "shared.ts", content: "b" }] });
    for (let i = 0; i < 10; i++) await h.tick();

    const blocked = h.entries.find((entry) => entry.prNumber === 302)!;
    const repairedSha = await h.gitSim.repairWorkspace(blocked.candidateRef!, blocked.branch, [
      { path: "shared.ts", content: "a + b" },
    ]);
    await h.gitSim.push(blocked.candidateRef!, false);
    h.githubSim.setRefChecks(repairedSha, [
      { name: "ci", conclusion: "success" },
      { name: "review-quill/integration", conclusion: "success" },
    ]);
    const runsBefore = h.ciSim.runCount;

    for (let i = 0; i < 3; i++) await h.tick();

    assert.equal(h.entries.find((entry) => entry.prNumber === 302)?.status, "merged");
    assert.equal(h.ciSim.runCount, runsBefore, "green checks on the exact repaired SHA must not rerun");
  });

  it("preserves repair provenance and resumes after a same-SHA rerun", async () => {
    const h = await createHarness({ speculativeDepth: 2 });
    await h.enqueue({ number: 401, branch: "feature/a", files: [{ path: "shared.ts", content: "a" }] });
    await h.enqueue({ number: 402, branch: "feature/b", files: [{ path: "shared.ts", content: "b" }] });
    for (let i = 0; i < 10; i++) await h.tick();

    const blocked = h.entries.find((entry) => entry.prNumber === 402)!;
    const repairedSha = await h.gitSim.repairWorkspace(blocked.candidateRef!, blocked.branch, [
      { path: "shared.ts", content: "a + b" },
    ]);
    await h.gitSim.push(blocked.candidateRef!, false);
    h.githubSim.setRefChecks(repairedSha, [
      { name: "ci", conclusion: "failure" },
      { name: "review-quill/integration", conclusion: "success" },
    ]);

    await h.tick(); // detect repaired ref
    await h.tick(); // retain its failed exact SHA
    let repaired = h.entries.find((entry) => entry.prNumber === 402)!;
    assert.equal(repaired.candidateKind, "integration_repair");
    assert.ok(repaired.lastFailedBaseSha);

    h.githubSim.setRefChecks(repairedSha, [
      { name: "ci", conclusion: "success" },
      { name: "review-quill/integration", conclusion: "success" },
    ]);
    await h.tick();
    await h.tick();

    repaired = h.entries.find((entry) => entry.prNumber === 402)!;
    assert.equal(repaired.status, "merged");
    assert.deepEqual(h.evicted, []);
  });
});
