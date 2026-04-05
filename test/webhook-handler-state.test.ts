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
        stateType: "started",
        workflowStates: [],
        labelIds: [],
        labels: [],
        teamLabels: [],
        blockedBy: [{ id: "issue-maf-39", identifier: "MAF-39", title: "API contracts", stateName: "In Progress", stateType: "started" }],
        blocks: [],
      }],
      ["issue-maf-39", {
        id: "issue-maf-39",
        identifier: "MAF-39",
        title: "API contracts",
        teamId: "team-maf",
        teamKey: "MAF",
        stateId: "state-start",
        stateName: "In Progress",
        stateType: "started",
        workflowStates: [],
        labelIds: [],
        labels: [],
        teamLabels: [],
        blockedBy: [],
        blocks: [{ id: "issue-maf-40", identifier: "MAF-40", title: "Active session sync", stateName: "Start", stateType: "started" }],
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
      currentLinearState: "Completed",
      currentLinearStateType: "completed",
      factoryState: "done",
    });
    issueSnapshots.set("issue-maf-39", {
      ...(issueSnapshots.get("issue-maf-39")!),
      stateName: "Completed",
      stateType: "completed",
      blocks: [{ id: "issue-maf-40", identifier: "MAF-40", title: "Active session sync", stateName: "Start", stateType: "started" }],
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

test("delegated issue is tracked via repository-link installation fallback", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-webhook-installation-fallback-"));
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
    db.repositories.upsertRepositoryLink({
      githubRepo: "krasnoperov/mafia",
      localPath: path.join(baseDir, "repo"),
      installationId: installation.id,
      linearTeamIds: ["team-maf"],
      issueKeyPrefixes: ["MAF"],
    });

    const handler = new WebhookHandler(
      config,
      db,
      { forProject: async () => undefined } as never,
      { steerTurn: async () => undefined } as never,
      () => undefined,
      pino({ enabled: false }),
    );

    const payload: LinearWebhookPayload = {
      action: "update",
      type: "Issue",
      createdAt: "2026-04-01T00:00:00.000Z",
      webhookTimestamp: Date.now(),
      updatedFrom: { delegateId: null },
      data: {
        id: "issue-maf-38",
        identifier: "MAF-38",
        title: "DB types + DAOs",
        team: { id: "team-maf", key: "MAF" },
        state: { id: "state-backlog", name: "Backlog", type: "backlog" },
        delegate: { id: "patchrelay-actor", name: "PatchRelay" },
      },
    };

    const stored = db.insertFullWebhookEvent({
      webhookId: "delivery-maf-38-fallback",
      receivedAt: new Date().toISOString(),
      payloadJson: JSON.stringify(payload),
    });

    await handler.processWebhookEvent(stored.id);

    const issue = db.getIssue("krasnoperov/mafia", "issue-maf-38");
    assert.ok(issue);
    assert.equal(issue?.issueKey, "MAF-38");
    assert.equal(issue?.factoryState, "delegated");
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("delegated issue is tracked via single-installation fallback", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-webhook-single-installation-fallback-"));
  try {
    const config = createConfig(baseDir);
    const db = new PatchRelayDatabase(config.database.path, config.database.wal);
    db.runMigrations();
    db.linearInstallations.upsertLinearInstallation({
      workspaceId: "workspace-1",
      actorId: "patchrelay-actor",
      accessTokenCiphertext: "ciphertext",
      scopesJson: "[]",
    });

    const handler = new WebhookHandler(
      config,
      db,
      { forProject: async () => undefined } as never,
      { steerTurn: async () => undefined } as never,
      () => undefined,
      pino({ enabled: false }),
    );

    const payload: LinearWebhookPayload = {
      action: "update",
      type: "Issue",
      createdAt: "2026-04-01T00:00:00.000Z",
      webhookTimestamp: Date.now(),
      updatedFrom: { delegateId: null },
      data: {
        id: "issue-maf-39",
        identifier: "MAF-39",
        title: "API contracts",
        team: { id: "team-maf", key: "MAF" },
        state: { id: "state-backlog", name: "Backlog", type: "backlog" },
        delegate: { id: "patchrelay-actor", name: "PatchRelay" },
      },
    };

    const stored = db.insertFullWebhookEvent({
      webhookId: "delivery-maf-39-single-installation-fallback",
      receivedAt: new Date().toISOString(),
      payloadJson: JSON.stringify(payload),
    });

    await handler.processWebhookEvent(stored.id);

    const issue = db.getIssue("krasnoperov/mafia", "issue-maf-39");
    assert.ok(issue);
    assert.equal(issue?.issueKey, "MAF-39");
    assert.equal(issue?.factoryState, "delegated");
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("incomplete webhook relations do not clear existing blockers when live hydration fails", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-webhook-blocker-preserve-"));
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

    db.replaceIssueDependencies({
      projectId: "krasnoperov/mafia",
      linearIssueId: "issue-maf-40",
      blockers: [{
        blockerLinearIssueId: "issue-maf-39",
        blockerIssueKey: "MAF-39",
        blockerTitle: "API contracts",
        blockerCurrentLinearState: "In Progress",
        blockerCurrentLinearStateType: "started",
      }],
    });

    const handler = new WebhookHandler(
      config,
      db,
      { forProject: async () => ({ getIssue: async () => { throw new Error("linear unavailable"); } } as LinearClient) } as never,
      { steerTurn: async () => undefined } as never,
      () => undefined,
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
      webhookId: "delivery-maf-40-preserve",
      receivedAt: new Date().toISOString(),
      payloadJson: JSON.stringify(delegatedPayload),
    });
    await handler.processWebhookEvent(delegatedEvent.id);

    assert.equal(db.countUnresolvedBlockers("krasnoperov/mafia", "issue-maf-40"), 1);
    assert.deepEqual(
      db.listIssueDependencies("krasnoperov/mafia", "issue-maf-40").map((entry) => entry.blockerIssueKey),
      ["MAF-39"],
    );
    assert.equal(db.getIssue("krasnoperov/mafia", "issue-maf-40")?.pendingRunType, undefined);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("done delegated issue does not requeue implementation after merged status echoes back from Linear", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-webhook-done-echo-"));
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

    db.upsertIssue({
      projectId: "krasnoperov/mafia",
      linearIssueId: "issue-maf-38",
      issueKey: "MAF-38",
      title: "DB types + DAOs",
      currentLinearState: "Done",
      currentLinearStateType: "completed",
      factoryState: "done",
      prNumber: 105,
      prState: "merged",
    });

    const enqueued: Array<{ projectId: string; issueId: string }> = [];
    const handler = new WebhookHandler(
      config,
      db,
      { forProject: async () => undefined } as never,
      { steerTurn: async () => undefined } as never,
      (projectId, issueId) => { enqueued.push({ projectId, issueId }); },
      pino({ enabled: false }),
    );

    const payload: LinearWebhookPayload = {
      action: "update",
      type: "Issue",
      createdAt: "2026-04-01T00:00:00.000Z",
      webhookTimestamp: Date.now(),
      updatedFrom: { stateId: "state-start" },
      data: {
        id: "issue-maf-38",
        identifier: "MAF-38",
        title: "DB types + DAOs",
        team: { id: "team-maf", key: "MAF" },
        state: { id: "state-done", name: "Done", type: "completed" },
        delegate: { id: "patchrelay-actor", name: "PatchRelay" },
      },
    };

    const stored = db.insertFullWebhookEvent({
      webhookId: "delivery-maf-38-done-echo",
      receivedAt: new Date().toISOString(),
      payloadJson: JSON.stringify(payload),
    });

    await handler.processWebhookEvent(stored.id);

    const issue = db.getIssue("krasnoperov/mafia", "issue-maf-38");
    assert.equal(issue?.factoryState, "done");
    assert.equal(issue?.pendingRunType, undefined);
    assert.deepEqual(enqueued, []);
    assert.deepEqual(db.listIssuesReadyForExecution(), []);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("un-delegation during active run releases run and transitions to awaiting_input", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-webhook-undelegate-"));
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

    const issueRecord = db.upsertIssue({
      projectId: "krasnoperov/mafia",
      linearIssueId: "issue-maf-50",
      issueKey: "MAF-50",
      title: "Implement feature X",
      factoryState: "implementing",
    });
    const run = db.createRun({
      issueId: issueRecord.id,
      projectId: "krasnoperov/mafia",
      linearIssueId: "issue-maf-50",
      runType: "implementation",
    });
    db.upsertIssue({
      projectId: "krasnoperov/mafia",
      linearIssueId: "issue-maf-50",
      activeRunId: run.id,
    });

    const handler = new WebhookHandler(
      config,
      db,
      { forProject: async () => undefined } as never,
      { steerTurn: async () => undefined } as never,
      () => undefined,
      pino({ enabled: false }),
    );

    const payload: LinearWebhookPayload = {
      action: "update",
      type: "Issue",
      createdAt: "2026-04-01T00:00:00.000Z",
      webhookTimestamp: Date.now(),
      updatedFrom: { delegateId: "patchrelay-actor" },
      data: {
        id: "issue-maf-50",
        identifier: "MAF-50",
        title: "Implement feature X",
        team: { id: "team-maf", key: "MAF" },
        state: { id: "state-start", name: "In Progress", type: "started" },
        delegate: null,
      },
    };

    const stored = db.insertFullWebhookEvent({
      webhookId: "delivery-undelegate-50",
      receivedAt: new Date().toISOString(),
      payloadJson: JSON.stringify(payload),
    });

    await handler.processWebhookEvent(stored.id);

    const issue = db.getIssue("krasnoperov/mafia", "issue-maf-50");
    assert.equal(issue?.factoryState, "awaiting_input");
    assert.equal(issue?.activeRunId, undefined);
    assert.equal(issue?.pendingRunType, undefined);

    const finishedRun = db.getRun(run.id);
    assert.equal(finishedRun?.status, "released");
    assert.ok(finishedRun?.failureReason?.includes("Un-delegated"));
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("un-delegation of awaiting_queue issue does not change state (point of no return)", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-webhook-noreturn-"));
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

    db.upsertIssue({
      projectId: "krasnoperov/mafia",
      linearIssueId: "issue-maf-51",
      issueKey: "MAF-51",
      title: "Approved feature",
      factoryState: "awaiting_queue",
      prNumber: 120,
      prState: "open",
    });

    const handler = new WebhookHandler(
      config,
      db,
      { forProject: async () => undefined } as never,
      { steerTurn: async () => undefined } as never,
      () => undefined,
      pino({ enabled: false }),
    );

    const payload: LinearWebhookPayload = {
      action: "update",
      type: "Issue",
      createdAt: "2026-04-01T00:00:00.000Z",
      webhookTimestamp: Date.now(),
      updatedFrom: { delegateId: "patchrelay-actor" },
      data: {
        id: "issue-maf-51",
        identifier: "MAF-51",
        title: "Approved feature",
        team: { id: "team-maf", key: "MAF" },
        state: { id: "state-start", name: "In Progress", type: "started" },
        delegate: null,
      },
    };

    const stored = db.insertFullWebhookEvent({
      webhookId: "delivery-undelegate-51",
      receivedAt: new Date().toISOString(),
      payloadJson: JSON.stringify(payload),
    });

    await handler.processWebhookEvent(stored.id);

    const issue = db.getIssue("krasnoperov/mafia", "issue-maf-51");
    assert.equal(issue?.factoryState, "awaiting_queue");
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("issueRemoved releases active run and transitions to failed", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-webhook-removed-"));
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

    const issueRecord = db.upsertIssue({
      projectId: "krasnoperov/mafia",
      linearIssueId: "issue-maf-52",
      issueKey: "MAF-52",
      title: "Soon to be removed",
      factoryState: "implementing",
    });
    const run = db.createRun({
      issueId: issueRecord.id,
      projectId: "krasnoperov/mafia",
      linearIssueId: "issue-maf-52",
      runType: "implementation",
    });
    db.upsertIssue({
      projectId: "krasnoperov/mafia",
      linearIssueId: "issue-maf-52",
      activeRunId: run.id,
    });

    const handler = new WebhookHandler(
      config,
      db,
      { forProject: async () => undefined } as never,
      { steerTurn: async () => undefined } as never,
      () => undefined,
      pino({ enabled: false }),
    );

    const payload: LinearWebhookPayload = {
      action: "remove",
      type: "Issue",
      createdAt: "2026-04-01T00:00:00.000Z",
      webhookTimestamp: Date.now(),
      data: {
        id: "issue-maf-52",
        identifier: "MAF-52",
        title: "Soon to be removed",
        team: { id: "team-maf", key: "MAF" },
        state: { id: "state-start", name: "In Progress", type: "started" },
      },
    };

    const stored = db.insertFullWebhookEvent({
      webhookId: "delivery-remove-52",
      receivedAt: new Date().toISOString(),
      payloadJson: JSON.stringify(payload),
    });

    await handler.processWebhookEvent(stored.id);

    const issue = db.getIssue("krasnoperov/mafia", "issue-maf-52");
    assert.equal(issue?.factoryState, "failed");
    assert.equal(issue?.activeRunId, undefined);

    const finishedRun = db.getRun(run.id);
    assert.equal(finishedRun?.status, "released");
    assert.ok(finishedRun?.failureReason?.includes("removed"));
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("idle delegated comments queue a follow-up session event instead of rewriting pending context", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-webhook-comment-followup-"));
  try {
    const config = createConfig(baseDir);
    config.projects[0] = {
      ...config.projects[0]!,
      triggerEvents: [...config.projects[0]!.triggerEvents, "commentCreated", "commentUpdated"],
    };
    const db = new PatchRelayDatabase(config.database.path, config.database.wal);
    db.runMigrations();
    const installation = db.linearInstallations.upsertLinearInstallation({
      workspaceId: "workspace-1",
      actorId: "patchrelay-actor",
      accessTokenCiphertext: "ciphertext",
      scopesJson: "[]",
    });
    db.linearInstallations.linkProjectInstallation("krasnoperov/mafia", installation.id);
    db.upsertIssue({
      projectId: "krasnoperov/mafia",
      linearIssueId: "issue-maf-comment",
      issueKey: "MAF-91",
      title: "Commentable issue",
      currentLinearState: "Review",
      currentLinearStateType: "started",
      factoryState: "pr_open",
      prNumber: 91,
    });

    const enqueued: Array<{ projectId: string; issueId: string }> = [];
    const handler = new WebhookHandler(
      config,
      db,
      { forProject: async () => undefined } as never,
      { steerTurn: async () => undefined } as never,
      (projectId, issueId) => { enqueued.push({ projectId, issueId }); },
      pino({ enabled: false }),
    );

    const payload: LinearWebhookPayload = {
      action: "create",
      type: "Comment",
      createdAt: "2026-04-01T02:00:00.000Z",
      webhookTimestamp: Date.now(),
      actor: {
        id: "user-1",
        name: "Alex Operator",
        email: "alex@example.com",
        type: "User",
      } as unknown as Record<string, unknown>,
      data: {
        id: "comment-1",
        body: "Please keep this compatible with the old contract.",
        user: { name: "Alex Operator" },
        issue: {
          id: "issue-maf-comment",
          identifier: "MAF-91",
          title: "Commentable issue",
          team: { id: "team-maf", key: "MAF" },
          state: { id: "state-review", name: "Review", type: "started" },
          delegate: { id: "patchrelay-actor", name: "PatchRelay" },
        },
      },
    };

    const stored = db.insertFullWebhookEvent({
      webhookId: "delivery-comment-followup",
      receivedAt: new Date().toISOString(),
      payloadJson: JSON.stringify(payload),
    });
    await handler.processWebhookEvent(stored.id);

    const issue = db.getIssue("krasnoperov/mafia", "issue-maf-comment");
    const wake = db.peekIssueSessionWake("krasnoperov/mafia", "issue-maf-comment");
    assert.equal(issue?.pendingRunContextJson, undefined);
    assert.equal(wake?.runType, "implementation");
    assert.equal(Array.isArray(wake?.context.followUps), true);
    assert.deepEqual(enqueued, [{ projectId: "krasnoperov/mafia", issueId: "issue-maf-comment" }]);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("agent session id survives follow-up webhooks that do not carry a session id", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-webhook-agent-session-id-"));
  try {
    const config = createConfig(baseDir);
    config.projects[0] = {
      ...config.projects[0]!,
      triggerEvents: [...config.projects[0]!.triggerEvents, "agentSessionCreated"],
    };
    const db = new PatchRelayDatabase(config.database.path, config.database.wal);
    db.runMigrations();
    const installation = db.linearInstallations.upsertLinearInstallation({
      workspaceId: "workspace-1",
      actorId: "patchrelay-actor",
      accessTokenCiphertext: "ciphertext",
      scopesJson: "[]",
    });
    db.linearInstallations.linkProjectInstallation("krasnoperov/mafia", installation.id);

    const handler = new WebhookHandler(
      config,
      db,
      { forProject: async () => undefined } as never,
      { steerTurn: async () => undefined } as never,
      () => undefined,
      pino({ enabled: false }),
    );

    const sessionPayload: LinearWebhookPayload = {
      action: "created",
      type: "AgentSessionEvent",
      createdAt: "2026-04-01T03:00:00.000Z",
      webhookTimestamp: Date.now(),
      data: {
        promptContext: "<issue identifier=\"MAF-92\"><title>Keep agent session id</title></issue>",
        agentSession: {
          id: "session-92",
          issue: {
            id: "issue-maf-session",
            identifier: "MAF-92",
            title: "Keep agent session id",
            delegateId: "patchrelay-actor",
            delegate: { id: "patchrelay-actor", name: "PatchRelay" },
            team: { id: "team-maf", key: "MAF" },
            state: { id: "state-start", name: "Start", type: "started" },
          },
        },
      },
    };
    const sessionEvent = db.insertFullWebhookEvent({
      webhookId: "delivery-agent-session",
      receivedAt: new Date().toISOString(),
      payloadJson: JSON.stringify(sessionPayload),
    });
    await handler.processWebhookEvent(sessionEvent.id);

    const notificationPayload: LinearWebhookPayload = {
      action: "create",
      type: "AppUserNotification",
      createdAt: "2026-04-01T03:01:00.000Z",
      webhookTimestamp: Date.now(),
      data: {
        appUserId: "patchrelay-actor",
        notification: {
          type: "issueSubscribed",
          issue: {
            id: "issue-maf-session",
            identifier: "MAF-92",
            title: "Keep agent session id",
            team: { id: "team-maf", key: "MAF" },
            state: { id: "state-start", name: "Start", type: "started" },
          },
        },
      },
    };
    const notificationEvent = db.insertFullWebhookEvent({
      webhookId: "delivery-agent-notification",
      receivedAt: new Date().toISOString(),
      payloadJson: JSON.stringify(notificationPayload),
    });
    await handler.processWebhookEvent(notificationEvent.id);

    const issue = db.getIssue("krasnoperov/mafia", "issue-maf-session");
    assert.equal(issue?.agentSessionId, "session-92");
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});
