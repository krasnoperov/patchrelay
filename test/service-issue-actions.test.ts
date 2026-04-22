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
    const updatedIssue = db.getIssue(issue.projectId, issue.linearIssueId);
    assert.equal(updatedIssue?.reviewFixAttempts, 0);
    const wake = db.issueSessions.peekIssueSessionWake(issue.projectId, issue.linearIssueId);
    assert.ok(wake);
    const events = db.issueSessions.listIssueSessionEvents(issue.projectId, issue.linearIssueId, { limit: 10 });
    const latestEvent = events.at(-1);
    assert.equal(latestEvent?.eventType, "review_changes_requested");
    assert.match(latestEvent?.eventJson ?? "", /branch upkeep/i);
  } finally {
    db?.connection.close();
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("retryIssue treats closed PR issues as fresh implementation retries", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-service-retry-closed-pr-"));
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
      linearIssueId: "issue-closed-retry",
      issueKey: "USE-2C",
      title: "Closed PR should not stay in review repair",
      factoryState: "failed",
      prNumber: 193,
      prState: "closed",
      prReviewState: "changes_requested",
      prCheckStatus: "success",
    });

    const result = service.retryIssue("USE-2C");

    assert.deepEqual(result, { issueKey: "USE-2C", runType: "implementation" });
    const wake = db.issueSessions.peekIssueSessionWake(issue.projectId, issue.linearIssueId);
    assert.ok(wake);
    assert.equal(wake.runType, "implementation");
  } finally {
    db?.connection.close();
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("closeIssue releases active runs and clears pending work", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-service-close-"));
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

    const issue = db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-close-1",
      issueKey: "USE-CLOSE-1",
      title: "Close me",
      factoryState: "implementing",
      pendingRunType: "implementation",
    });
    const run = db.runs.createRun({
      issueId: issue.id,
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      runType: "implementation",
    });
    db.runs.updateRunThread(run.id, { threadId: "thread-close-1", turnId: "turn-close-1" });
    db.upsertIssue({
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      activeRunId: run.id,
    });
    db.issueSessions.appendIssueSessionEventRespectingActiveLease(issue.projectId, issue.linearIssueId, {
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      eventType: "delegated",
      dedupeKey: "close-test-wake",
    });

    const result = await service.closeIssue("USE-CLOSE-1", { reason: "handled manually" });

    assert.deepEqual(result, { issueKey: "USE-CLOSE-1", factoryState: "done", releasedRunId: run.id });
    const updatedIssue = db.getIssue(issue.projectId, issue.linearIssueId);
    const updatedRun = db.runs.getRunById(run.id);
    const events = db.issueSessions.listIssueSessionEvents(issue.projectId, issue.linearIssueId, { limit: 10 });
    assert.equal(updatedIssue?.factoryState, "done");
    assert.equal(updatedIssue?.delegatedToPatchRelay, false);
    assert.equal(updatedIssue?.activeRunId, undefined);
    assert.equal(updatedIssue?.pendingRunType, undefined);
    assert.equal(updatedRun?.status, "released");
    assert.match(updatedRun?.failureReason ?? "", /handled manually/);
    assert.equal(events.some((event) => event.eventType === "operator_closed"), true);
    assert.equal(db.issueSessions.peekIssueSessionWake(issue.projectId, issue.linearIssueId), undefined);
  } finally {
    db?.connection.close();
    rmSync(baseDir, { recursive: true, force: true });
  }
});
