import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { MemoryStore } from "../../src/memory-store.ts";
import { GitSim } from "../../src/sim/git-sim.ts";
import { CISim } from "../../src/sim/ci-sim.ts";
import { GitHubSim, EvictionReporterSim } from "../../src/sim/github-sim.ts";
import { MergeStewardService } from "../../src/service.ts";
import { buildMultiRepoHttpServer } from "../../src/http-multi.ts";
import type { StewardConfig } from "../../src/config.ts";
import pino from "pino";

const WEBHOOK_SECRET = "multi-repo-test-secret";
const logger = pino({ level: "silent" });

function makeConfig(repoId: string, repoFullName: string): StewardConfig {
  return {
    repoId,
    repoFullName,
    baseBranch: "main",
    clonePath: `/tmp/test-clone-${repoId}`,
    gitBin: "git",
    maxRetries: 2,
    flakyRetries: 0,
    requiredChecks: [],
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
    config, store,
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

    const instances = new Map([
      ["org/repo-a", { config: a.config, service: a.service }],
      ["org/repo-b", { config: b.config, service: b.service }],
    ]);
    const app = await buildMultiRepoHttpServer({ instances, webhookSecret: WEBHOOK_SECRET, logger });
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

    // repo-a has the entry
    const statusA = await (await fetch(`${address}/repos/repo-a/queue/status`)).json() as { entries: Array<{ prNumber: number }> };
    assert.strictEqual(statusA.entries.length, 1);
    assert.strictEqual(statusA.entries[0]!.prNumber, 1);

    // repo-b is empty
    const statusB = await (await fetch(`${address}/repos/repo-b/queue/status`)).json() as { entries: unknown[] };
    assert.strictEqual(statusB.entries.length, 0);
  });

  it("ignores webhook for unknown repo", async () => {
    const a = makeServiceAndConfig("repo-a", "org/repo-a");
    const instances = new Map([["org/repo-a", { config: a.config, service: a.service }]]);
    const app = await buildMultiRepoHttpServer({ instances, webhookSecret: WEBHOOK_SECRET, logger });
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
    const instances = new Map([["org/repo-a", { config: a.config, service: a.service }]]);
    const app = await buildMultiRepoHttpServer({ instances, webhookSecret: WEBHOOK_SECRET, logger });
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

    const instances = new Map([["org/repo-a", { config: a.config, service: a.service }]]);
    const app = await buildMultiRepoHttpServer({ instances, webhookSecret: undefined, logger });
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
    const instances = new Map([
      ["org/repo-a", { config: a.config, service: a.service }],
      ["org/repo-b", { config: b.config, service: b.service }],
    ]);
    const app = await buildMultiRepoHttpServer({ instances, webhookSecret: undefined, logger });
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

    const instances = new Map([
      ["org/repo-a", { config: a.config, service: a.service }],
      ["org/repo-b", { config: b.config, service: b.service }],
    ]);
    const app = await buildMultiRepoHttpServer({ instances, webhookSecret: undefined, logger });
    const address = await app.listen({ port: 0 });
    after(async () => { await app.close(); });

    // Reconcile only repo-a
    await fetch(`${address}/repos/repo-a/queue/reconcile`, { method: "POST" });

    const statusA = await (await fetch(`${address}/repos/repo-a/queue/status`)).json() as { entries: Array<{ status: string }> };
    const statusB = await (await fetch(`${address}/repos/repo-b/queue/status`)).json() as { entries: Array<{ status: string }> };

    // repo-a's entry advanced (preparing_head or beyond)
    assert.notStrictEqual(statusA.entries[0]!.status, "queued", "repo-a should have advanced");
    // repo-b's entry stayed queued
    assert.strictEqual(statusB.entries[0]!.status, "queued", "repo-b should not have advanced");
  });

  it("returns 404 for unknown repoId", async () => {
    const a = makeServiceAndConfig("repo-a", "org/repo-a");
    const instances = new Map([["org/repo-a", { config: a.config, service: a.service }]]);
    const app = await buildMultiRepoHttpServer({ instances, webhookSecret: undefined, logger });
    const address = await app.listen({ port: 0 });
    after(async () => { await app.close(); });

    const resp = await fetch(`${address}/repos/nonexistent/queue/status`);
    assert.strictEqual(resp.status, 404);
  });

  it("rejects webhook missing x-github-event header", async () => {
    const a = makeServiceAndConfig("repo-a", "org/repo-a");
    const instances = new Map([["org/repo-a", { config: a.config, service: a.service }]]);
    const app = await buildMultiRepoHttpServer({ instances, webhookSecret: undefined, logger });
    const address = await app.listen({ port: 0 });
    after(async () => { await app.close(); });

    const resp = await fetch(`${address}/webhooks/github`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repository: { full_name: "org/repo-a" } }),
    });
    assert.strictEqual(resp.status, 400);
  });
});
