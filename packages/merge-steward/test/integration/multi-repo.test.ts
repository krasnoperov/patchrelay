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
import type { RepoRuntimeRecord } from "../../src/repo-runtime.ts";
import pino from "pino";

const WEBHOOK_SECRET = "multi-repo-test-secret";
const logger = pino({ level: "silent" });
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
      requiredChecks: ["ci"],
      warnings: [],
    };
  },
};

function makeConfig(repoId: string, repoFullName: string): StewardConfig {
  return {
    repoId,
    repoFullName,
    baseBranch: "main",
    clonePath: `/tmp/test-clone-${repoId}`,
    gitBin: "git",
    maxRetries: 2,
    flakyRetries: 0,
    pollIntervalMs: 60_000,
    admissionLabel: "queue",
    mergeQueueCheckName: "merge-steward/queue",
    excludeBranches: [],
    server: { bind: "127.0.0.1", port: 0 },
    database: { path: ":memory:", wal: true },
    logging: { level: "silent" },
    speculativeDepth: 1,
  };
}

function makeServiceAndConfig(repoId: string, repoFullName: string) {
  const config = makeConfig(repoId, repoFullName);
  const store = new MemoryStore();
  const githubSim = new GitHubSim();
  const service = new MergeStewardService(
    config,
    new GitHubPolicyCache({
      repoFullName,
      initialRequiredChecks: ["ci"],
      logger,
      refreshPolicy: async () => ({ defaultBranch: "main", branch: "main", requiredChecks: ["ci"], warnings: [] }),
    }),
    store,
    new GitSim() as any,
    new CISim(() => "pass") as any,
    githubSim,
    new EvictionReporterSim(),
    null,
    logger,
  );
  return { config, service, store, githubSim };
}

function sign(body: string, secret = WEBHOOK_SECRET): string {
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
}

function readyRecord(item: ReturnType<typeof makeServiceAndConfig>): RepoRuntimeRecord {
  return {
    config: item.config,
    state: "ready",
    startedAt: new Date().toISOString(),
    readyAt: new Date().toISOString(),
    instance: { config: item.config, service: item.service, store: item.store as any },
  };
}

function labelWebhookBody(repoFullName: string, prNumber: number, branch: string, sha: string): string {
  return JSON.stringify({
    action: "labeled",
    label: { name: "queue" },
    repository: { full_name: repoFullName },
    pull_request: { number: prNumber, head: { ref: branch, sha } },
  });
}

