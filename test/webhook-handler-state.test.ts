import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import test from "node:test";
import { PatchRelayDatabase } from "../src/db.ts";
import { WebhookHandler } from "../src/webhook-handler.ts";
import type { AppConfig, LinearWebhookPayload, LinearIssueSnapshot, LinearClient } from "../src/types.ts";

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
        id: "krasnoperov/mafia",
        repoPath: path.join(baseDir, "repo"),
        worktreeRoot: path.join(baseDir, "worktrees"),
        issueKeyPrefixes: ["MAF"],
        linearTeamIds: ["team-maf"],
        allowLabels: [],
        triggerEvents: ["issueCreated", "statusChanged", "assignmentChanged", "delegateChanged"],
        branchPrefix: "maf",
        github: {
          repoFullName: "krasnoperov/mafia",
        },
      },
    ],
    secretSources: {},
  };
}

test("non-delegated backlog issue webhooks do not create tracked issues", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-webhook-state-"));
  try {
    const config = createConfig(baseDir);
    const db = new PatchRelayDatabase(config.database.path, config.database.wal);
    db.runMigrations();

    const handler = new WebhookHandler(
      config,
      db,
      { forProject: async () => undefined } as never,
      { steerTurn: async () => undefined } as never,
      () => undefined,
      pino({ enabled: false }),
    );

    const payload: LinearWebhookPayload = {
      action: "create",
      type: "Issue",
      createdAt: "2026-04-01T00:00:00.000Z",
      webhookTimestamp: Date.now(),
      data: {
        id: "issue-maf-35",
        identifier: "MAF-35",
        title: "Game archive — snapshot completed games to localStorage",
        team: { id: "team-maf", key: "MAF" },
        state: { id: "state-backlog", name: "Backlog", type: "unstarted" },
      },
    };

    const stored = db.insertFullWebhookEvent({
      webhookId: "delivery-maf-35",
      receivedAt: new Date().toISOString(),
      payloadJson: JSON.stringify(payload),
    });

    await handler.processWebhookEvent(stored.id);

    assert.equal(db.getIssue("krasnoperov/mafia", "issue-maf-35"), undefined);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("delegated blocked issue is tracked but does not queue implementation until blocker is done", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-webhook-blockers-"));
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
    db.linearInstallations.linkProjectInstallation("krasnoperov/mafia", installation.id);

    const issueSnapshots = new Map<string, LinearIssueSnapshot>([
      ["issue-maf-40", {
        id: "issue-maf-40",
        identifier: "MAF-40",
        title: "Active session sync",
        teamId: "team-maf",
        teamKey: "MAF",
        delegateId: "patchrelay-actor",
        stateId: "state-start",
        stateName: "Start",
        workflowStates: [],
        labelIds: [],
        labels: [],
        teamLabels: [],
        blockedBy: [{ id: "issue-maf-39", identifier: "MAF-39", title: "API contracts", stateName: "Start" }],
        blocks: [],
      }],
      ["issue-maf-39", {
        id: "issue-maf-39",
        identifier: "MAF-39",
        title: "API contracts",
        teamId: "team-maf",
        teamKey: "MAF",
        stateId: "state-start",
        stateName: "Start",
        workflowStates: [],
        labelIds: [],
        labels: [],
        teamLabels: [],
        blockedBy: [],
        blocks: [{ id: "issue-maf-40", identifier: "MAF-40", title: "Active session sync", stateName: "Start" }],
      }],
    ]);

    const linearClient: Partial<LinearClient> = {
      getIssue: async (issueId: string) => {
        const snapshot = issueSnapshots.get(issueId);
        if (!snapshot) throw new Error(`missing issue ${issueId}`);
        return snapshot;
      },
    };

    const enqueued: Array<{ projectId: string; issueId: string }> = [];
    const handler = new WebhookHandler(
      config,
      db,
      { forProject: async () => linearClient as LinearClient } as never,
      { steerTurn: async () => undefined } as never,
      (projectId, issueId) => { enqueued.push({ projectId, issueId }); },
      pino({ enabled: false }),
    );

    const delegatedPayload: LinearWebhookPayload = {
      action: "update",
      type: "Issue",
      createdAt: "2026-04-01T00:00:00.000Z",
      webhookTimestamp: Date.now(),
      updatedFrom: { delegateId: null },
      data: {
        id: "issue-maf-40",
        identifier: "MAF-40",
        title: "Active session sync",
        team: { id: "team-maf", key: "MAF" },
        state: { id: "state-start", name: "Start", type: "started" },
        delegate: { id: "patchrelay-actor", name: "PatchRelay" },
      },
    };

    const delegatedEvent = db.insertFullWebhookEvent({
      webhookId: "delivery-maf-40",
      receivedAt: new Date().toISOString(),
      payloadJson: JSON.stringify(delegatedPayload),
    });
    await handler.processWebhookEvent(delegatedEvent.id);

    const blockedIssue = db.getIssue("krasnoperov/mafia", "issue-maf-40");
    assert.ok(blockedIssue);
    assert.equal(blockedIssue?.pendingRunType, undefined);
    assert.equal(db.countUnresolvedBlockers("krasnoperov/mafia", "issue-maf-40"), 1);
    assert.deepEqual(db.listIssuesReadyForExecution(), []);
    assert.deepEqual(enqueued, []);

    db.upsertIssue({
      projectId: "krasnoperov/mafia",
      linearIssueId: "issue-maf-39",
      issueKey: "MAF-39",
      title: "API contracts",
      currentLinearState: "Done",
      factoryState: "done",
    });
    issueSnapshots.set("issue-maf-39", {
      ...(issueSnapshots.get("issue-maf-39")!),
      stateName: "Done",
      blocks: [{ id: "issue-maf-40", identifier: "MAF-40", title: "Active session sync", stateName: "Start" }],
    });

    const blockerDonePayload: LinearWebhookPayload = {
      action: "update",
      type: "Issue",
      createdAt: "2026-04-01T00:01:00.000Z",
      webhookTimestamp: Date.now(),
      updatedFrom: { stateId: "state-start" },
      data: {
        id: "issue-maf-39",
        identifier: "MAF-39",
        title: "API contracts",
        team: { id: "team-maf", key: "MAF" },
        state: { id: "state-done", name: "Done", type: "completed" },
      },
    };

    const blockerDoneEvent = db.insertFullWebhookEvent({
      webhookId: "delivery-maf-39-done",
      receivedAt: new Date().toISOString(),
      payloadJson: JSON.stringify(blockerDonePayload),
    });
    await handler.processWebhookEvent(blockerDoneEvent.id);

    const unblockedIssue = db.getIssue("krasnoperov/mafia", "issue-maf-40");
    assert.equal(unblockedIssue?.pendingRunType, "implementation");
    assert.deepEqual(db.listIssuesReadyForExecution(), [{ projectId: "krasnoperov/mafia", linearIssueId: "issue-maf-40" }]);
    assert.deepEqual(enqueued, [{ projectId: "krasnoperov/mafia", issueId: "issue-maf-40" }]);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});
