import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import test from "node:test";
import { PatchRelayDatabase } from "../src/db.ts";
import { runWebhookEventRetention } from "../src/event-retention.ts";
import type { AppConfig } from "../src/types.ts";

function createConfig(baseDir: string): AppConfig {
  return {
    server: { bind: "127.0.0.1", port: 8787, healthPath: "/health", readinessPath: "/ready" },
    ingress: {
      linearWebhookPath: "/webhooks/linear",
      githubWebhookPath: "/webhooks/github",
      maxBodyBytes: 262144,
      maxTimestampSkewSeconds: 60,
    },
    logging: { level: "info", format: "logfmt", filePath: path.join(baseDir, "patchrelay.log") },
    database: {
      path: path.join(baseDir, "patchrelay.sqlite"),
      wal: false,
      eventRetentionDays: 7,
      archiveOldEvents: false,
      archivePath: path.join(baseDir, "archive"),
    },
    linear: {
      webhookSecret: "secret",
      graphqlUrl: "https://linear.example/graphql",
      oauth: {
        clientId: "client-id",
        clientSecret: "client-secret",
        redirectUri: "http://127.0.0.1:8787/oauth/linear/callback",
        scopes: ["read", "write"],
        actor: "app",
      },
      tokenEncryptionKey: "0123456789abcdef0123456789abcdef",
    },
    operatorApi: { enabled: false },
    runner: {
      gitBin: "git",
      codex: {
        bin: "codex",
        args: ["app-server"],
        approvalPolicy: "never",
        sandboxMode: "danger-full-access",
      },
    },
    repos: { root: path.join(baseDir, "repos") },
    repositories: [],
    projects: [],
    secretSources: {},
  };
}

test("webhook event retention dry-run counts old processed events without deleting", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-retention-dry-run-"));
  try {
    const config = createConfig(baseDir);
    const db = new PatchRelayDatabase(config.database.path, config.database.wal);
    db.runMigrations();
    const old = "2026-01-01T00:00:00.000Z";
    const stored = db.webhookEvents.insertFullWebhookEvent({ webhookId: "old-1", receivedAt: old, payloadJson: "{\"ok\":true}" });
    db.webhookEvents.markWebhookProcessed(stored.id, "processed");

    const result = await runWebhookEventRetention({
      db,
      config,
      options: { now: new Date("2026-01-10T00:00:00.000Z"), dryRun: true },
    });

    assert.equal(result.scanned, 1);
    assert.equal(result.deleted, 0);
    assert.equal(db.webhookEvents.countArchiveableEventsBefore(result.cutoffIso), 1);
    db.close();
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("webhook event retention archives processed events and preserves pending events", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-retention-archive-"));
  try {
    const config = createConfig(baseDir);
    const db = new PatchRelayDatabase(config.database.path, config.database.wal);
    db.runMigrations();
    const old = "2026-01-01T00:00:00.000Z";
    const processed = db.webhookEvents.insertFullWebhookEvent({ webhookId: "old-processed", receivedAt: old, payloadJson: "{\"processed\":true}" });
    db.webhookEvents.markWebhookProcessed(processed.id, "processed");
    db.webhookEvents.insertFullWebhookEvent({ webhookId: "old-pending", receivedAt: old, payloadJson: "{\"pending\":true}" });

    const result = await runWebhookEventRetention({
      db,
      config,
      options: {
        now: new Date("2026-01-10T00:00:00.000Z"),
        archiveOldEvents: true,
        batchSize: 1,
      },
    });

    assert.equal(result.scanned, 1);
    assert.equal(result.archived, 1);
    assert.equal(result.deleted, 1);
    assert.equal(result.remaining, 0);
    assert.ok(result.archiveFile);
    const archiveLines = gunzipSync(readFileSync(result.archiveFile)).toString("utf8").trim().split("\n");
    assert.equal(archiveLines.length, 1);
    assert.equal(JSON.parse(archiveLines[0]!).webhookId, "old-processed");
    assert.equal(db.webhookEvents.isWebhookDuplicate("old-processed"), false);
    assert.equal(db.webhookEvents.isWebhookDuplicate("old-pending"), true);
    db.close();
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});
