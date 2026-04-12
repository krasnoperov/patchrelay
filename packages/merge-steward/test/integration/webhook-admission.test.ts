import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { MemoryStore } from "../../src/memory-store.ts";
import { GitSim } from "../../src/sim/git-sim.ts";
import { CISim } from "../../src/sim/ci-sim.ts";
import { GitHubPolicyCache } from "../../src/github-policy.ts";
import { GitHubSim, EvictionReporterSim } from "../../src/sim/github-sim.ts";
import { MergeStewardService } from "../../src/service.ts";
import { buildMultiRepoHttpServer } from "../../src/http-multi.ts";
import type { StewardConfig } from "../../src/config.ts";
import pino from "pino";
import { SqliteStore } from "../../src/db/sqlite-store.ts";

const WEBHOOK_SECRET = "test-secret-123";
const githubAdmin = {
  getStatus() {
    return {
      mode: "app" as const,
      configured: true,
      ready: true,
      webhookSecretConfigured: true,
      appId: "123456",
      installationMode: "per_repo" as const,
    };
  },
  async discoverRepoSettings() {
    return {
      defaultBranch: "main",
      branch: "main",
      requiredChecks: [],
      warnings: [],
    };
  },
};

const config: StewardConfig = {
  repoId: "test-repo",
  repoFullName: "test/repo",
  baseBranch: "main",
  clonePath: "/tmp/test-clone",
  gitBin: "git",
  maxRetries: 2,
  flakyRetries: 1,
  pollIntervalMs: 60_000,
  admissionLabel: "queue",
  mergeQueueCheckName: "merge-steward/queue",
  excludeBranches: [],
  server: { bind: "127.0.0.1", port: 0 },
  database: { path: ":memory:", wal: true },
  logging: { level: "silent" },
  speculativeDepth: 1,
};

function sign(body: string): string {
  return "sha256=" + createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex");
}

function createPolicy(requiredChecks: string[] = []) {
  return new GitHubPolicyCache({
    repoFullName: config.repoFullName,
    initialRequiredChecks: requiredChecks,
    logger: pino({ level: "silent" }),
    refreshPolicy: async () => ({
      defaultBranch: config.baseBranch,
      branch: config.baseBranch,
      requiredChecks,
      warnings: [],
    }),
  });
}

function makeApp(service: MergeStewardService) {
  const instances = new Map([["test/repo", { config, service }]]);
  return buildMultiRepoHttpServer({
    instances,
    webhookSecret: WEBHOOK_SECRET,
    githubAdmin,
    logger: pino({ level: "silent" }),
  });
}

function webhookBody(payload: Record<string, unknown>): string {
  return JSON.stringify({ ...payload, repository: { full_name: "test/repo" } });
}

