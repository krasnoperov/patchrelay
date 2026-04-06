import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import test from "node:test";
import { PatchRelayDatabase } from "../src/db.ts";
import { PatchRelayService } from "../src/service.ts";
import type { AppConfig } from "../src/types.ts";

function createConfig(baseDir: string): AppConfig {
  return {
    server: {
      bind: "127.0.0.1",
      port: 8787,
      healthPath: "/health",
      readinessPath: "/ready",
    },
    ingress: {
      linearWebhookPath: "/webhooks/linear",
      githubWebhookPath: "/webhooks/github",
      maxBodyBytes: 262144,
      maxTimestampSkewSeconds: 60,
    },
    logging: {
      level: "info",
      format: "logfmt",
      filePath: path.join(baseDir, "patchrelay.log"),
    },
    database: {
      path: path.join(baseDir, "patchrelay.sqlite"),
      wal: true,
    },
    linear: {
      webhookSecret: "secret",
      graphqlUrl: "https://linear.example/graphql",
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
        bin: "node",
        args: ["app-server"],
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
        issueKeyPrefixes: ["USE"],
        linearTeamIds: ["USE"],
        allowLabels: [],
        triggerEvents: ["statusChanged"],
        branchPrefix: "use",
        github: {
          repoFullName: "owner/repo",
        },
      },
    ],
    secretSources: {},
  };
}

test("listTrackedIssues suppresses stale interrupted notes while a run is active", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-service-list-"));
  try {
    const config = createConfig(baseDir);
    const db = new PatchRelayDatabase(config.database.path, config.database.wal);
    db.runMigrations();
    const service = new PatchRelayService(
      config,
      db,
      {
        on: () => undefined,
        readThread: async () => ({ id: "thread-1", turns: [] }),
      } as never,
      undefined,
      pino({ enabled: false }),
    );

    const issue = db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-1",
      issueKey: "USE-1",
      title: "Active queue repair",
      currentLinearState: "In Review",
      factoryState: "repairing_queue",
      prNumber: 1,
      prReviewState: "approved",
      prCheckStatus: "failure",
      queueLabelApplied: true,
    });
    const run = db.createRun({
      issueId: issue.id,
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      runType: "queue_repair",
    });
    db.upsertIssue({
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      activeRunId: run.id,
      factoryState: "repairing_queue",
    });
    db.connection.prepare(`
      UPDATE issue_sessions
      SET summary_text = ?, session_state = ?, active_run_id = ?
      WHERE project_id = ? AND linear_issue_id = ?
    `).run(
      "Codex turn was interrupted",
      "running",
      run.id,
      issue.projectId,
      issue.linearIssueId,
    );

    const tracked = service.listTrackedIssues().find((entry) => entry.issueKey === "USE-1");
    assert.ok(tracked);
    assert.equal(tracked.activeRunType, "queue_repair");
    assert.equal(tracked.waitingReason, "PatchRelay is actively working");
    assert.equal(tracked.statusNote, undefined);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});
