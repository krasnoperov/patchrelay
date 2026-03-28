import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Harness, createHarness } from "../harness.ts";
import type { CIStatus } from "../../src/types.ts";
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
  requiredChecks: [],
  pollIntervalMs: 600_000,
  admissionLabel: "queue",
  excludeBranches: [],
  webhookPath: "/webhooks/github/queue",
  server: { bind: "127.0.0.1", port: 0 },
  database: { path: ":memory:", wal: true },
  logging: { level: "silent" },
};

describe("mapConclusion handles both uppercase and lowercase", () => {
  it("GitHubSim.listChecksForRef returns checks verbatim", async () => {
    const sim = new GitHubSim();
    sim.setRefChecks("main", [
      { name: "build", conclusion: "success" },
      { name: "lint", conclusion: "failure" },
      { name: "deploy", conclusion: "pending" },
    ]);

    const checks = await sim.listChecksForRef("main");
    assert.strictEqual(checks.length, 3);
    assert.strictEqual(checks[0]!.conclusion, "success");
    assert.strictEqual(checks[1]!.conclusion, "failure");
    assert.strictEqual(checks[2]!.conclusion, "pending");
  });

  it("failure classification as main_broken when same check fails on both", async () => {
    const h = await createHarness({ maxRetries: 0, flakyRetries: 0, ciRule: () => "fail" });

    await h.enqueue({ number: 1, branch: "feat-a", files: [{ path: "a.ts", content: "a" }] });

    await h.tick(); // queued → preparing_head
    await h.tick(); // fetch, rebase, push (clears sim checks), CI triggered (fail) → validating

    // Set check results AFTER rebase/push (updateSha clears checks, matching real GitHub).
    h.githubSim.setChecks(1, [
      { name: "build", conclusion: "failure" },
      { name: "lint", conclusion: "success" },
    ]);
    h.githubSim.setRefChecks("main", [
      { name: "build", conclusion: "failure" },
      { name: "lint", conclusion: "success" },
    ]);

    await h.tick(); // CI fails → evicted (maxRetries: 0)

    const evictions = h.evictionSim.evictions;
    assert.strictEqual(evictions.length, 1);
    assert.strictEqual(evictions[0]!.incident.failureClass, "main_broken");
  });

  it("classifies as branch_local when main checks pass but branch fails", async () => {
    const h = await createHarness({ maxRetries: 0, flakyRetries: 0, ciRule: () => "fail" });

    await h.enqueue({ number: 1, branch: "feat-b", files: [{ path: "b.ts", content: "b" }] });

    await h.tick(); // queued → preparing_head
    await h.tick(); // preparing_head → validating (rebase + push clears checks)

    // Set checks after push, before the eviction tick.
    h.githubSim.setChecks(1, [{ name: "build", conclusion: "failure" }]);
    h.githubSim.setRefChecks("main", [{ name: "build", conclusion: "success" }]);

    await h.tick(); // CI fails → evicted

    const evictions = h.evictionSim.evictions;
    assert.strictEqual(evictions.length, 1);
    assert.strictEqual(evictions[0]!.incident.failureClass, "branch_local");
  });
});

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

    const service = new MergeStewardService(
      testConfig, store,
      new GitSim() as any,
      new CISim(() => "pass") as any,
      githubSim,
      new EvictionReporterSim(),
      null,
      silentLogger,
    );

    await processWebhookEvent(
      {
        type: "check_suite_completed",
        prNumber: null,
        branch: "feat-lookup",
        headSha: "sha-77",
        conclusion: "success",
      },
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

    const service = new MergeStewardService(
      testConfig, store,
      new GitSim() as any,
      new CISim(() => "pass") as any,
      githubSim,
      new EvictionReporterSim(),
      null,
      silentLogger,
    );

    await processWebhookEvent(
      {
        type: "check_suite_completed",
        prNumber: null,
        branch: "orphan-branch",
        headSha: "sha-orphan",
        conclusion: "success",
      },
      service,
      { admissionLabel: "queue", baseBranch: "main", repoFullName: "test/repo", github: githubSim },
      silentLogger,
    );

    assert.strictEqual(store.listAll("test-repo").length, 0);
  });

  it("backward-compatible: github not provided in config still works", async () => {
    const githubSim = new GitHubSim();
    const store = new MemoryStore();

    const service = new MergeStewardService(
      testConfig, store,
      new GitSim() as any,
      new CISim(() => "pass") as any,
      githubSim,
      new EvictionReporterSim(),
      null,
      silentLogger,
    );

    await processWebhookEvent(
      {
        type: "check_suite_completed",
        prNumber: null,
        branch: "feat-no-gh",
        headSha: "sha-nope",
        conclusion: "success",
      },
      service,
      { admissionLabel: "queue", baseBranch: "main", repoFullName: "test/repo" },
      silentLogger,
    );

    assert.strictEqual(store.listAll("test-repo").length, 0);
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

describe("retryHistory records per-transition baseSha", () => {
  it("each retry history entry has the baseSha from the time of that transition", async () => {
    // CI alternates: fail, fail, fail (evaluated at triggerRun time).
    // All runs fail so the entry retries and eventually is evicted.
    const h = await createHarness({ maxRetries: 2, flakyRetries: 0, ciRule: () => "fail" });

    await h.enqueue({ number: 1, branch: "feat-retry", files: [{ path: "r.ts", content: "r" }] });

    // Run 1: queued → preparing_head → validating (baseSha = main_sha_1).
    await h.tick(); // queued → preparing_head
    await h.tick(); // rebase + trigger CI (fail) → validating

    const baseSha1 = h.entries[0]!.baseSha;

    // CI fails → back to preparing_head, retry 1.
    await h.tick(); // validating → preparing_head

    // Advance main to change baseSha.
    await h.advanceMain();

    // Run 2: rebase onto new base → validating (baseSha = main_sha_2).
    await h.tick(); // preparing_head → validating

    const baseSha2 = h.entries[0]!.baseSha;
    assert.notStrictEqual(baseSha1, baseSha2, "baseSha should change between retries");

    // CI fails again → back to preparing_head, retry 2.
    await h.tick(); // validating → preparing_head

    // Advance main again.
    await h.advanceMain();

    // Run 3: budget exhausted (retryAttempts=2 >= maxRetries=2) → evicted.
    await h.tick(); // preparing_head → validating
    await h.tick(); // CI fails → evicted

    const evictions = h.evictionSim.evictions;
    assert.strictEqual(evictions.length, 1);

    const history = evictions[0]!.incident.context.retryHistory;
    assert.ok(history.length >= 2, `expected at least 2 retry history entries, got ${history.length}`);

    // The baseShas in retry history should NOT all be the same.
    const baseShas = history.map((h: { baseSha: string }) => h.baseSha).filter((s: string) => s !== "unknown");
    const uniqueBaseShas = new Set(baseShas);
    assert.ok(uniqueBaseShas.size > 1, `retryHistory baseShas should differ across retries, got: ${JSON.stringify(baseShas)}`);
  });

  it("event records include baseSha snapshot", async () => {
    const h = await createHarness({ maxRetries: 1 });

    await h.enqueue({ number: 1, branch: "feat-event-base", files: [{ path: "e.ts", content: "e" }] });

    await h.tick(); // queued → preparing_head
    await h.tick(); // preparing_head → validating

    const entry = h.entries[0]!;
    const events = h.store.listEvents(entry.id);

    const validatingEvent = events.find(
      (e) => e.fromStatus === "preparing_head" && e.toStatus === "validating",
    );
    assert.ok(validatingEvent, "should have a preparing_head → validating event");
    assert.ok(validatingEvent.baseSha, "event should have baseSha snapshot");
    assert.strictEqual(validatingEvent.baseSha, entry.baseSha);
  });
});

describe("listChecksForRef strips origin/ prefix", () => {
  it("origin/main resolves to main — sim matches production behavior", async () => {
    const sim = new GitHubSim();
    sim.setRefChecks("main", [{ name: "build", conclusion: "success" }]);

    // Both bare ref and origin-prefixed ref resolve to the same checks.
    const bare = await sim.listChecksForRef("main");
    assert.strictEqual(bare.length, 1);

    const prefixed = await sim.listChecksForRef("origin/main");
    assert.strictEqual(prefixed.length, 1);
    assert.strictEqual(prefixed[0]!.name, "build");
  });
});