describe("webhook admission integration", () => {
  it("enqueues on label + approved + green, updates on push, dequeues on close", async () => {
    const store = new MemoryStore();
    const githubSim = new GitHubSim();
    const evictionSim = new EvictionReporterSim();
    const logger = pino({ level: "silent" });

    githubSim.addPR({ number: 42, branch: "feat-x", headSha: "sha-42", reviewApproved: true, labels: ["queue"] });
    githubSim.setChecks(42, [{ name: "checks", conclusion: "success" }]);

    const gitSim = new GitSim() as any;
    const service = new MergeStewardService(
      config, createPolicy(), store, gitSim, new CISim(() => "pass") as any,
      githubSim, evictionSim, gitSim, logger,
    );

    const app = await makeApp(service);
    const address = await app.listen({ port: 0 });
    after(async () => { await app.close(); });

    // 1. pr_labeled webhook — admission.
    const labelBody = webhookBody({
      action: "labeled",
      label: { name: "queue" },
      pull_request: { number: 42, head: { ref: "feat-x", sha: "sha-42" } },
    });

    const labelResp = await fetch(`${address}/webhooks/github`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-github-event": "pull_request", "x-hub-signature-256": sign(labelBody) },
      body: labelBody,
    });
    assert.strictEqual(labelResp.status, 200);

    const status1 = await (await fetch(`${address}/repos/test-repo/queue/status`)).json() as { entries: Array<{ prNumber: number; status: string }> };
    assert.strictEqual(status1.entries.length, 1);
    assert.strictEqual(status1.entries[0]!.prNumber, 42);
    assert.strictEqual(status1.entries[0]!.status, "queued");

    // 2. pr_synchronize — update head SHA.
    const syncBody = webhookBody({
      action: "synchronize",
      pull_request: { number: 42, head: { ref: "feat-x", sha: "new-sha-42" } },
    });

    await fetch(`${address}/webhooks/github`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-github-event": "pull_request", "x-hub-signature-256": sign(syncBody) },
      body: syncBody,
    });

    const status2 = await (await fetch(`${address}/repos/test-repo/queue/status`)).json() as { entries: Array<{ headSha: string; generation: number }> };
    assert.strictEqual(status2.entries[0]!.headSha, "new-sha-42");
    assert.strictEqual(status2.entries[0]!.generation, 1);

    // 3. pr_closed — dequeue.
    const closeBody = webhookBody({
      action: "closed",
      pull_request: { number: 42, merged: false, head: { ref: "feat-x", sha: "new-sha-42" } },
    });

    await fetch(`${address}/webhooks/github`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-github-event": "pull_request", "x-hub-signature-256": sign(closeBody) },
      body: closeBody,
    });

    const status3 = await (await fetch(`${address}/repos/test-repo/queue/status`)).json() as { entries: Array<{ status: string }> };
    assert.strictEqual(status3.entries[0]!.status, "dequeued");
  });

  it("rejects webhook with invalid signature", async () => {
    const store = new MemoryStore();
    const logger = pino({ level: "silent" });

    const service = new MergeStewardService(
      config, createPolicy(), store, new GitSim() as any, new CISim(() => "pass") as any,
      new GitHubSim(), new EvictionReporterSim(), new GitSim() as any, logger,
    );

    const app = await makeApp(service);
    const address = await app.listen({ port: 0 });
    after(async () => { await app.close(); });

    const body = JSON.stringify({ action: "labeled", repository: { full_name: "test/repo" } });
    const resp = await fetch(`${address}/webhooks/github`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-github-event": "pull_request", "x-hub-signature-256": "sha256=invalid" },
      body,
    });
    assert.strictEqual(resp.status, 401);
  });

  it("admits PR without label on review_approved when approval and CI are already green", async () => {
    const store = new MemoryStore();
    const githubSim = new GitHubSim();
    const logger = pino({ level: "silent" });

    githubSim.addPR({ number: 99, branch: "feat-y", headSha: "sha-99", reviewApproved: true, labels: [] });
    githubSim.setChecks(99, [{ name: "checks", conclusion: "success" }]);

    const service = new MergeStewardService(
      config, createPolicy(), store, new GitSim() as any, new CISim(() => "pass") as any,
      githubSim, new EvictionReporterSim(), new GitSim() as any, logger,
    );

    const app = await makeApp(service);
    const address = await app.listen({ port: 0 });
    after(async () => { await app.close(); });

    const reviewBody = webhookBody({
      action: "submitted",
      review: { state: "approved" },
      pull_request: { number: 99, head: { ref: "feat-y", sha: "sha-99" } },
    });

    await fetch(`${address}/webhooks/github`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-github-event": "pull_request_review", "x-hub-signature-256": sign(reviewBody) },
      body: reviewBody,
    });

    const status = await (await fetch(`${address}/repos/test-repo/queue/status`)).json() as {
      entries: Array<{ prNumber: number; status: string }>;
    };
    assert.strictEqual(status.entries.length, 1, "eligible PR should be admitted without a queue label");
    assert.strictEqual(status.entries[0]!.prNumber, 99);
    assert.strictEqual(status.entries[0]!.status, "queued");
  });

  it("admits PR when required check names differ only by case", async () => {
    const store = new MemoryStore();
    const githubSim = new GitHubSim();
    const logger = pino({ level: "silent" });

    githubSim.addPR({ number: 109, branch: "feat-case-check", headSha: "sha-109", reviewApproved: true, labels: [] });
    githubSim.setChecks(109, [{ name: "Verify", conclusion: "success" }]);

    const service = new MergeStewardService(
      config,
      createPolicy(["verify"]),
      store,
      new GitSim() as any,
      new CISim(() => "pass") as any,
      githubSim,
      new EvictionReporterSim(),
      new GitSim() as any,
      logger,
    );

    const app = await makeApp(service);
    const address = await app.listen({ port: 0 });
    after(async () => { await app.close(); });

    const reviewBody = webhookBody({
      action: "submitted",
      review: { state: "approved" },
      pull_request: { number: 109, head: { ref: "feat-case-check", sha: "sha-109" } },
    });

    await fetch(`${address}/webhooks/github`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-github-event": "pull_request_review", "x-hub-signature-256": sign(reviewBody) },
      body: reviewBody,
    });

    const status = await (await fetch(`${address}/repos/test-repo/queue/status`)).json() as {
      entries: Array<{ prNumber: number; status: string }>;
    };
    assert.strictEqual(status.entries.length, 1, "eligible PR should be admitted when check names only differ by case");
    assert.strictEqual(status.entries[0]!.prNumber, 109);
    assert.strictEqual(status.entries[0]!.status, "queued");
  });

  it("serves watch snapshots, entry detail, and manual reconcile control", async () => {
    const store = new MemoryStore();
    const githubSim = new GitHubSim();
    const logger = pino({ level: "silent" });

    githubSim.addPR({ number: 7, branch: "feat-watch", headSha: "sha-watch", reviewApproved: true, labels: ["queue"] });

    const service = new MergeStewardService(
      config, createPolicy(), store, new GitSim() as any, new CISim(() => "pass") as any,
      githubSim, new EvictionReporterSim(), new GitSim() as any, logger,
    );

    const entry = service.enqueue({ prNumber: 7, branch: "feat-watch", headSha: "sha-watch", issueKey: "USE-7" });

    const app = await makeApp(service);
    const address = await app.listen({ port: 0 });
    after(async () => { await app.close(); });

    const watch1 = await (await fetch(`${address}/repos/test-repo/queue/watch`)).json() as {
      summary: { total: number; active: number; headPrNumber: number | null };
      recentEvents: Array<{ prNumber: number; toStatus: string }>;
    };

    assert.strictEqual(watch1.summary.total, 1);
    assert.strictEqual(watch1.summary.active, 1);
    assert.strictEqual(watch1.summary.headPrNumber, 7);
    assert.strictEqual((watch1 as { queueBlock?: unknown }).queueBlock ?? null, null);
    assert.deepStrictEqual(watch1.recentEvents.map((event) => [event.prNumber, event.toStatus]), [[7, "queued"]]);

    const reconcile1 = await (await fetch(`${address}/repos/test-repo/queue/reconcile`, { method: "POST" })).json() as { ok: boolean; started: boolean };
    assert.strictEqual(reconcile1.ok, true);
    assert.strictEqual(reconcile1.started, true);

    const reconcile2 = await (await fetch(`${address}/repos/test-repo/queue/reconcile`, { method: "POST" })).json() as { ok: boolean; started: boolean };
    assert.strictEqual(reconcile2.ok, true);
    assert.strictEqual(reconcile2.started, true);

    const watch2 = await (await fetch(`${address}/repos/test-repo/queue/watch`)).json() as {
      summary: { preparingHead: number; headPrNumber: number | null };
      recentEvents: Array<{ prNumber: number; toStatus: string }>;
    };

    assert.strictEqual(watch2.summary.preparingHead, 1);
    assert.strictEqual(watch2.summary.headPrNumber, 7);
    assert.deepStrictEqual(
      watch2.recentEvents.map((event) => [event.prNumber, event.toStatus]),
      [[7, "queued"], [7, "preparing_head"]],
    );

    const detail = await (await fetch(`${address}/repos/test-repo/queue/entries/${entry.id}/detail`)).json() as {
      entry: { id: string; prNumber: number; status: string };
      events: Array<{ toStatus: string }>;
      incidents: unknown[];
    };

    assert.strictEqual(detail.entry.id, entry.id);
    assert.strictEqual(detail.entry.prNumber, 7);
    assert.strictEqual(detail.entry.status, "preparing_head");
    assert.deepStrictEqual(detail.events.map((event) => event.toStatus), ["queued", "preparing_head"]);
    assert.strictEqual(detail.incidents.length, 0);
  });

  it("surfaces queue-level main-broken status in watch snapshots", async () => {
    const store = new MemoryStore();
    const githubSim = new GitHubSim();
    const logger = pino({ level: "silent" });
    const git = new GitSim();
    await git.init("main");
    await git.createBranch("origin/main", "main");
    await git.createBranch("feat-main-broken", "main");
    await git.createBranch("origin/feat-main-broken", "main");

    const branchSha = await git.headSha("feat-main-broken");
    githubSim.addPR({ number: 8, branch: "feat-main-broken", headSha: branchSha, reviewApproved: true, labels: ["queue"] });
    githubSim.setRefChecks("main", [
      { name: "Tests", conclusion: "failure" },
      { name: "Deploy stage", conclusion: "failure" },
      { name: "Claude", conclusion: "pending" },
    ]);

    const ci = {
      async triggerRun() {
        return "ci-1";
      },
      async getStatus() {
        return "pending" as const;
      },
      async cancelRun() {},
      async getMainStatus() {
        return "fail" as const;
      },
    };

    const service = new MergeStewardService(
      config,
      createPolicy(["Tests"]),
      store,
      git as any,
      ci as any,
      githubSim,
      new EvictionReporterSim(),
      git as any,
      logger,
    );

    service.enqueue({ prNumber: 8, branch: "feat-main-broken", headSha: branchSha });

    const app = await makeApp(service);
    const address = await app.listen({ port: 0 });
    after(async () => { await app.close(); });

    const reconcile1 = await (await fetch(`${address}/repos/test-repo/queue/reconcile`, { method: "POST" })).json() as { ok: boolean; started: boolean };
    assert.strictEqual(reconcile1.ok, true);
    assert.strictEqual(reconcile1.started, true);

    const reconcile2 = await (await fetch(`${address}/repos/test-repo/queue/reconcile`, { method: "POST" })).json() as { ok: boolean; started: boolean };
    assert.strictEqual(reconcile2.ok, true);
    assert.strictEqual(reconcile2.started, true);

    const watch = await (await fetch(`${address}/repos/test-repo/queue/watch`)).json() as {
      summary: { headPrNumber: number | null; preparingHead: number };
      queueBlock: {
        reason: string;
        headPrNumber: number | null;
        baseBranch: string;
        failingChecks: Array<{ name: string; conclusion: string }>;
        pendingChecks: Array<{ name: string; conclusion: string }>;
        missingRequiredChecks: string[];
      } | null;
    };

    assert.strictEqual(watch.summary.headPrNumber, 8);
    assert.strictEqual(watch.summary.preparingHead, 1);
    assert.ok(watch.queueBlock);
    assert.strictEqual(watch.queueBlock?.reason, "main_broken");
    assert.strictEqual(watch.queueBlock?.baseBranch, "main");
    assert.deepStrictEqual(watch.queueBlock?.missingRequiredChecks, []);
    assert.deepStrictEqual(watch.queueBlock?.failingChecks.map((check) => check.name), ["Tests", "Deploy stage"]);
    assert.deepStrictEqual(watch.queueBlock?.pendingChecks.map((check) => check.name), ["Claude"]);
  });

  it("entry detail returns the most recent events when eventLimit is applied", async () => {
    const store = new SqliteStore(":memory:");
    const logger = pino({ level: "silent" });

    const service = new MergeStewardService(
      config, createPolicy(), store, new GitSim() as any, new CISim(() => "pass") as any,
      new GitHubSim(), new EvictionReporterSim(), new GitSim() as any, logger,
    );

    const entry = service.enqueue({ prNumber: 55, branch: "feat-history", headSha: "sha-history" });

    store.transition(entry.id, "preparing_head");
    store.transition(entry.id, "validating");
    store.transition(entry.id, "merging");

    const instances = new Map([["test/repo", { config, service }]]);
    const app = await buildMultiRepoHttpServer({
      instances,
      webhookSecret: WEBHOOK_SECRET,
      githubAdmin,
      logger,
    });
    const address = await app.listen({ port: 0 });
    after(async () => { await app.close(); store.close(); });

    const detail = await (await fetch(`${address}/repos/test-repo/queue/entries/${entry.id}/detail?eventLimit=2`)).json() as { events: Array<{ toStatus: string }> };
    assert.deepStrictEqual(detail.events.map((event) => event.toStatus), ["validating", "merging"]);
  });

  it("startup scan admits already-eligible open PRs without requiring a queue label", async () => {
    const store = new MemoryStore();
    const githubSim = new GitHubSim();
    const logger = pino({ level: "silent" });

    githubSim.addPR({ number: 123, branch: "feat-startup", headSha: "sha-startup", reviewApproved: true, labels: [] });
    githubSim.setChecks(123, [{ name: "checks", conclusion: "success" }]);

    const service = new MergeStewardService(
      config, createPolicy(), store, new GitSim() as any, new CISim(() => "pass") as any,
      githubSim, new EvictionReporterSim(), new GitSim() as any, logger,
    );

    await service.start();
    try {
      const entries = store.listAll("test-repo");
      assert.strictEqual(entries.length, 1);
      assert.strictEqual(entries[0]!.prNumber, 123);
      assert.strictEqual(entries[0]!.status, "queued");
    } finally {
      await service.stop();
    }
  });

  it("refreshes GitHub policy when a branch protection webhook arrives", async () => {
    const store = new MemoryStore();
    const logger = pino({ level: "silent" });
    let requiredChecks = ["Checks"];
    const policy = new GitHubPolicyCache({
      repoFullName: config.repoFullName,
      initialRequiredChecks: requiredChecks,
      logger,
      refreshPolicy: async () => ({
        defaultBranch: config.baseBranch,
        branch: config.baseBranch,
        requiredChecks,
        warnings: [],
      }),
    });
    const service = new MergeStewardService(
      config, policy, store, new GitSim() as any, new CISim(() => "pass") as any,
      new GitHubSim(), new EvictionReporterSim(), new GitSim() as any, logger,
    );

    const app = await makeApp(service);
    const address = await app.listen({ port: 0 });
    after(async () => { await app.close(); });

    requiredChecks = ["Deploy"];
    const body = JSON.stringify({
      action: "edited",
      repository: { full_name: "test/repo" },
      rule: { name: "main" },
    });

    const response = await fetch(`${address}/webhooks/github`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-github-event": "branch_protection_rule", "x-hub-signature-256": sign(body) },
      body,
    });

    assert.strictEqual(response.status, 200);
    assert.deepStrictEqual(service.getGitHubPolicy().requiredChecks, ["Deploy"]);
  });
});