describe("multi-repo HTTP server", () => {
  it("routes webhook to the correct repo by repository.full_name", async () => {
    const a = makeServiceAndConfig("repo-a", "org/repo-a");
    const b = makeServiceAndConfig("repo-b", "org/repo-b");

    a.githubSim.addPR({ number: 1, branch: "feat-a", headSha: "sha-a", reviewApproved: true, labels: ["queue"] });
    a.githubSim.setChecks(1, [{ name: "ci", conclusion: "success" }]);

    const repos = new Map([
      ["org/repo-a", readyRecord(a)],
      ["org/repo-b", readyRecord(b)],
    ]);
    const app = await buildMultiRepoHttpServer({ repos, webhookSecret: WEBHOOK_SECRET, githubAdmin, logger });
    const address = await app.listen({ port: 0 });
    after(async () => { await app.close(); });

    const body = labelWebhookBody("org/repo-a", 1, "feat-a", "sha-a");
    const resp = await fetch(`${address}/webhooks/github`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "pull_request",
        "x-hub-signature-256": sign(body),
      },
      body,
    });

    assert.strictEqual(resp.status, 200);
    const result = await resp.json() as { ok: boolean; repo: string };
    assert.strictEqual(result.repo, "org/repo-a");

    const statusA = await (await fetch(`${address}/repos/repo-a/queue/status`)).json() as { entries: Array<{ prNumber: number }> };
    assert.strictEqual(statusA.entries.length, 1);
    assert.strictEqual(statusA.entries[0]!.prNumber, 1);

    const statusB = await (await fetch(`${address}/repos/repo-b/queue/status`)).json() as { entries: unknown[] };
    assert.strictEqual(statusB.entries.length, 0);
  });

  it("ignores webhook for unknown repo", async () => {
    const a = makeServiceAndConfig("repo-a", "org/repo-a");
    const repos = new Map([["org/repo-a", readyRecord(a)]]);
    const app = await buildMultiRepoHttpServer({ repos, webhookSecret: WEBHOOK_SECRET, githubAdmin, logger });
    const address = await app.listen({ port: 0 });
    after(async () => { await app.close(); });

    const body = labelWebhookBody("org/unknown", 99, "feat-x", "sha-x");
    const resp = await fetch(`${address}/webhooks/github`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "pull_request",
        "x-hub-signature-256": sign(body),
      },
      body,
    });
    assert.strictEqual(resp.status, 200);
    const result = await resp.json() as { ok: boolean; ignored: boolean; reason: string };
    assert.strictEqual(result.ignored, true);
    assert.strictEqual(result.reason, "unknown_repo");

    const statusA = await (await fetch(`${address}/repos/repo-a/queue/status`)).json() as { entries: unknown[] };
    assert.strictEqual(statusA.entries.length, 0);
  });

  it("rejects webhook with invalid signature", async () => {
    const a = makeServiceAndConfig("repo-a", "org/repo-a");
    const repos = new Map([["org/repo-a", readyRecord(a)]]);
    const app = await buildMultiRepoHttpServer({ repos, webhookSecret: WEBHOOK_SECRET, githubAdmin, logger });
    const address = await app.listen({ port: 0 });
    after(async () => { await app.close(); });

    const body = labelWebhookBody("org/repo-a", 1, "feat-a", "sha-a");
    const resp = await fetch(`${address}/webhooks/github`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "pull_request",
        "x-hub-signature-256": "sha256=invalid",
      },
      body,
    });
    assert.strictEqual(resp.status, 401);
  });

  it("accepts unsigned webhook when no secret configured", async () => {
    const a = makeServiceAndConfig("repo-a", "org/repo-a");
    a.githubSim.addPR({ number: 1, branch: "feat-a", headSha: "sha-a", reviewApproved: true, labels: ["queue"] });
    a.githubSim.setChecks(1, [{ name: "ci", conclusion: "success" }]);

    const repos = new Map([["org/repo-a", readyRecord(a)]]);
    const app = await buildMultiRepoHttpServer({ repos, webhookSecret: undefined, githubAdmin, logger });
    const address = await app.listen({ port: 0 });
    after(async () => { await app.close(); });

    const body = labelWebhookBody("org/repo-a", 1, "feat-a", "sha-a");
    const resp = await fetch(`${address}/webhooks/github`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "pull_request",
      },
      body,
    });
    assert.strictEqual(resp.status, 200);

    const status = await (await fetch(`${address}/repos/repo-a/queue/status`)).json() as { entries: unknown[] };
    assert.strictEqual(status.entries.length, 1);
  });

  it("health lists all repos", async () => {
    const a = makeServiceAndConfig("repo-a", "org/repo-a");
    const b = makeServiceAndConfig("repo-b", "org/repo-b");
    const repos = new Map([
      ["org/repo-a", readyRecord(a)],
      ["org/repo-b", readyRecord(b)],
    ]);
    const app = await buildMultiRepoHttpServer({ repos, webhookSecret: undefined, githubAdmin, logger });
    const address = await app.listen({ port: 0 });
    after(async () => { await app.close(); });

    const health = await (await fetch(`${address}/health`)).json() as {
      ok: boolean;
      repos: Array<{ repoId: string; repoFullName: string }>;
    };
    assert.strictEqual(health.ok, true);
    assert.strictEqual(health.repos.length, 2);
    const ids = health.repos.map((r) => r.repoId).sort();
    assert.deepStrictEqual(ids, ["repo-a", "repo-b"]);
  });

  it("per-repo reconcile triggers only that repo", async () => {
    const a = makeServiceAndConfig("repo-a", "org/repo-a");
    const b = makeServiceAndConfig("repo-b", "org/repo-b");

    a.service.enqueue({ prNumber: 1, branch: "feat-a", headSha: "sha-a" });
    b.service.enqueue({ prNumber: 2, branch: "feat-b", headSha: "sha-b" });

    const repos = new Map([
      ["org/repo-a", readyRecord(a)],
      ["org/repo-b", readyRecord(b)],
    ]);
    const app = await buildMultiRepoHttpServer({ repos, webhookSecret: undefined, githubAdmin, logger });
    const address = await app.listen({ port: 0 });
    after(async () => { await app.close(); });

    await fetch(`${address}/repos/repo-a/queue/reconcile`, { method: "POST" });

    const statusA = await (await fetch(`${address}/repos/repo-a/queue/status`)).json() as { entries: Array<{ status: string }> };
    const statusB = await (await fetch(`${address}/repos/repo-b/queue/status`)).json() as { entries: Array<{ status: string }> };

    assert.notStrictEqual(statusA.entries[0]!.status, "queued", "repo-a should have advanced");
    assert.strictEqual(statusB.entries[0]!.status, "queued", "repo-b should not have advanced");
  });

  it("returns 404 for unknown repoId", async () => {
    const a = makeServiceAndConfig("repo-a", "org/repo-a");
    const repos = new Map([["org/repo-a", readyRecord(a)]]);
    const app = await buildMultiRepoHttpServer({ repos, webhookSecret: undefined, githubAdmin, logger });
    const address = await app.listen({ port: 0 });
    after(async () => { await app.close(); });

    const resp = await fetch(`${address}/repos/nonexistent/queue/status`);
    assert.strictEqual(resp.status, 404);
  });

  it("rejects webhook missing x-github-event header", async () => {
    const a = makeServiceAndConfig("repo-a", "org/repo-a");
    const repos = new Map([["org/repo-a", readyRecord(a)]]);
    const app = await buildMultiRepoHttpServer({ repos, webhookSecret: undefined, githubAdmin, logger });
    const address = await app.listen({ port: 0 });
    after(async () => { await app.close(); });

    const resp = await fetch(`${address}/webhooks/github`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repository: { full_name: "org/repo-a" } }),
    });
    assert.strictEqual(resp.status, 400);
  });

  it("exposes service runtime auth status through the admin endpoint", async () => {
    const a = makeServiceAndConfig("repo-a", "org/repo-a");
    const repos = new Map([["org/repo-a", readyRecord(a)]]);
    const app = await buildMultiRepoHttpServer({ repos, webhookSecret: undefined, githubAdmin, logger });
    const address = await app.listen({ port: 0 });
    after(async () => { await app.close(); });

    const result = await (await fetch(`${address}/admin/runtime/auth`)).json() as {
      mode: string;
      ready: boolean;
      webhookSecretConfigured: boolean;
      appId?: string;
    };
    assert.strictEqual(result.mode, "app");
    assert.strictEqual(result.ready, true);
    assert.strictEqual(result.webhookSecretConfigured, true);
    assert.strictEqual(result.appId, "123456");
  });

  it("exposes repo discovery through the admin endpoint", async () => {
    const a = makeServiceAndConfig("repo-a", "org/repo-a");
    const repos = new Map([["org/repo-a", readyRecord(a)]]);
    const app = await buildMultiRepoHttpServer({ repos, webhookSecret: undefined, githubAdmin, logger });
    const address = await app.listen({ port: 0 });
    after(async () => { await app.close(); });

    const resp = await fetch(`${address}/admin/github/discover`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repoFullName: "org/repo-a", baseBranch: "main" }),
    });
    assert.strictEqual(resp.status, 200);
    const result = await resp.json() as {
      ok: boolean;
      discovery: { defaultBranch: string; branch: string; requiredChecks: string[] };
    };
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.discovery.defaultBranch, "main");
    assert.strictEqual(result.discovery.branch, "main");
    assert.deepStrictEqual(result.discovery.requiredChecks, ["ci"]);
  });

  it("returns 503 when repo discovery fails", async () => {
    const a = makeServiceAndConfig("repo-a", "org/repo-a");
    const repos = new Map([["org/repo-a", readyRecord(a)]]);
    const app = await buildMultiRepoHttpServer({
      repos,
      webhookSecret: undefined,
      githubAdmin: {
        ...githubAdmin,
        async discoverRepoSettings() {
          throw new Error("GitHub App auth is not ready");
        },
      },
      logger,
    });
    const address = await app.listen({ port: 0 });
    after(async () => { await app.close(); });

    const resp = await fetch(`${address}/admin/github/discover`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repoFullName: "org/repo-a" }),
    });
    assert.strictEqual(resp.status, 503);
    const result = await resp.json() as { ok: boolean; error: string };
    assert.strictEqual(result.ok, false);
    assert.match(result.error, /not ready/);
  });

  it("reports initializing repos through health and repo endpoints", async () => {
    const a = makeServiceAndConfig("repo-a", "org/repo-a");
    const repos = new Map<string, RepoRuntimeRecord>([["org/repo-a", {
      config: a.config,
      state: "initializing",
      startedAt: new Date().toISOString(),
    }]]);
    const app = await buildMultiRepoHttpServer({ repos, webhookSecret: undefined, githubAdmin, logger });
    const address = await app.listen({ port: 0 });
    after(async () => { await app.close(); });

    const health = await (await fetch(`${address}/health`)).json() as {
      startupComplete: boolean;
      repos: Array<{ repoId: string; state: string }>;
    };
    assert.strictEqual(health.startupComplete, false);
    assert.strictEqual(health.repos[0]?.state, "initializing");

    const resp = await fetch(`${address}/repos/repo-a/queue/status`);
    assert.strictEqual(resp.status, 503);
    const result = await resp.json() as { ok: boolean; code: string; error: string };
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.code, "repo_initializing");
  });

  it("reports repo-local initialization failures without affecting other repos", async () => {
    const a = makeServiceAndConfig("repo-a", "org/repo-a");
    const b = makeServiceAndConfig("repo-b", "org/repo-b");
    const repos = new Map<string, RepoRuntimeRecord>([
      ["org/repo-a", readyRecord(a)],
      ["org/repo-b", {
        config: b.config,
        state: "failed",
        startedAt: new Date().toISOString(),
        failedAt: new Date().toISOString(),
        lastError: "clone failed",
      }],
    ]);
    const app = await buildMultiRepoHttpServer({ repos, webhookSecret: undefined, githubAdmin, logger });
    const address = await app.listen({ port: 0 });
    after(async () => { await app.close(); });

    const okResp = await fetch(`${address}/repos/repo-a/queue/status`);
    assert.strictEqual(okResp.status, 200);

    const failedResp = await fetch(`${address}/repos/repo-b/queue/status`);
    assert.strictEqual(failedResp.status, 503);
    const result = await failedResp.json() as { code: string; error: string };
    assert.strictEqual(result.code, "repo_init_failed");
    assert.match(result.error, /clone failed/);
  });
});
