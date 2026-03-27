import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { MemoryStore } from "../../src/memory-store.ts";
import { GitSim } from "../../src/sim/git-sim.ts";
import { CISim } from "../../src/sim/ci-sim.ts";
import { GitHubSim, EvictionReporterSim } from "../../src/sim/github-sim.ts";
import { MergeStewardService } from "../../src/service.ts";
import { buildHttpServer } from "../../src/http.ts";
import type { StewardConfig } from "../../src/config.ts";
import pino from "pino";

const WEBHOOK_SECRET = "test-secret-123";

const config: StewardConfig = {
  repoId: "test-repo",
  repoFullName: "test/repo",
  baseBranch: "main",
  clonePath: "/tmp/test-clone",
  gitBin: "git",
  maxRetries: 2,
  flakyRetries: 1,
  requiredChecks: [],
  pollIntervalMs: 60_000, // Long interval — we don't want ticks during test
  admissionLabel: "queue",
  webhookPath: "/webhooks/github/queue",
  webhookSecret: WEBHOOK_SECRET,
  server: { bind: "127.0.0.1", port: 0 },
  database: { path: ":memory:", wal: true },
  logging: { level: "silent" },
};

function sign(body: string): string {
  return "sha256=" + createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex");
}

describe("webhook admission integration", () => {
  it("enqueues on label + approved + green, updates on push, dequeues on close", async () => {
    const store = new MemoryStore();
    const githubSim = new GitHubSim();
    const evictionSim = new EvictionReporterSim();
    const logger = pino({ level: "silent" });

    // Register a PR in the sim with label + approved.
    githubSim.addPR({ number: 42, branch: "feat-x", headSha: "sha-42", reviewApproved: true, labels: ["queue"] });

    const service = new MergeStewardService(
      config, store,
      new GitSim() as any, // Git ops not used in this test
      new CISim(() => "pass") as any,
      githubSim,
      evictionSim,
      logger,
    );

    const app = await buildHttpServer(service, config, logger);
    const address = await app.listen({ port: 0 });
    after(async () => { await app.close(); });

    const baseUrl = address;

    // 1. Send pr_labeled webhook — should trigger admission.
    const labelBody = JSON.stringify({
      action: "labeled",
      label: { name: "queue" },
      pull_request: {
        number: 42,
        head: { ref: "feat-x", sha: "sha-42" },
      },
    });

    const labelResp = await fetch(`${baseUrl}/webhooks/github/queue`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "pull_request",
        "x-hub-signature-256": sign(labelBody),
      },
      body: labelBody,
    });
    assert.strictEqual(labelResp.status, 200);

    // Verify PR is queued.
    const statusResp1 = await fetch(`${baseUrl}/queue/status`);
    const status1 = await statusResp1.json() as { entries: Array<{ prNumber: number; status: string }> };
    assert.strictEqual(status1.entries.length, 1);
    assert.strictEqual(status1.entries[0]!.prNumber, 42);
    assert.strictEqual(status1.entries[0]!.status, "queued");

    // 2. Send pr_synchronize webhook — should update head SHA.
    const syncBody = JSON.stringify({
      action: "synchronize",
      pull_request: {
        number: 42,
        head: { ref: "feat-x", sha: "new-sha-42" },
      },
    });

    await fetch(`${baseUrl}/webhooks/github/queue`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "pull_request",
        "x-hub-signature-256": sign(syncBody),
      },
      body: syncBody,
    });

    const statusResp2 = await fetch(`${baseUrl}/queue/status`);
    const status2 = await statusResp2.json() as { entries: Array<{ headSha: string; generation: number }> };
    assert.strictEqual(status2.entries[0]!.headSha, "new-sha-42");
    assert.strictEqual(status2.entries[0]!.generation, 1);

    // 3. Send pr_closed webhook — should dequeue.
    const closeBody = JSON.stringify({
      action: "closed",
      pull_request: {
        number: 42,
        merged: false,
        head: { ref: "feat-x", sha: "new-sha-42" },
      },
    });

    await fetch(`${baseUrl}/webhooks/github/queue`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "pull_request",
        "x-hub-signature-256": sign(closeBody),
      },
      body: closeBody,
    });

    const statusResp3 = await fetch(`${baseUrl}/queue/status`);
    const status3 = await statusResp3.json() as { entries: Array<{ status: string }> };
    assert.strictEqual(status3.entries[0]!.status, "dequeued");
  });

  it("rejects webhook with invalid signature", async () => {
    const store = new MemoryStore();
    const logger = pino({ level: "silent" });

    const service = new MergeStewardService(
      config, store,
      new GitSim() as any,
      new CISim(() => "pass") as any,
      new GitHubSim(),
      new EvictionReporterSim(),
      logger,
    );

    const app = await buildHttpServer(service, config, logger);
    const address = await app.listen({ port: 0 });
    after(async () => { await app.close(); });

    const body = JSON.stringify({ action: "labeled" });
    const resp = await fetch(`${address}/webhooks/github/queue`, {
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

  it("does not admit PR without label on review_approved", async () => {
    const store = new MemoryStore();
    const githubSim = new GitHubSim();
    const logger = pino({ level: "silent" });

    // PR is approved but does NOT have the queue label.
    githubSim.addPR({ number: 99, branch: "feat-y", headSha: "sha-99", reviewApproved: true, labels: [] });

    const service = new MergeStewardService(
      config, store,
      new GitSim() as any,
      new CISim(() => "pass") as any,
      githubSim,
      new EvictionReporterSim(),
      logger,
    );

    const app = await buildHttpServer(service, config, logger);
    const address = await app.listen({ port: 0 });
    after(async () => { await app.close(); });

    const reviewBody = JSON.stringify({
      action: "submitted",
      review: { state: "approved" },
      pull_request: {
        number: 99,
        head: { ref: "feat-y", sha: "sha-99" },
      },
    });

    await fetch(`${address}/webhooks/github/queue`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "pull_request_review",
        "x-hub-signature-256": sign(reviewBody),
      },
      body: reviewBody,
    });

    // PR should NOT be queued — missing label.
    const statusResp = await fetch(`${address}/queue/status`);
    const status = await statusResp.json() as { entries: unknown[] };
    assert.strictEqual(status.entries.length, 0, "PR without label should not be admitted");
  });
});
