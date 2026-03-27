import { describe, it } from "node:test";
import assert from "node:assert/strict";
import git from "isomorphic-git";
import { createHarness, type SimPR } from "../harness.ts";

describe("branch ownership enforcement", () => {
  it("external push during queued state resets entry via updateHead", async () => {
    const h = await createHarness({ ciRule: () => "pass" });
    const prA: SimPR = { number: 1, branch: "feat-a", files: [{ path: "a.ts", content: "a" }] };
    await h.enqueue(prA);

    // Advance to validating.
    await h.tick(); // queued → preparing_head
    await h.tick(); // preparing_head → validating

    assert.strictEqual(h.entries[0]!.status, "validating");

    // External push changes the branch SHA.
    h.store.updateHead(h.entries[0]!.id, "externally-pushed-sha");

    const after = h.entries[0]!;
    assert.strictEqual(after.status, "queued");
    assert.strictEqual(after.headSha, "externally-pushed-sha");
    assert.strictEqual(after.generation, 1);

    h.assertInvariants();
  });

  it("reconciler detects SHA mismatch before rebase and resets", async () => {
    const h = await createHarness({ ciRule: () => "pass" });
    const prA: SimPR = { number: 1, branch: "feat-a", files: [{ path: "a.ts", content: "a" }] };
    await h.enqueue(prA);

    await h.tick(); // queued → preparing_head

    // Externally modify the branch in git (simulating a push that
    // arrived between webhook processing and reconciler tick).
    await git.checkout({
      fs: h.gitSim.volume,
      dir: h.gitSim.repoDir,
      ref: "feat-a",
      force: true,
    });
    await h.gitSim.commitFile("a.ts", "modified externally", "external push");
    await git.checkout({
      fs: h.gitSim.volume,
      dir: h.gitSim.repoDir,
      ref: "main",
      force: true,
    });

    // Now the entry's headSha doesn't match the actual branch ref.
    // Next tick should detect and reset.
    await h.tick();

    const after = h.entries[0]!;
    assert.strictEqual(after.status, "queued",
      "Should reset to queued on SHA mismatch");
    assert.strictEqual(after.generation, 1);

    // After reset, it can still merge successfully.
    await h.runUntilStable();
    assert.deepStrictEqual(h.merged, [1]);
    h.assertInvariants();
  });
});
