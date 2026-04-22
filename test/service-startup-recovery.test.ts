import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import test from "node:test";
import { PatchRelayDatabase } from "../src/db.ts";
import { ServiceStartupRecovery } from "../src/service-startup-recovery.ts";
import type { AppConfig, LinearClient } from "../src/types.ts";

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
      path: ":memory:",
      wal: false,
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

test("startup recovery repairs re-delegated paused local work even without an agent session", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-startup-recovery-"));
  try {
    const config = createConfig(baseDir);
    const db = new PatchRelayDatabase(config.database.path, config.database.wal);
    db.runMigrations();
    const installation = db.linearInstallations.upsertLinearInstallation({
      workspaceId: "workspace-1",
      actorId: "patchrelay-actor",
      accessTokenCiphertext: "ciphertext",
      scopesJson: "[]",
    });
    db.linearInstallations.linkProjectInstallation("usertold", installation.id);

    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-redelegated",
      issueKey: "USE-REDO",
      title: "Resume paused implementation after missed re-delegation",
      delegatedToPatchRelay: false,
      factoryState: "implementing",
    });

    const enqueued: Array<{ projectId: string; issueId: string }> = [];
    const recovery = new ServiceStartupRecovery(
      db,
      {
        forProject: async () => ({
          getIssue: async () => ({
            id: "issue-redelegated",
            identifier: "USE-REDO",
            title: "Resume paused implementation after missed re-delegation",
            description: "",
            url: "https://linear.app/usertold/issue/USE-REDO",
            teamId: "team-use",
            teamKey: "USE",
            stateId: "state-start",
            stateName: "In Progress",
            stateType: "started",
            delegateId: "patchrelay-actor",
            delegateName: "PatchRelay",
            workflowStates: [],
            labelIds: [],
            labels: [],
            teamLabels: [],
            blockedBy: [],
            blocks: [],
          }),
        } satisfies Partial<LinearClient> as LinearClient),
      } as never,
      { syncSession: async () => undefined } as never,
      (projectId, issueId) => { enqueued.push({ projectId, issueId }); },
      pino({ enabled: false }),
    );

    await recovery.recoverDelegatedIssueStateFromLinear();

    const issue = db.getIssue("usertold", "issue-redelegated");
    assert.equal(issue?.delegatedToPatchRelay, true);
    assert.equal(issue?.factoryState, "delegated");
    const wake = db.issueSessions.peekIssueSessionWake("usertold", "issue-redelegated");
    assert.equal(wake?.runType, "implementation");
    assert.deepEqual(enqueued, [{ projectId: "usertold", issueId: "issue-redelegated" }]);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("startup recovery does not resync idle paused issues just because they still have an agent session", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-startup-recovery-idle-session-"));
  try {
    const config = createConfig(baseDir);
    const db = new PatchRelayDatabase(config.database.path, config.database.wal);
    db.runMigrations();

    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-paused-session",
      issueKey: "USE-PAUSED",
      title: "Paused requested-changes issue",
      delegatedToPatchRelay: false,
      factoryState: "changes_requested",
      agentSessionId: "session-paused",
    });

    const syncCalls: Array<Record<string, unknown>> = [];
    const recovery = new ServiceStartupRecovery(
      db,
      { forProject: async () => undefined } as never,
      {
        syncSession: async (issue, options) => {
          syncCalls.push({
            issueKey: issue.issueKey,
            ...(options?.activeRunType ? { activeRunType: options.activeRunType } : {}),
          });
        },
      } as never,
      () => undefined,
      pino({ enabled: false }),
    );

    await recovery.syncKnownAgentSessions();

    assert.deepEqual(syncCalls, []);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("startup recovery still resyncs active runs with agent sessions", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-startup-recovery-active-session-"));
  try {
    const config = createConfig(baseDir);
    const db = new PatchRelayDatabase(config.database.path, config.database.wal);
    db.runMigrations();

    const issue = db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-active-session",
      issueKey: "USE-ACTIVE",
      title: "Actively running issue",
      delegatedToPatchRelay: true,
      factoryState: "implementing",
      agentSessionId: "session-active",
    });
    const run = db.runs.createRun({
      issueId: issue.id,
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      runType: "implementation",
    });
    db.upsertIssue({
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      activeRunId: run.id,
    });

    const syncCalls: Array<Record<string, unknown>> = [];
    const recovery = new ServiceStartupRecovery(
      db,
      { forProject: async () => undefined } as never,
      {
        syncSession: async (syncedIssue, options) => {
          syncCalls.push({
            issueKey: syncedIssue.issueKey,
            ...(options?.activeRunType ? { activeRunType: options.activeRunType } : {}),
          });
        },
      } as never,
      () => undefined,
      pino({ enabled: false }),
    );

    await recovery.syncKnownAgentSessions();

    assert.deepEqual(syncCalls, [{ issueKey: "USE-ACTIVE", activeRunType: "implementation" }]);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});
