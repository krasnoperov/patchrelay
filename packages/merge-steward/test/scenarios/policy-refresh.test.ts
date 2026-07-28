import { describe, it } from "node:test";
import assert from "node:assert/strict";
import pino from "pino";
import { GitHubPolicyCache } from "../../src/github-policy.ts";
import { reconcile } from "../../src/reconciler.ts";
import type { ReconcileContext } from "../../src/reconciler.ts";
import type { ReconcileEvent } from "../../src/types.ts";
import { createHarness, type SimPR } from "../harness.ts";

const prA: SimPR = { number: 1, branch: "feat-a", files: [{ path: "a.ts", content: "a" }] };

describe("GitHub policy refresh safety", () => {
  it("refreshes policy before push and waits on the same candidate without spending retry budget", async () => {
    const h = await createHarness({ ciRule: () => "pass" });
    let refreshedChecks = ["Deploy"];
    const policy = new GitHubPolicyCache({
      repoFullName: "test/repo",
      initialRequiredChecks: [],
      logger: pino({ level: "silent" }),
      refreshPolicy: async () => ({
        defaultBranch: "main",
        branch: "main",
        requiredChecks: refreshedChecks,
        requireAllChecksOnEmptyRequiredSet: false,
        warnings: [],
      }),
    });

    const originalPush = h.gitSim.push.bind(h.gitSim);
    h.gitSim.push = async (branch: string, force?: boolean, targetBranch?: string) => {
      if (targetBranch === "main") {
        throw new Error("protected branch rejected push");
      }
      return await originalPush(branch, force, targetBranch);
    };

    const events: ReconcileEvent[] = [];
    const buildContext = (): ReconcileContext => ({
      store: h.store,
      repoId: "test-repo",
      baseBranch: "main",
      remotePrefix: "",
      git: h.gitSim,
      ci: h.ciSim,
      github: h.githubSim,
      eviction: h.evictionSim,
      specBuilder: h.gitSim,
      speculativeDepth: 1,
      flakyRetries: 0,
      policy,
      onEvent: (event) => events.push(event),
    });

    await h.enqueue(prA);
    await reconcile(buildContext());
    await reconcile(buildContext());
    await reconcile(buildContext());
    assert.strictEqual(h.entries[0]!.status, "merging");

    await reconcile(buildContext());

    assert.strictEqual(h.entries[0]!.status, "validating");
    assert.strictEqual(h.entries[0]!.retryAttempts, 0);
    assert.ok(h.entries[0]!.candidateSha, "policy movement must not manufacture a new candidate SHA");
    assert.deepStrictEqual(policy.getRequiredChecks(), ["Deploy"]);
    assert.ok(events.some((event) => event.action === "policy_changed"));
  });
});
