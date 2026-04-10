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

test("promptIssue queues operator input for the next run when no run is active", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-service-actions-"));
  let db: PatchRelayDatabase | undefined;
  try {
    const config = createConfig(baseDir);
    db = new PatchRelayDatabase(config.database.path, config.database.wal);
    db.runMigrations();
    const service = new PatchRelayService(
      config,
      db,
      { on: () => undefined, steerTurn: async () => undefined } as never,
      undefined,
      pino({ enabled: false }),
    );

    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-1",
      issueKey: "USE-1",
      factoryState: "delegated",
      title: "Queued prompt",
    });

    const result = await service.promptIssue("USE-1", "Please retry carefully", "test");

    assert.deepEqual(result, { delivered: false, queued: true });
    const latestEvent = db.issueSessions.listIssueSessionEvents("usertold", "issue-1", { limit: 1 }).at(-1);
    assert.equal(latestEvent?.eventType, "operator_prompt");
    assert.match(latestEvent?.eventJson ?? "", /Please retry carefully/);
  } finally {
    db?.connection.close();
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("retryIssue preserves branch upkeep retries for requested-changes issues", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-service-retry-"));
  let db: PatchRelayDatabase | undefined;
  try {
    const config = createConfig(baseDir);
    db = new PatchRelayDatabase(config.database.path, config.database.wal);
    db.runMigrations();
    const service = new PatchRelayService(
      config,
      db,
      { on: () => undefined } as never,
      undefined,
      pino({ enabled: false }),
    );

    const issue = db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-2",
      issueKey: "USE-2",
      title: "Requested changes upkeep",
      factoryState: "changes_requested",
      prNumber: 42,
      prReviewState: "changes_requested",
      pendingRunType: "branch_upkeep",
      prHeadSha: "abc123",
    });
    db.connection.prepare(`
      UPDATE issue_sessions
      SET session_state = ?, last_run_type = ?
      WHERE project_id = ? AND linear_issue_id = ?
    `).run("failed", "branch_upkeep", issue.projectId, issue.linearIssueId);

    const result = service.retryIssue("USE-2");

    assert.deepEqual(result, { issueKey: "USE-2", runType: "branch_upkeep" });
    const wake = db.issueSessions.peekIssueSessionWake(issue.projectId, issue.linearIssueId);
    assert.ok(wake);
    const latestEvent = db.issueSessions.listIssueSessionEvents(issue.projectId, issue.linearIssueId, { limit: 1 }).at(-1);
    assert.equal(latestEvent?.eventType, "review_changes_requested");
    assert.match(latestEvent?.eventJson ?? "", /branch upkeep/i);
  } finally {
    db?.connection.close();
    rmSync(baseDir, { recursive: true, force: true });
  }
});
