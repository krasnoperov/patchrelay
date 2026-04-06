import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import pino from "pino";
import { PatchRelayDatabase } from "../src/db.ts";
import { LinearSessionSync } from "../src/linear-session-sync.ts";
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
        id: "krasnoperov/ballony-i-nasosy",
        repoPath: path.join(baseDir, "repo"),
        worktreeRoot: path.join(baseDir, "worktrees"),
        issueKeyPrefixes: ["TST"],
        linearProjectIds: ["project-tst"],
        allowLabels: [],
        triggerEvents: ["delegateChanged", "statusChanged", "agentSessionCreated", "agentPrompted", "commentCreated", "commentUpdated"],
        branchPrefix: "tst",
        github: {
          repoFullName: "krasnoperov/ballony-i-nasosy",
        },
      },
    ],
    secretSources: {},
  };
}

test("syncSession mirrors failure state into a visible Linear status comment", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-linear-sync-"));
  try {
    const config = createConfig(baseDir);
    const db = new PatchRelayDatabase(config.database.path, config.database.wal);
    db.runMigrations();

    const issue = db.upsertIssue({
      projectId: "krasnoperov/ballony-i-nasosy",
      linearIssueId: "issue-tst-1",
      issueKey: "TST-1",
      title: "Replace the placeholder local draft model with a real game session schema",
      factoryState: "failed",
      agentSessionId: "session-1",
      currentLinearState: "In Progress",
    });
    const run = db.createRun({
      issueId: issue.id,
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      runType: "implementation",
    });
    db.finishRun(run.id, {
      status: "failed",
      failureReason: "Implementation completed without opening a PR",
    });

    const sessionUpdates: Array<Record<string, unknown>> = [];
    const commentUpdates: Array<Record<string, unknown>> = [];
    const linear: Partial<LinearClient> = {
      updateAgentSession: async (params) => {
        sessionUpdates.push(params as unknown as Record<string, unknown>);
        return { id: params.agentSessionId };
      },
      upsertIssueComment: async (params) => {
        commentUpdates.push(params as unknown as Record<string, unknown>);
        return { id: "comment-1", body: params.body };
      },
      createAgentActivity: async () => ({ id: "activity-1" }),
      getIssue: async () => { throw new Error("not used"); },
      setIssueState: async () => { throw new Error("not used"); },
      updateIssueLabels: async () => { throw new Error("not used"); },
      getActorProfile: async () => ({ actorId: "patchrelay-actor" }),
      getWorkspaceCatalog: async () => ({ workspace: {}, teams: [], projects: [] }),
    };

    const sync = new LinearSessionSync(
      config,
      db,
      { forProject: async () => linear as LinearClient },
      pino({ enabled: false }),
    );

    await sync.syncSession(db.getIssue(issue.projectId, issue.linearIssueId)!, { activeRunType: "implementation" });

    assert.equal(sessionUpdates.length, 1);
    assert.equal(commentUpdates.length, 1);
    assert.equal(commentUpdates[0]?.commentId, undefined);
    assert.match(String(commentUpdates[0]?.body), /Needs operator intervention/);
    assert.doesNotMatch(String(commentUpdates[0]?.body), /Running implementation/);
    assert.match(String(commentUpdates[0]?.body), /Latest run: implementation failed/);
    assert.match(String(commentUpdates[0]?.body), /Failure: Implementation completed without opening a PR/);
    assert.equal(db.getIssue(issue.projectId, issue.linearIssueId)?.statusCommentId, "comment-1");
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("syncSession updates the existing visible Linear status comment even without an agent session id", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-linear-sync-"));
  try {
    const config = createConfig(baseDir);
    const db = new PatchRelayDatabase(config.database.path, config.database.wal);
    db.runMigrations();

    const issue = db.upsertIssue({
      projectId: "krasnoperov/ballony-i-nasosy",
      linearIssueId: "issue-tst-3",
      issueKey: "TST-3",
      title: "Implement scoring for correct guesses",
      factoryState: "failed",
      statusCommentId: "comment-9",
    });

    const sessionUpdates: Array<Record<string, unknown>> = [];
    const commentUpdates: Array<Record<string, unknown>> = [];
    const linear: Partial<LinearClient> = {
      updateAgentSession: async (params) => {
        sessionUpdates.push(params as unknown as Record<string, unknown>);
        return { id: params.agentSessionId };
      },
      upsertIssueComment: async (params) => {
        commentUpdates.push(params as unknown as Record<string, unknown>);
        return { id: String(params.commentId ?? "comment-9"), body: params.body };
      },
      createAgentActivity: async () => ({ id: "activity-1" }),
      getIssue: async () => { throw new Error("not used"); },
      setIssueState: async () => { throw new Error("not used"); },
      updateIssueLabels: async () => { throw new Error("not used"); },
      getActorProfile: async () => ({ actorId: "patchrelay-actor" }),
      getWorkspaceCatalog: async () => ({ workspace: {}, teams: [], projects: [] }),
    };

    const sync = new LinearSessionSync(
      config,
      db,
      { forProject: async () => linear as LinearClient },
      pino({ enabled: false }),
    );

    await sync.syncSession(db.getIssue(issue.projectId, issue.linearIssueId)!);

    assert.equal(sessionUpdates.length, 0);
    assert.equal(commentUpdates.length, 1);
    assert.equal(commentUpdates[0]?.commentId, "comment-9");
    assert.match(String(commentUpdates[0]?.body), /Needs operator intervention/);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});
