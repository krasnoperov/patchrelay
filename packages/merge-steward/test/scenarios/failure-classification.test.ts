import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHarness } from "../harness.ts";
import { GitHubSim } from "../../src/sim/github-sim.ts";

describe("failure classification against main baseline", () => {
  it("sim listChecksForRef returns checks and strips origin/ prefix", async () => {
    const sim = new GitHubSim();
    sim.setRefChecks("main", [
      { name: "build", conclusion: "success" },
      { name: "lint", conclusion: "failure" },
      { name: "deploy", conclusion: "pending" },
    ]);

    const bare = await sim.listChecksForRef("main");
    assert.strictEqual(bare.length, 3);
    assert.strictEqual(bare[0]!.conclusion, "success");
    assert.strictEqual(bare[1]!.conclusion, "failure");
    assert.strictEqual(bare[2]!.conclusion, "pending");

    // origin/ prefix is stripped — matches production pr-client behavior.
    const prefixed = await sim.listChecksForRef("origin/main");
    assert.strictEqual(prefixed.length, 3);
  });

  it("classifies as main_broken when same check fails on branch and main", async () => {
    const h = await createHarness({ maxRetries: 0, flakyRetries: 0, ciRule: () => "fail" });

    await h.enqueue({ number: 1, branch: "feat-a", files: [{ path: "a.ts", content: "a" }] });

    await h.tick(); // queued → preparing_head
    await h.tick(); // rebase, push (clears sim checks), CI triggered → validating

    // Set check results AFTER push (updateSha clears checks, matching real GitHub).
    h.githubSim.setChecks(1, [
      { name: "build", conclusion: "failure" },
      { name: "lint", conclusion: "success" },
    ]);
    h.githubSim.setRefChecks("main", [
      { name: "build", conclusion: "failure" },
      { name: "lint", conclusion: "success" },
    ]);

    await h.tick(); // CI fails → evicted

    assert.strictEqual(h.evictionSim.evictions.length, 1);
    assert.strictEqual(h.evictionSim.evictions[0]!.incident.failureClass, "main_broken");
  });

  it("classifies as branch_local when main checks pass but branch fails", async () => {
    const h = await createHarness({ maxRetries: 0, flakyRetries: 0, ciRule: () => "fail" });

    await h.enqueue({ number: 1, branch: "feat-b", files: [{ path: "b.ts", content: "b" }] });

    await h.tick(); // queued → preparing_head
    await h.tick(); // preparing_head → validating

    h.githubSim.setChecks(1, [{ name: "build", conclusion: "failure" }]);
    h.githubSim.setRefChecks("main", [{ name: "build", conclusion: "success" }]);

    await h.tick(); // CI fails → evicted

    assert.strictEqual(h.evictionSim.evictions.length, 1);
    assert.strictEqual(h.evictionSim.evictions[0]!.incident.failureClass, "branch_local");
  });
});
