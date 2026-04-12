import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { GitHubPolicyCache } from "../../src/github-policy.ts";
import { normalizeWebhook, processWebhookEvent } from "../../src/webhook-handler.ts";
import { GitHubSim, EvictionReporterSim } from "../../src/sim/github-sim.ts";
import { MemoryStore } from "../../src/memory-store.ts";
import { MergeStewardService } from "../../src/service.ts";
import { GitSim } from "../../src/sim/git-sim.ts";
import { CISim } from "../../src/sim/ci-sim.ts";
import pino from "pino";
import type { StewardConfig } from "../../src/config.ts";

const silentLogger = pino({ level: "silent" });

const testConfig: StewardConfig = {
  repoId: "test-repo",
  repoFullName: "test/repo",
  baseBranch: "main",
  clonePath: "/tmp/test-clone",
  gitBin: "git",
  maxRetries: 2,
  flakyRetries: 0,
  speculativeDepth: 1,
  pollIntervalMs: 600_000,
  admissionLabel: "queue",
  mergeQueueCheckName: "merge-steward/queue",
  excludeBranches: [],
  server: { bind: "127.0.0.1", port: 0 },
  database: { path: ":memory:", wal: true },
  logging: { level: "silent" },
};

function createService(store: MemoryStore, githubSim: GitHubSim) {
  return new MergeStewardService(
    testConfig,
    new GitHubPolicyCache({
      repoFullName: "test/repo",
      initialRequiredChecks: [],
      logger: silentLogger,
      refreshPolicy: async () => ({ defaultBranch: "main", branch: "main", requiredChecks: [], warnings: [] }),
    }),
    store,
    new GitSim() as any,
    new CISim(() => "pass") as any,
    githubSim,
    new EvictionReporterSim(),
    null,
    silentLogger,
  );
}

describe("check_suite_completed with empty pull_requests", () => {
  it("normalizes to prNumber: null when pull_requests is empty", () => {
    const event = normalizeWebhook("check_suite", {
      action: "completed",
      check_suite: {
        head_branch: "feat-x",
        head_sha: "sha-x",
        conclusion: "success",
        pull_requests: [],
      },
    });

    assert.ok(event);
    assert.strictEqual(event.type, "check_suite_completed");
    if (event.type === "check_suite_completed") {
      assert.strictEqual(event.prNumber, null);
      assert.strictEqual(event.branch, "feat-x");
    }
  });

  it("resolves PR by branch when pull_requests is empty via findPRByBranch", async () => {
    const githubSim = new GitHubSim();
    const store = new MemoryStore();
    githubSim.addPR({ number: 77, branch: "feat-lookup", headSha: "sha-77", reviewApproved: true, labels: ["queue"] });
    githubSim.setChecks(77, [{ name: "build", conclusion: "success" }]);

    const service = createService(store, githubSim);

    await processWebhookEvent(
      { type: "check_suite_completed", prNumber: null, branch: "feat-lookup", headSha: "sha-77", conclusion: "success" },
      service,
      { admissionLabel: "queue", baseBranch: "main", repoFullName: "test/repo", github: githubSim },
      silentLogger,
    );

    const entries = store.listAll("test-repo");
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0]!.prNumber, 77);
  });

  it("skips admission when no PR found for branch", async () => {
    const githubSim = new GitHubSim();
    const store = new MemoryStore();
    const service = createService(store, githubSim);

    await processWebhookEvent(
      { type: "check_suite_completed", prNumber: null, branch: "orphan-branch", headSha: "sha-orphan", conclusion: "success" },
      service,
      { admissionLabel: "queue", baseBranch: "main", repoFullName: "test/repo", github: githubSim },
      silentLogger,
    );

    assert.strictEqual(store.listAll("test-repo").length, 0);
  });

  it("skips lookup when github client not provided", async () => {
    const githubSim = new GitHubSim();
    const store = new MemoryStore();
    const service = createService(store, githubSim);

    await processWebhookEvent(
      { type: "check_suite_completed", prNumber: null, branch: "feat-no-gh", headSha: "sha-nope", conclusion: "success" },
      service,
      { admissionLabel: "queue", baseBranch: "main", repoFullName: "test/repo" },
      silentLogger,
    );

    assert.strictEqual(store.listAll("test-repo").length, 0);
  });
});

describe("policy webhooks", () => {
  it("normalizes branch protection rule edits into policy_changed events", () => {
    const event = normalizeWebhook("branch_protection_rule", {
      action: "edited",
      rule: { name: "main" },
    });

    assert.deepStrictEqual(event, {
      type: "policy_changed",
      source: "branch_protection_rule",
      action: "edited",
    });
  });

  it("normalizes repository ruleset edits into policy_changed events", () => {
    const event = normalizeWebhook("repository_ruleset", {
      action: "edited",
      repository_ruleset: { name: "Default" },
    });

    assert.deepStrictEqual(event, {
      type: "policy_changed",
      source: "repository_ruleset",
      action: "edited",
    });
  });
});

describe("findPRByBranch sim", () => {
  it("finds open PR by branch name", async () => {
    const sim = new GitHubSim();
    sim.addPR({ number: 10, branch: "feat-find", headSha: "sha-10" });

    assert.strictEqual(await sim.findPRByBranch("feat-find"), 10);
    assert.strictEqual(await sim.findPRByBranch("nonexistent"), null);
  });

  it("does not return merged PRs", async () => {
    const sim = new GitHubSim();
    sim.addPR({ number: 20, branch: "feat-merged", headSha: "sha-20" });
    await sim.mergePR(20);

    assert.strictEqual(await sim.findPRByBranch("feat-merged"), null);
  });
});
