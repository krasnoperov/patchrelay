import assert from "node:assert/strict";
import crypto from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import pino from "pino";
import { PatchRelayDatabase } from "../src/db.ts";
import { acceptIncomingWebhook } from "../src/service-webhooks.ts";
import type { AppConfig, LinearWebhookPayload } from "../src/types.ts";

function createWorkflows(baseDir: string) {
  return [
    {
      id: "development",
      whenState: "Start",
      activeState: "Implementing",
      workflowFile: path.join(baseDir, "IMPLEMENTATION_WORKFLOW.md"),
      fallbackState: "Human Needed",
    },
    {
      id: "review",
      whenState: "Review",
      activeState: "Reviewing",
      workflowFile: path.join(baseDir, "REVIEW_WORKFLOW.md"),
      fallbackState: "Human Needed",
    },
    {
      id: "deploy",
      whenState: "Deploy",
      activeState: "Deploying",
      workflowFile: path.join(baseDir, "DEPLOY_WORKFLOW.md"),
      fallbackState: "Human Needed",
    },
    {
      id: "cleanup",
      whenState: "Cleanup",
      activeState: "Cleaning Up",
      workflowFile: path.join(baseDir, "CLEANUP_WORKFLOW.md"),
      fallbackState: "Human Needed",
    },
  ];
}

function buildConfig(baseDir: string): AppConfig {
  return {
    server: {
      bind: "127.0.0.1",
      port: 8787,
      healthPath: "/health",
      readinessPath: "/ready",
    },
    ingress: {
      linearWebhookPath: "/webhooks/linear",
      maxBodyBytes: 262144,
      maxTimestampSkewSeconds: 60,
    },
    logging: {
      level: "info",
      format: "logfmt",
      filePath: path.join(baseDir, "patchrelay.log"),
      webhookArchiveDir: path.join(baseDir, "webhook-archive"),
    },
    database: {
      path: path.join(baseDir, "patchrelay.sqlite"),
      wal: true,
    },
    linear: {
      webhookSecret: "webhook-secret",
      graphqlUrl: "https://api.linear.app/graphql",
      oauth: {
        clientId: "client-id",
        clientSecret: "client-secret",
        redirectUri: "http://127.0.0.1:8787/oauth/linear/callback",
        scopes: ["read", "write"],
        actor: "user",
      },
      tokenEncryptionKey: "test-encryption-key",
    },
    operatorApi: {
      enabled: false,
    },
    runner: {
      gitBin: "git",
      codex: {
        bin: "codex",
        args: ["app-server"],
        sourceBashrc: false,
        serviceName: "patchrelay",
        approvalPolicy: "never",
        sandboxMode: "danger-full-access",
        persistExtendedHistory: false,
      },
    },
    projects: [
      {
        id: "usertold",
        repoPath: path.join(baseDir, "repo"),
        worktreeRoot: path.join(baseDir, "worktrees"),
        workflows: createWorkflows(baseDir),
        issueKeyPrefixes: ["USE"],
        linearTeamIds: ["USE"],
        allowLabels: [],
        triggerEvents: ["statusChanged"],
        branchPrefix: "use",
      },
    ],
  };
}

function buildPayload(timestamp = Date.now()): LinearWebhookPayload {
  return {
    action: "update",
    type: "Issue",
    createdAt: new Date(timestamp).toISOString(),
    webhookTimestamp: timestamp,
    data: {
      id: "issue-1",
      identifier: "USE-1",
      title: "Security test",
      state: {
        id: "state-1",
        name: "Start",
      },
      team: {
        id: "team-1",
        key: "USE",
      },
      labels: [],
    },
    updatedFrom: {
      stateId: "state-0",
    },
  };
}

function archivedFileCount(archiveDir: string): number {
  if (!existsSync(archiveDir)) {
    return 0;
  }

  return readdirSync(archiveDir, { recursive: true }).length;
}

function storedWebhookCount(db: PatchRelayDatabase): number {
  const row = db.connection.prepare("SELECT COUNT(*) AS count FROM webhook_events").get() as { count: number };
  return row.count;
}

function storedEventReceiptCount(db: PatchRelayDatabase): number {
  const row = db.connection.prepare("SELECT COUNT(*) AS count FROM event_receipts").get() as { count: number };
  return row.count;
}

test("acceptIncomingWebhook does not persist or archive invalid signatures", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-webhook-security-"));

  try {
    const config = buildConfig(baseDir);
    const db = new PatchRelayDatabase(config.database.path, config.database.wal);
    db.runMigrations();

    const payload = buildPayload();
    const rawBody = Buffer.from(JSON.stringify(payload), "utf8");
    const result = await acceptIncomingWebhook({
      config,
      stores: db,
      logger: pino({ enabled: false }),
      webhookId: "delivery-invalid",
      headers: {
        "linear-signature": "0".repeat(64),
      },
      rawBody,
    });

    assert.equal(result.status, 401);
    assert.equal(storedWebhookCount(db), 0);
    assert.equal(archivedFileCount(config.logging.webhookArchiveDir!), 0);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("acceptIncomingWebhook does not persist or archive stale payloads", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-webhook-stale-"));

  try {
    const config = buildConfig(baseDir);
    const db = new PatchRelayDatabase(config.database.path, config.database.wal);
    db.runMigrations();

    const staleTimestamp = Date.now() - 10 * 60 * 1000;
    const payload = buildPayload(staleTimestamp);
    const rawBody = Buffer.from(JSON.stringify(payload), "utf8");
    const signature = crypto.createHmac("sha256", config.linear.webhookSecret).update(rawBody).digest("hex");
    const result = await acceptIncomingWebhook({
      config,
      stores: db,
      logger: pino({ enabled: false }),
      webhookId: "delivery-stale",
      headers: {
        "linear-signature": signature,
      },
      rawBody,
    });

    assert.equal(result.status, 401);
    assert.equal(storedWebhookCount(db), 0);
    assert.equal(archivedFileCount(config.logging.webhookArchiveDir!), 0);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("acceptIncomingWebhook dual-writes authoritative event receipts for accepted deliveries", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-webhook-accepted-"));

  try {
    const config = buildConfig(baseDir);
    const db = new PatchRelayDatabase(config.database.path, config.database.wal);
    db.runMigrations();

    const payload = buildPayload();
    const rawBody = Buffer.from(JSON.stringify(payload), "utf8");
    const signature = crypto.createHmac("sha256", config.linear.webhookSecret).update(rawBody).digest("hex");
    const result = await acceptIncomingWebhook({
      config,
      stores: db,
      logger: pino({ enabled: false }),
      webhookId: "delivery-accepted",
      headers: {
        "linear-signature": signature,
      },
      rawBody,
    });

    assert.equal(result.status, 200);
    assert.equal(storedWebhookCount(db), 1);
    assert.equal(storedEventReceiptCount(db), 1);
    const receipt = db.eventReceipts.getEventReceiptBySourceExternalId("linear-webhook", "delivery-accepted");
    assert.equal(receipt?.eventType, "Issue.update");
    assert.equal(receipt?.linearIssueId, "issue-1");
    assert.equal(receipt?.processingStatus, "pending");
    assert.ok(archivedFileCount(config.logging.webhookArchiveDir!) > 0);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});
