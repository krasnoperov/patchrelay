import assert from "node:assert/strict";
import crypto from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import pino from "pino";
import { PatchRelayDatabase } from "../src/db.js";
import { acceptIncomingWebhook } from "../src/service-webhooks.js";
import type { AppConfig, LinearWebhookPayload } from "../src/types.js";

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
        workflowFiles: {
          development: path.join(baseDir, "IMPLEMENTATION_WORKFLOW.md"),
          review: path.join(baseDir, "REVIEW_WORKFLOW.md"),
          deploy: path.join(baseDir, "DEPLOY_WORKFLOW.md"),
          cleanup: path.join(baseDir, "CLEANUP_WORKFLOW.md"),
        },
        workflowStatuses: {
          development: "Start",
          review: "Review",
          deploy: "Deploy",
          developmentActive: "Implementing",
          reviewActive: "Reviewing",
          deployActive: "Deploying",
        },
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
      db,
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
      db,
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
