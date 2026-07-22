import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import test from "node:test";
import { assertIssuePhase } from "./assert-issue-phase.ts";
import { PatchRelayDatabase } from "../src/db.ts";
import { WebhookHandler } from "../src/webhook-handler.ts";
import { TrackedIssueListQuery } from "../src/tracked-issue-list-query.ts";
import type { AppConfig, LinearWebhookPayload, LinearIssueSnapshot, LinearClient } from "../src/types.ts";
import type { FollowupIntent, FollowupIntentClassifier } from "../src/followup-intent.ts";

function fakeFollowupClassifier(intent: FollowupIntent): FollowupIntentClassifier {
  return {
    classify: async () => ({
      intent,
      confidence: 0.95,
      reason: "Test classifier result.",
    }),
  };
}

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

function installFakeGh(baseDir: string, responseBody: string): () => void {
  const fakeBin = path.join(baseDir, "bin");
  const ghPath = path.join(fakeBin, "gh");
  mkdirSync(fakeBin, { recursive: true });
  writeFileSync(ghPath, `#!/usr/bin/env bash
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  printf '%s' '${responseBody}'
  exit 0
fi
echo "unexpected gh args: $*" >&2
exit 1
`, "utf8");
  chmodSync(ghPath, 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${fakeBin}:${oldPath ?? ""}`;
  return () => {
    process.env.PATH = oldPath;
  };
}

function createHydratedIssueSnapshot(params: {
  id: string;
  identifier: string;
  title: string;
  delegateId?: string;
  attachments?: NonNullable<LinearIssueSnapshot["attachments"]>;
}): LinearIssueSnapshot {
  return {
    id: params.id,
    identifier: params.identifier,
    title: params.title,
    teamId: "team-maf",
    teamKey: "MAF",
    delegateId: params.delegateId,
    stateId: "state-start",
    stateName: "In Progress",
    stateType: "started",
    ...(params.attachments ? { attachments: params.attachments } : {}),
    workflowStates: [],
    labelIds: [],
    labels: [],
    teamLabels: [],
    blockedBy: [],
    blocks: [],
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

    const stored = db.webhookEvents.insertFullWebhookEvent({
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

    const delegatedEvent = db.webhookEvents.insertFullWebhookEvent({
      webhookId: "delivery-maf-40",
      receivedAt: new Date().toISOString(),
      payloadJson: JSON.stringify(delegatedPayload),
    });
    await handler.processWebhookEvent(delegatedEvent.id);

    const blockedIssue = db.getIssue("krasnoperov/mafia", "issue-maf-40");
    assert.ok(blockedIssue);
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
      workflowOutcome: "completed",
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

    const blockerDoneEvent = db.webhookEvents.insertFullWebhookEvent({
      webhookId: "delivery-maf-39-done",
      receivedAt: new Date().toISOString(),
      payloadJson: JSON.stringify(blockerDonePayload),
    });
    await handler.processWebhookEvent(blockerDoneEvent.id);

    const unblockedTask = db.workflowTasks.getTask("krasnoperov/mafia", "issue-maf-40", "run:implementation");
    assert.equal(db.issueSessions.peekPendingSessionInputPlanForDiagnostics("krasnoperov/mafia", "issue-maf-40"), undefined);
    assert.equal(unblockedTask?.runType, "implementation");
    assert.equal(unblockedTask?.gateAction, "start");
    assert.deepEqual(db.listIssuesReadyForExecution(), [{ projectId: "krasnoperov/mafia", linearIssueId: "issue-maf-40" }]);
    assert.deepEqual(enqueued, [{ projectId: "krasnoperov/mafia", issueId: "issue-maf-40" }]);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("delegated issue with only completed blockers queues implementation immediately", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-webhook-completed-blocker-start-"));
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

    const linearClient: Partial<LinearClient> = {
      getIssue: async () => ({
        id: "issue-maf-completed-blocker",
        identifier: "MAF-41",
        title: "Work after done provenance",
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
        blockedBy: [{
          id: "issue-maf-done-source",
          identifier: "MAF-10",
          title: "Done source issue",
          stateName: "Done",
          stateType: "completed",
        }],
        blocks: [],
      }),
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

    const payload: LinearWebhookPayload = {
      action: "update",
      type: "Issue",
      createdAt: "2026-04-01T00:00:00.000Z",
      webhookTimestamp: Date.now(),
      updatedFrom: { delegateId: null },
      data: {
        id: "issue-maf-completed-blocker",
        identifier: "MAF-41",
        title: "Work after done provenance",
        team: { id: "team-maf", key: "MAF" },
        state: { id: "state-start", name: "Start", type: "started" },
        delegate: { id: "patchrelay-actor", name: "PatchRelay" },
      },
    };

    const event = db.webhookEvents.insertFullWebhookEvent({
      webhookId: "delivery-maf-completed-blocker-start",
      receivedAt: new Date().toISOString(),
      payloadJson: JSON.stringify(payload),
    });
    await handler.processWebhookEvent(event.id);

    const issue = db.getIssue("krasnoperov/mafia", "issue-maf-completed-blocker");
    const workflowTask = db.workflowTasks.getTask("krasnoperov/mafia", "issue-maf-completed-blocker", "run:implementation");
    assertIssuePhase(issue, "delegated");
    assert.equal(db.listIssueDependencies("krasnoperov/mafia", "issue-maf-completed-blocker").length, 1);
    assert.equal(db.countUnresolvedBlockers("krasnoperov/mafia", "issue-maf-completed-blocker"), 0);
    assert.equal(db.issueSessions.peekPendingSessionInputPlanForDiagnostics("krasnoperov/mafia", "issue-maf-completed-blocker"), undefined);
    assert.equal(workflowTask?.runType, "implementation");
    assert.equal(workflowTask?.gateAction, "start");
    assert.deepEqual(db.listIssuesReadyForExecution(), [{ projectId: "krasnoperov/mafia", linearIssueId: "issue-maf-completed-blocker" }]);
    assert.deepEqual(enqueued, [{ projectId: "krasnoperov/mafia", issueId: "issue-maf-completed-blocker" }]);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("delegated blocked agent session is acknowledged without queueing implementation", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-webhook-blocked-session-ack-"));
  try {
    const config = createConfig(baseDir);
    config.projects[0] = {
      ...config.projects[0]!,
      triggerEvents: ["delegateChanged", "statusChanged", "agentSessionCreated", "agentPrompted", "commentCreated", "commentUpdated"],
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

    const activities: Array<{ agentSessionId: string; content: { type: string; body?: string } }> = [];
    const sessionUpdates: Array<{ agentSessionId: string; planLength: number }> = [];
    const operations: string[] = [];
    const linearClient: Partial<LinearClient> = {
      getIssue: async () => {
        operations.push("getIssue");
        return {
          id: "issue-maf-blocked-session",
          identifier: "MAF-97",
          title: "Blocked delegated session",
          teamId: "team-maf",
          teamKey: "MAF",
          delegateId: "patchrelay-actor",
          stateId: "state-backlog",
          stateName: "Backlog",
          stateType: "backlog",
          workflowStates: [],
          labelIds: [],
          labels: [],
          teamLabels: [],
          blockedBy: [{
            id: "issue-blocker-1",
            identifier: "MAF-10",
            title: "Blocking task",
            stateName: "In Progress",
            stateType: "started",
          }],
          blocks: [],
        };
      },
      createAgentActivity: async ({ agentSessionId, content }) => {
        operations.push(`activity:${content.type}`);
        activities.push({ agentSessionId, content: content as { type: string; body?: string } });
        return { id: `activity-${activities.length}` };
      },
      updateAgentSession: async ({ agentSessionId, plan }) => {
        operations.push("updateAgentSession");
        sessionUpdates.push({ agentSessionId, planLength: plan?.length ?? 0 });
        return { id: agentSessionId };
      },
    };

    const enqueued: Array<{ projectId: string; issueId: string }> = [];
    const handler = new WebhookHandler(
      config,
      db,
      { forProject: async () => linearClient as LinearClient } as never,
      { steerTurn: async () => undefined } as never,
      (projectId, issueId) => {
        enqueued.push({ projectId, issueId });
      },
      pino({ enabled: false }),
    );

    const payload: LinearWebhookPayload = {
      action: "created",
      type: "AgentSessionEvent",
      createdAt: "2026-04-01T03:00:00.000Z",
      webhookTimestamp: Date.now(),
      agentSession: {
        id: "session-blocked-97",
        issueId: "issue-maf-blocked-session",
        comment: {
          id: "comment-blocked-97",
          body: "This thread is for an agent session with patchrelay.",
          issueId: "issue-maf-blocked-session",
        },
        issue: {
          id: "issue-maf-blocked-session",
          identifier: "MAF-97",
          title: "Blocked delegated session",
          team: { id: "team-maf", key: "MAF" },
          state: { id: "state-backlog", name: "Backlog", type: "backlog" },
          delegateId: "patchrelay-actor",
          delegate: { id: "patchrelay-actor", name: "PatchRelay" },
        },
      },
      promptContext: "<issue identifier=\"MAF-97\"><title>Blocked delegated session</title></issue>",
    };
    const stored = db.webhookEvents.insertFullWebhookEvent({
      webhookId: "delivery-agent-session-blocked-ack",
      receivedAt: new Date().toISOString(),
      payloadJson: JSON.stringify(payload),
    });

    await handler.processWebhookEvent(stored.id);

    const issue = db.getIssue("krasnoperov/mafia", "issue-maf-blocked-session");
    assertIssuePhase(issue, "delegated");
    assert.equal(issue?.agentSessionId, "session-blocked-97");
    assert.equal(db.countUnresolvedBlockers("krasnoperov/mafia", "issue-maf-blocked-session"), 1);
    assert.equal(db.issueSessions.peekPendingSessionInputPlanForDiagnostics("krasnoperov/mafia", "issue-maf-blocked-session"), undefined);
    assert.deepEqual(enqueued, []);
    assert.deepEqual(sessionUpdates, [{ agentSessionId: "session-blocked-97", planLength: 4 }]);
    assert.equal(operations[0], "activity:thought");
    assert.ok(operations.indexOf("activity:thought") < operations.indexOf("getIssue"));
    assert.equal(activities.length, 2);
    assert.equal(activities[0]?.agentSessionId, "session-blocked-97");
    assert.equal(activities[0]?.content.type, "thought");
    assert.match(activities[0]?.content.body ?? "", /received this agent session/i);
    assert.equal(activities[1]?.agentSessionId, "session-blocked-97");
    assert.equal(activities[1]?.content.type, "response");
    assert.match(activities[1]?.content.body ?? "", /accepted this delegation/i);
    assert.match(activities[1]?.content.body ?? "", /MAF-10/);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("agent session acknowledgement failures do not block later session sync", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-webhook-agent-session-ack-failure-"));
  try {
    const config = createConfig(baseDir);
    config.projects[0] = {
      ...config.projects[0]!,
      triggerEvents: ["delegateChanged", "statusChanged", "agentSessionCreated", "agentPrompted", "commentCreated", "commentUpdated"],
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

    let activityAttempts = 0;
    const sessionUpdates: Array<{ agentSessionId: string; planLength: number }> = [];
    const linearClient: Partial<LinearClient> = {
      getIssue: async () => ({
        id: "issue-maf-ack-failure",
        identifier: "MAF-98",
        title: "Ack failure session",
        teamId: "team-maf",
        teamKey: "MAF",
        delegateId: undefined,
        stateId: "state-backlog",
        stateName: "Backlog",
        stateType: "backlog",
        workflowStates: [],
        labelIds: [],
        labels: [],
        teamLabels: [],
        blockedBy: [],
        blocks: [],
      }),
      createAgentActivity: async () => {
        activityAttempts += 1;
        throw new Error("Linear activity API unavailable");
      },
      updateAgentSession: async ({ agentSessionId, plan }) => {
        sessionUpdates.push({ agentSessionId, planLength: plan?.length ?? 0 });
        return { id: agentSessionId };
      },
    };

    const handler = new WebhookHandler(
      config,
      db,
      { forProject: async () => linearClient as LinearClient } as never,
      { steerTurn: async () => undefined } as never,
      () => undefined,
      pino({ enabled: false }),
    );

    const payload: LinearWebhookPayload = {
      action: "created",
      type: "AgentSessionEvent",
      createdAt: "2026-04-01T03:00:00.000Z",
      webhookTimestamp: Date.now(),
      data: {
        promptContext: "<issue identifier=\"MAF-98\"><title>Ack failure session</title></issue>",
        agentSession: {
          id: "session-ack-failure",
          issue: {
            id: "issue-maf-ack-failure",
            identifier: "MAF-98",
            title: "Ack failure session",
            team: { id: "team-maf", key: "MAF" },
            state: { id: "state-backlog", name: "Backlog", type: "backlog" },
          },
        },
      },
    };
    const stored = db.webhookEvents.insertFullWebhookEvent({
      webhookId: "delivery-agent-session-ack-failure",
      receivedAt: new Date().toISOString(),
      payloadJson: JSON.stringify(payload),
    });

    await handler.processWebhookEvent(stored.id);

    assert.equal(activityAttempts, 1);
    assert.deepEqual(sessionUpdates, [{ agentSessionId: "session-ack-failure", planLength: 4 }]);
    assert.equal(db.getIssue("krasnoperov/mafia", "issue-maf-ack-failure")?.agentSessionId, "session-ack-failure");
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("external blocker completion releases delegated dependents without tracking the blocker", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-webhook-external-blocker-"));
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
        blockedBy: [{
          id: "issue-maf-39",
          identifier: "MAF-39",
          title: "API contracts",
          stateName: "In Progress",
          stateType: "started",
        }],
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
        blocks: [{
          id: "issue-maf-40",
          identifier: "MAF-40",
          title: "Active session sync",
          stateName: "Start",
          stateType: "started",
        }],
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

    const delegatedEvent = db.webhookEvents.insertFullWebhookEvent({
      webhookId: "delivery-maf-40-external-blocker",
      receivedAt: new Date().toISOString(),
      payloadJson: JSON.stringify({
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
      } satisfies LinearWebhookPayload),
    });
    await handler.processWebhookEvent(delegatedEvent.id);

    assert.equal(db.getIssue("krasnoperov/mafia", "issue-maf-39"), undefined);
    assert.equal(db.countUnresolvedBlockers("krasnoperov/mafia", "issue-maf-40"), 1);
    assert.deepEqual(db.listIssuesReadyForExecution(), []);

    issueSnapshots.set("issue-maf-39", {
      ...(issueSnapshots.get("issue-maf-39")!),
      stateName: "Done",
      stateType: "completed",
    });

    const blockerDoneEvent = db.webhookEvents.insertFullWebhookEvent({
      webhookId: "delivery-maf-39-external-done",
      receivedAt: new Date().toISOString(),
      payloadJson: JSON.stringify({
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
      } satisfies LinearWebhookPayload),
    });
    await handler.processWebhookEvent(blockerDoneEvent.id);

    const unblockedTask = db.workflowTasks.getTask("krasnoperov/mafia", "issue-maf-40", "run:implementation");
    assert.equal(db.getIssue("krasnoperov/mafia", "issue-maf-39"), undefined);
    assert.equal(db.countUnresolvedBlockers("krasnoperov/mafia", "issue-maf-40"), 0);
    assert.equal(db.issueSessions.peekPendingSessionInputPlanForDiagnostics("krasnoperov/mafia", "issue-maf-40"), undefined);
    assert.equal(unblockedTask?.runType, "implementation");
    assert.equal(unblockedTask?.gateAction, "start");
    assert.deepEqual(db.listIssuesReadyForExecution(), [{ projectId: "krasnoperov/mafia", linearIssueId: "issue-maf-40" }]);
    assert.deepEqual(enqueued, [{ projectId: "krasnoperov/mafia", issueId: "issue-maf-40" }]);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("delegated issue webhooks enqueue implementation workflowTask immediately when the issue is unblocked", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-webhook-delegation-workflowTask-"));
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

    const linearClient: Partial<LinearClient> = {
      getIssue: async () => ({
        id: "issue-maf-delegated",
        identifier: "MAF-41",
        title: "Unblocked delegation workflowTask",
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
        blockedBy: [],
        blocks: [],
      }),
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

    const payload: LinearWebhookPayload = {
      action: "update",
      type: "Issue",
      createdAt: "2026-04-01T00:00:00.000Z",
      webhookTimestamp: Date.now(),
      updatedFrom: { delegateId: null },
      data: {
        id: "issue-maf-delegated",
        identifier: "MAF-41",
        title: "Unblocked delegation workflowTask",
        team: { id: "team-maf", key: "MAF" },
        state: { id: "state-start", name: "Start", type: "started" },
        delegate: { id: "patchrelay-actor", name: "PatchRelay" },
      },
    };

    const stored = db.webhookEvents.insertFullWebhookEvent({
      webhookId: "delivery-delegation-workflowTask",
      receivedAt: new Date().toISOString(),
      payloadJson: JSON.stringify(payload),
    });
    await handler.processWebhookEvent(stored.id);

    const issue = db.getIssue("krasnoperov/mafia", "issue-maf-delegated");
    const workflowTask = db.workflowTasks.getTask("krasnoperov/mafia", "issue-maf-delegated", "run:implementation");
    assertIssuePhase(issue, "delegated");
    assert.equal(db.issueSessions.peekPendingSessionInputPlanForDiagnostics("krasnoperov/mafia", "issue-maf-delegated"), undefined);
    assert.equal(workflowTask?.runType, "implementation");
    assert.equal(workflowTask?.gateAction, "start");
    assert.deepEqual(enqueued, [{ projectId: "krasnoperov/mafia", issueId: "issue-maf-delegated" }]);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("issue becoming blocked during implementation releases the active run and pauses work", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-webhook-blocked-active-run-"));
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
      linearIssueId: "issue-maf-blocked-active",
      issueKey: "MAF-42",
      title: "Sequencing bug",
      delegatedToPatchRelay: true,
      workflowOutcome: undefined,
    });
    const run = db.runs.createRun({
      issueId: issueRecord.id,
      projectId: issueRecord.projectId,
      linearIssueId: issueRecord.linearIssueId,
      runType: "implementation",
    });
    db.runs.updateRunThread(run.id, { threadId: "thread-blocked-active", turnId: "turn-blocked-active" });
    db.upsertIssue({
      projectId: issueRecord.projectId,
      linearIssueId: issueRecord.linearIssueId,
      activeRunId: run.id,
      branchName: "maf/42-sequencing-bug",
    });

    const steerInputs: string[] = [];
    const linearClient: Partial<LinearClient> = {
      getIssue: async () => ({
        id: "issue-maf-blocked-active",
        identifier: "MAF-42",
        title: "Sequencing bug",
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
        blockedBy: [{
          id: "issue-maf-blocker",
          identifier: "MAF-10",
          title: "Blocking task",
          stateName: "In Progress",
          stateType: "started",
        }],
        blocks: [],
      }),
    };

    const enqueued: Array<{ projectId: string; issueId: string }> = [];
    const handler = new WebhookHandler(
      config,
      db,
      { forProject: async () => linearClient as LinearClient } as never,
      {
        steerTurn: async ({ input }) => {
          steerInputs.push(input);
        },
      } as never,
      (projectId, issueId) => {
        enqueued.push({ projectId, issueId });
      },
      pino({ enabled: false }),
    );

    const payload: LinearWebhookPayload = {
      action: "update",
      type: "Issue",
      createdAt: "2026-04-01T00:00:00.000Z",
      webhookTimestamp: Date.now(),
      updatedFrom: { stateId: "state-start" },
      data: {
        id: "issue-maf-blocked-active",
        identifier: "MAF-42",
        title: "Sequencing bug",
        team: { id: "team-maf", key: "MAF" },
        state: { id: "state-start", name: "Start", type: "started" },
        delegate: { id: "patchrelay-actor", name: "PatchRelay" },
      },
    };

    const stored = db.webhookEvents.insertFullWebhookEvent({
      webhookId: "delivery-maf-blocked-active",
      receivedAt: new Date().toISOString(),
      payloadJson: JSON.stringify(payload),
    });
    await handler.processWebhookEvent(stored.id);

    const issue = db.getIssue("krasnoperov/mafia", "issue-maf-blocked-active");
    const finishedRun = db.runs.getRunById(run.id);
    const session = db.issueSessions.getIssueSession("krasnoperov/mafia", "issue-maf-blocked-active");
    const tracked = new TrackedIssueListQuery(db).listTrackedIssues().find((entry) => entry.issueKey === "MAF-42");
    assertIssuePhase(issue, "delegated");
    assert.equal(issue?.activeRunId, undefined);
    assert.equal(issue?.delegatedToPatchRelay, true);
    assert.equal(db.countUnresolvedBlockers("krasnoperov/mafia", "issue-maf-blocked-active"), 1);
    assert.equal(db.issueSessions.peekPendingSessionInputPlanForDiagnostics("krasnoperov/mafia", "issue-maf-blocked-active"), undefined);
    assert.deepEqual(enqueued, []);
    assert.equal(session?.waitingReason, "Blocked by MAF-10");
    assert.equal(tracked?.waitingReason, "Blocked by MAF-10");
    assert.equal(finishedRun?.status, "released");
    assert.equal(finishedRun?.failureReason, "Issue became blocked during implementation");
    assert.equal(steerInputs.length, 1);
    assert.match(steerInputs[0] ?? "", /now blocked/i);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("completed blocker added during implementation does not release the active run", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-webhook-completed-blocker-active-run-"));
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
      linearIssueId: "issue-maf-completed-blocked-active",
      issueKey: "MAF-43",
      title: "Sequencing provenance",
      delegatedToPatchRelay: true,
      workflowOutcome: undefined,
    });
    const run = db.runs.createRun({
      issueId: issueRecord.id,
      projectId: issueRecord.projectId,
      linearIssueId: issueRecord.linearIssueId,
      runType: "implementation",
    });
    db.runs.updateRunThread(run.id, { threadId: "thread-completed-blocker-active", turnId: "turn-completed-blocker-active" });
    db.upsertIssue({
      projectId: issueRecord.projectId,
      linearIssueId: issueRecord.linearIssueId,
      activeRunId: run.id,
      branchName: "maf/43-sequencing-provenance",
    });

    const steerInputs: string[] = [];
    const linearClient: Partial<LinearClient> = {
      getIssue: async () => ({
        id: "issue-maf-completed-blocked-active",
        identifier: "MAF-43",
        title: "Sequencing provenance",
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
        blockedBy: [{
          id: "issue-maf-done-source",
          identifier: "MAF-10",
          title: "Done source issue",
          stateName: "Done",
          stateType: "completed",
        }],
        blocks: [],
      }),
    };

    const enqueued: Array<{ projectId: string; issueId: string }> = [];
    const handler = new WebhookHandler(
      config,
      db,
      { forProject: async () => linearClient as LinearClient } as never,
      {
        steerTurn: async ({ input }) => {
          steerInputs.push(input);
        },
      } as never,
      (projectId, issueId) => {
        enqueued.push({ projectId, issueId });
      },
      pino({ enabled: false }),
    );

    const payload: LinearWebhookPayload = {
      action: "update",
      type: "Issue",
      createdAt: "2026-04-01T00:00:00.000Z",
      webhookTimestamp: Date.now(),
      updatedFrom: { stateId: "state-start" },
      data: {
        id: "issue-maf-completed-blocked-active",
        identifier: "MAF-43",
        title: "Sequencing provenance",
        team: { id: "team-maf", key: "MAF" },
        state: { id: "state-start", name: "Start", type: "started" },
        delegate: { id: "patchrelay-actor", name: "PatchRelay" },
      },
    };

    const event = db.webhookEvents.insertFullWebhookEvent({
      webhookId: "delivery-maf-completed-blocker-active",
      receivedAt: new Date().toISOString(),
      payloadJson: JSON.stringify(payload),
    });
    await handler.processWebhookEvent(event.id);

    const issue = db.getIssue("krasnoperov/mafia", "issue-maf-completed-blocked-active");
    const activeRun = db.runs.getRunById(run.id);
    const tracked = new TrackedIssueListQuery(db).listTrackedIssues().find((entry) => entry.issueKey === "MAF-43");
    assertIssuePhase(issue, "implementing");
    assert.equal(issue?.activeRunId, run.id);
    assert.equal(db.listIssueDependencies("krasnoperov/mafia", "issue-maf-completed-blocked-active").length, 1);
    assert.equal(db.countUnresolvedBlockers("krasnoperov/mafia", "issue-maf-completed-blocked-active"), 0);
    assert.equal(db.issueSessions.peekPendingSessionInputPlanForDiagnostics("krasnoperov/mafia", "issue-maf-completed-blocked-active"), undefined);
    assert.deepEqual(enqueued, []);
    assert.equal(tracked?.blockedByCount, 0);
    assert.deepEqual(tracked?.blockedByKeys, []);
    assert.equal(tracked?.waitingReason, "PatchRelay is actively working");
    assert.equal(activeRun?.status, "running");
    assert.deepEqual(steerInputs, []);
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

    const stored = db.webhookEvents.insertFullWebhookEvent({
      webhookId: "delivery-maf-38-fallback",
      receivedAt: new Date().toISOString(),
      payloadJson: JSON.stringify(payload),
    });

    await handler.processWebhookEvent(stored.id);

    const issue = db.getIssue("krasnoperov/mafia", "issue-maf-38");
    assert.ok(issue);
    assert.equal(issue?.issueKey, "MAF-38");
    assertIssuePhase(issue, "delegated");
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

    const stored = db.webhookEvents.insertFullWebhookEvent({
      webhookId: "delivery-maf-39-single-installation-fallback",
      receivedAt: new Date().toISOString(),
      payloadJson: JSON.stringify(payload),
    });

    await handler.processWebhookEvent(stored.id);

    const issue = db.getIssue("krasnoperov/mafia", "issue-maf-39");
    assert.ok(issue);
    assert.equal(issue?.issueKey, "MAF-39");
    assertIssuePhase(issue, "delegated");
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

    const delegatedEvent = db.webhookEvents.insertFullWebhookEvent({
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
      workflowOutcome: "completed",
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

    const stored = db.webhookEvents.insertFullWebhookEvent({
      webhookId: "delivery-maf-38-done-echo",
      receivedAt: new Date().toISOString(),
      payloadJson: JSON.stringify(payload),
    });

    await handler.processWebhookEvent(stored.id);

    const issue = db.getIssue("krasnoperov/mafia", "issue-maf-38");
    assertIssuePhase(issue, "done");
    assert.deepEqual(enqueued, []);
    assert.deepEqual(db.listIssuesReadyForExecution(), []);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("in-review status echo keeps an undecided open PR in review without requeueing implementation", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-webhook-in-review-echo-"));
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
      linearIssueId: "issue-maf-39",
      issueKey: "MAF-39",
      title: "Printable facilitator sheet",
      currentLinearState: "In Review",
      currentLinearStateType: "started",
      workflowOutcome: undefined,
      prNumber: 130,
      prState: "open",
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
      updatedFrom: { stateId: "state-progress" },
      data: {
        id: "issue-maf-39",
        identifier: "MAF-39",
        title: "Printable facilitator sheet",
        team: { id: "team-maf", key: "MAF" },
        state: { id: "state-review", name: "In Review", type: "started" },
        delegate: { id: "patchrelay-actor", name: "PatchRelay" },
      },
    };

    const stored = db.webhookEvents.insertFullWebhookEvent({
      webhookId: "delivery-maf-39-review-echo",
      receivedAt: new Date().toISOString(),
      payloadJson: JSON.stringify(payload),
    });

    await handler.processWebhookEvent(stored.id);

    const issue = db.getIssue("krasnoperov/mafia", "issue-maf-39");
    assertIssuePhase(issue, "pr_open");
    assert.deepEqual(enqueued, []);
    assert.deepEqual(db.issueSessions.listIssueSessionEvents("krasnoperov/mafia", "issue-maf-39", { pendingOnly: true }), []);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("un-delegation during active run releases the run and derives a paused phase", async () => {
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
    const worktreePath = path.join(baseDir, "repo");
    execFileSync("git", ["init", worktreePath], { stdio: "ignore" });
    execFileSync("git", ["-C", worktreePath, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", worktreePath, "config", "user.name", "Test User"]);
    writeFileSync(path.join(worktreePath, "file.txt"), "base\n");
    execFileSync("git", ["-C", worktreePath, "add", "file.txt"]);
    execFileSync("git", ["-C", worktreePath, "commit", "-m", "base"], { stdio: "ignore" });
    writeFileSync(path.join(worktreePath, "file.txt"), "dirty\n");

    const issueRecord = db.upsertIssue({
      projectId: "krasnoperov/mafia",
      linearIssueId: "issue-maf-50",
      issueKey: "MAF-50",
      title: "Implement feature X",
      workflowOutcome: undefined,
      worktreePath,
    });
    const run = db.runs.createRun({
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

    const stored = db.webhookEvents.insertFullWebhookEvent({
      webhookId: "delivery-undelegate-50",
      receivedAt: new Date().toISOString(),
      payloadJson: JSON.stringify(payload),
    });

    await handler.processWebhookEvent(stored.id);

    const issue = db.getIssue("krasnoperov/mafia", "issue-maf-50");
    assertIssuePhase(issue, "paused");
    assert.equal(issue?.delegatedToPatchRelay, false);
    assert.equal(issue?.activeRunId, undefined);

    const finishedRun = db.runs.getRunById(run.id);
    assert.equal(finishedRun?.status, "released");
    assert.ok(finishedRun?.failureReason?.includes("Un-delegated"));
    assert.ok(finishedRun?.failureReason?.includes("Worktree has"));
    assert.ok(finishedRun?.failureReason?.includes("file.txt"));
    const undelegatedEvent = db.issueSessions
      .listIssueSessionEvents("krasnoperov/mafia", "issue-maf-50")
      .find((event) => event.eventType === "undelegated");
    assert.match(undelegatedEvent?.eventJson ?? "", /dirtyWorktree/);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("un-delegation webhook syncs the issue back to a queued Linear state immediately", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-webhook-undelegate-linear-sync-"));
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
      linearIssueId: "issue-maf-50-sync",
      issueKey: "MAF-50S",
      title: "Pause implementation",
      workflowOutcome: undefined,
      delegatedToPatchRelay: true,
      currentLinearState: "In Progress",
      currentLinearStateType: "started",
    });

    const setIssueStateCalls: string[] = [];
    const commentUpdates: Array<Record<string, unknown>> = [];
    const linearClient: Partial<LinearClient> = {
      getIssue: async (issueId: string) => {
        assert.equal(issueId, "issue-maf-50-sync");
        return {
          id: "issue-maf-50-sync",
          identifier: "MAF-50S",
          title: "Pause implementation",
          teamId: "team-maf",
          teamKey: "MAF",
          delegateId: undefined,
          stateId: "state-progress",
          stateName: "In Progress",
          stateType: "started",
          workflowStates: [
            { id: "state-backlog", name: "Backlog", type: "backlog" },
            { id: "state-progress", name: "In Progress", type: "started" },
            { id: "state-done", name: "Done", type: "completed" },
          ],
          labelIds: [],
          labels: [],
          teamLabels: [],
          blockedBy: [],
          blocks: [],
        };
      },
      setIssueState: async (_issueId, stateName) => {
        setIssueStateCalls.push(stateName);
        return {
          id: "issue-maf-50-sync",
          identifier: "MAF-50S",
          title: "Pause implementation",
          stateName,
          stateType: stateName === "Backlog" ? "backlog" : "started",
          workflowStates: [
            { id: "state-backlog", name: "Backlog", type: "backlog" },
            { id: "state-progress", name: "In Progress", type: "started" },
            { id: "state-done", name: "Done", type: "completed" },
          ],
          blockedBy: [],
          relationsKnown: true,
        };
      },
      upsertIssueComment: async (params) => {
        commentUpdates.push(params as unknown as Record<string, unknown>);
        return { id: "comment-50-sync", body: params.body };
      },
      createAgentActivity: async () => ({ id: "activity-50-sync" }),
      updateAgentSession: async () => ({ id: "session-50-sync" }),
    };

    const handler = new WebhookHandler(
      config,
      db,
      { forProject: async () => linearClient as LinearClient } as never,
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
        id: "issue-maf-50-sync",
        identifier: "MAF-50S",
        title: "Pause implementation",
        team: { id: "team-maf", key: "MAF" },
        state: { id: "state-progress", name: "In Progress", type: "started" },
        delegate: null,
      },
    };

    const stored = db.webhookEvents.insertFullWebhookEvent({
      webhookId: "delivery-undelegate-50-sync",
      receivedAt: new Date().toISOString(),
      payloadJson: JSON.stringify(payload),
    });

    await handler.processWebhookEvent(stored.id);

    assert.deepEqual(setIssueStateCalls, ["Backlog"]);
    assert.equal(db.getIssue("krasnoperov/mafia", "issue-maf-50-sync")?.currentLinearState, "Backlog");
    assert.equal(commentUpdates.length, 1);
    assert.match(String(commentUpdates[0]?.body), /PatchRelay automation is paused because the issue is undelegated/);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("terminal Linear completion during active run records Linear state but keeps the run active", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-webhook-terminal-active-"));
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
      linearIssueId: "issue-maf-50-done",
      issueKey: "MAF-50D",
      title: "Planning-only issue",
      delegatedToPatchRelay: true,
      currentLinearState: "In Progress",
      currentLinearStateType: "started",
      workflowOutcome: undefined,
    });
    const run = db.runs.createRun({
      issueId: issueRecord.id,
      projectId: "krasnoperov/mafia",
      linearIssueId: "issue-maf-50-done",
      runType: "implementation",
    });
    db.runs.updateRunThread(run.id, { threadId: "thread-maf-50-done", turnId: "turn-maf-50-done" });
    db.upsertIssue({
      projectId: "krasnoperov/mafia",
      linearIssueId: "issue-maf-50-done",
      activeRunId: run.id,
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
        id: "issue-maf-50-done",
        identifier: "MAF-50D",
        title: "Planning-only issue",
        team: { id: "team-maf", key: "MAF" },
        state: { id: "state-done", name: "Done", type: "completed" },
        delegate: { id: "patchrelay-actor", name: "PatchRelay" },
      },
    };

    const stored = db.webhookEvents.insertFullWebhookEvent({
      webhookId: "delivery-terminal-active-50-done",
      receivedAt: new Date().toISOString(),
      payloadJson: JSON.stringify(payload),
    });

    await handler.processWebhookEvent(stored.id);

    const issue = db.getIssue("krasnoperov/mafia", "issue-maf-50-done");
    assert.equal(issue?.currentLinearState, "Done");
    assert.equal(issue?.currentLinearStateType, "completed");
    assertIssuePhase(issue, "implementing");
    assert.equal(issue?.activeRunId, run.id);
    assert.deepEqual(enqueued, []);

    const finishedRun = db.runs.getRunById(run.id);
    assert.equal(finishedRun?.status, "running");
    assert.equal(finishedRun?.failureReason, undefined);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("un-delegation preserves downstream PR facts while deriving a paused phase", async () => {
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
      delegatedToPatchRelay: true,
      workflowOutcome: undefined,
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

    const stored = db.webhookEvents.insertFullWebhookEvent({
      webhookId: "delivery-undelegate-51",
      receivedAt: new Date().toISOString(),
      payloadJson: JSON.stringify(payload),
    });

    await handler.processWebhookEvent(stored.id);

    const issue = db.getIssue("krasnoperov/mafia", "issue-maf-51");
    assertIssuePhase(issue, "paused");
    assert.equal(issue?.delegatedToPatchRelay, false);
    assert.equal(issue?.prNumber, 120);
    assert.equal(issue?.prState, "open");
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("status webhook preserves previous delegation when live Linear hydration fails and webhook lacks delegate identity", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-webhook-preserve-delegation-"));
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
      linearIssueId: "issue-maf-preserve",
      issueKey: "MAF-57",
      title: "Preserve delegation on partial webhook",
      delegatedToPatchRelay: true,
      workflowOutcome: undefined,
      prNumber: 157,
      prState: "open",
    });

    const handler = new WebhookHandler(
      config,
      db,
      { forProject: async () => ({ getIssue: async () => { throw new Error("linear down"); } } as LinearClient) } as never,
      { steerTurn: async () => undefined } as never,
      () => undefined,
      pino({ enabled: false }),
    );

    const payload: LinearWebhookPayload = {
      action: "update",
      type: "Issue",
      createdAt: "2026-04-01T00:00:00.000Z",
      webhookTimestamp: Date.now(),
      updatedFrom: { stateId: "state-backlog" },
      data: {
        id: "issue-maf-preserve",
        identifier: "MAF-57",
        title: "Preserve delegation on partial webhook",
        team: { id: "team-maf", key: "MAF" },
        state: { id: "state-review", name: "In Review", type: "started" },
      },
    };

    const stored = db.webhookEvents.insertFullWebhookEvent({
      webhookId: "delivery-preserve-delegation",
      receivedAt: new Date().toISOString(),
      payloadJson: JSON.stringify(payload),
    });

    await handler.processWebhookEvent(stored.id);

    const issue = db.getIssue("krasnoperov/mafia", "issue-maf-preserve");
    assert.equal(issue?.delegatedToPatchRelay, true);
    const audit = db.issueSessions.listIssueSessionEvents("krasnoperov/mafia", "issue-maf-preserve")
      .findLast((event) => event.eventType === "delegation_observed");
    assert.ok(audit?.eventJson);
    const parsed = JSON.parse(audit.eventJson) as { hydration?: string; appliedDelegatedToPatchRelay?: boolean; reason?: string };
    assert.equal(parsed.hydration, "live_linear_failed");
    assert.equal(parsed.appliedDelegatedToPatchRelay, true);
    assert.equal(parsed.reason, "preserved_previous_delegation_after_live_linear_failed");
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("re-delegation resumes requested-changes issue from PR state instead of restarting implementation", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-webhook-redelegate-"));
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
      linearIssueId: "issue-maf-52",
      issueKey: "MAF-52",
      title: "Resume existing PR",
      delegatedToPatchRelay: false,
      inputRequestKind: "completion_check_question",
      prNumber: 121,
      prState: "open",
      prHeadSha: "sha-redelegate-review",
      prReviewState: "changes_requested",
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
      updatedFrom: { delegateId: null },
      data: {
        id: "issue-maf-52",
        identifier: "MAF-52",
        title: "Resume existing PR",
        team: { id: "team-maf", key: "MAF" },
        state: { id: "state-start", name: "Start", type: "started" },
        delegate: { id: "patchrelay-actor", name: "PatchRelay" },
      },
    };

    const stored = db.webhookEvents.insertFullWebhookEvent({
      webhookId: "delivery-redelegate-52",
      receivedAt: new Date().toISOString(),
      payloadJson: JSON.stringify(payload),
    });

    await handler.processWebhookEvent(stored.id);

    const issue = db.getIssue("krasnoperov/mafia", "issue-maf-52");
    assert.equal(issue?.delegatedToPatchRelay, true);
    assertIssuePhase(issue, "changes_requested");
    const workflowTask = db.issueSessions.peekPendingSessionInputPlanForDiagnostics("krasnoperov/mafia", "issue-maf-52");
    assert.equal(workflowTask?.runType, "review_fix");
    assert.deepEqual(enqueued, [{ projectId: "krasnoperov/mafia", issueId: "issue-maf-52" }]);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("delegateChanged adopts an attached same-repo PR without requiring hidden ownership metadata", { concurrency: false }, async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-webhook-linked-pr-review-fix-"));
  const restorePath = installFakeGh(
    baseDir,
    JSON.stringify({
      url: "https://github.com/krasnoperov/mafia/pull/124",
      body: "Broken PR handed to PatchRelay for repair",
      headRefName: "feat-existing-pr",
      headRefOid: "sha-linked-review",
      isDraft: false,
      isCrossRepository: false,
      state: "OPEN",
      author: { login: "external-dev" },
      reviewDecision: "CHANGES_REQUESTED",
      mergeable: "MERGEABLE",
      mergeStateStatus: "BLOCKED",
      statusCheckRollup: [{ __typename: "CheckRun", name: "verify", status: "COMPLETED", conclusion: "SUCCESS" }],
    }),
  );
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

    const linearClient: Partial<LinearClient> = {
      getIssue: async () => createHydratedIssueSnapshot({
        id: "issue-maf-adopt-review",
        identifier: "MAF-124",
        title: "Adopt linked review PR",
        delegateId: "patchrelay-actor",
        attachments: [{
          id: "attachment-124",
          title: "GitHub PR #124",
          url: "https://github.com/krasnoperov/mafia/pull/124",
        }],
      }),
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

    const payload: LinearWebhookPayload = {
      action: "update",
      type: "Issue",
      createdAt: "2026-04-01T00:00:00.000Z",
      webhookTimestamp: Date.now(),
      updatedFrom: { delegateId: null },
      data: {
        id: "issue-maf-adopt-review",
        identifier: "MAF-124",
        title: "Adopt linked review PR",
        team: { id: "team-maf", key: "MAF" },
        state: { id: "state-start", name: "In Progress", type: "started" },
        delegate: { id: "patchrelay-actor", name: "PatchRelay" },
      },
    };

    const stored = db.webhookEvents.insertFullWebhookEvent({
      webhookId: "delivery-adopt-review",
      receivedAt: new Date().toISOString(),
      payloadJson: JSON.stringify(payload),
    });
    await handler.processWebhookEvent(stored.id);

    const issue = db.getIssue("krasnoperov/mafia", "issue-maf-adopt-review");
    assert.equal(issue?.delegatedToPatchRelay, true);
    assertIssuePhase(issue, "changes_requested");
    assert.equal(issue?.prNumber, 124);
    assert.equal(issue?.branchName, "feat-existing-pr");
    assert.equal(issue?.prHeadSha, "sha-linked-review");
    assert.equal(issue?.prReviewState, "changes_requested");
    assert.equal(issue?.prCheckStatus, "success");
    assert.equal(issue?.prIsDraft, false);
    assert.equal(db.issueSessions.peekPendingSessionInputPlanForDiagnostics("krasnoperov/mafia", "issue-maf-adopt-review")?.runType, "review_fix");
    assert.deepEqual(enqueued, [{ projectId: "krasnoperov/mafia", issueId: "issue-maf-adopt-review" }]);
  } finally {
    restorePath();
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("statusChanged adopts a linked same-repo PR before starting implementation", { concurrency: false }, async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-webhook-linked-pr-status-"));
  const restorePath = installFakeGh(
    baseDir,
    JSON.stringify({
      url: "https://github.com/krasnoperov/mafia/pull/224",
      body: "Linear: MAF-224",
      headRefName: "fix/existing-review-repair",
      headRefOid: "sha-linked-status-review",
      isDraft: false,
      isCrossRepository: false,
      state: "OPEN",
      author: { login: "external-dev" },
      reviewDecision: "CHANGES_REQUESTED",
      mergeable: "MERGEABLE",
      mergeStateStatus: "BLOCKED",
      statusCheckRollup: [{ __typename: "CheckRun", name: "verify", status: "COMPLETED", conclusion: "SUCCESS" }],
    }),
  );
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

    const linearClient: Partial<LinearClient> = {
      getIssue: async () => createHydratedIssueSnapshot({
        id: "issue-maf-adopt-status",
        identifier: "MAF-224",
        title: "Repair existing linked PR",
        delegateId: "patchrelay-actor",
        attachments: [{
          id: "attachment-224",
          title: "GitHub PR #224",
          url: "https://github.com/krasnoperov/mafia/pull/224",
        }],
      }),
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

    const payload: LinearWebhookPayload = {
      action: "update",
      type: "Issue",
      createdAt: "2026-04-01T00:00:00.000Z",
      webhookTimestamp: Date.now(),
      updatedFrom: { stateId: "state-backlog" },
      data: {
        id: "issue-maf-adopt-status",
        identifier: "MAF-224",
        title: "Repair existing linked PR",
        team: { id: "team-maf", key: "MAF" },
        state: { id: "state-start", name: "In Progress", type: "started" },
        delegate: { id: "patchrelay-actor", name: "PatchRelay" },
      },
    };

    const stored = db.webhookEvents.insertFullWebhookEvent({
      webhookId: "delivery-adopt-status",
      receivedAt: new Date().toISOString(),
      payloadJson: JSON.stringify(payload),
    });
    await handler.processWebhookEvent(stored.id);

    const issue = db.getIssue("krasnoperov/mafia", "issue-maf-adopt-status");
    assert.equal(issue?.delegatedToPatchRelay, true);
    assertIssuePhase(issue, "changes_requested");
    assert.equal(issue?.prNumber, 224);
    assert.equal(issue?.branchName, "fix/existing-review-repair");
    assert.equal(issue?.prHeadSha, "sha-linked-status-review");
    assert.equal(issue?.prReviewState, "changes_requested");
    assert.equal(db.issueSessions.peekPendingSessionInputPlanForDiagnostics("krasnoperov/mafia", "issue-maf-adopt-status")?.runType, "review_fix");
    assert.deepEqual(enqueued, [{ projectId: "krasnoperov/mafia", issueId: "issue-maf-adopt-status" }]);
  } finally {
    restorePath();
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("delegateChanged adopts a linked same-repo PR with failing CI", { concurrency: false }, async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-webhook-linked-pr-ci-"));
  const restorePath = installFakeGh(
    baseDir,
    JSON.stringify({
      url: "https://github.com/krasnoperov/mafia/pull/125",
      body: "Linear: MAF-125",
      headRefName: "feat-linked-ci",
      headRefOid: "sha-linked-ci",
      isDraft: false,
      isCrossRepository: false,
      state: "OPEN",
      author: { login: "external-dev" },
      reviewDecision: "REVIEW_REQUIRED",
      mergeable: "MERGEABLE",
      mergeStateStatus: "BLOCKED",
      statusCheckRollup: [{ __typename: "CheckRun", name: "verify", status: "COMPLETED", conclusion: "FAILURE" }],
    }),
  );
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

    const linearClient: Partial<LinearClient> = {
      getIssue: async () => createHydratedIssueSnapshot({
        id: "issue-maf-adopt-ci",
        identifier: "MAF-125",
        title: "Adopt linked CI PR",
        delegateId: "patchrelay-actor",
        attachments: [{
          id: "attachment-125",
          title: "GitHub PR #125",
          url: "https://github.com/krasnoperov/mafia/pull/125",
        }],
      }),
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

    const payload: LinearWebhookPayload = {
      action: "update",
      type: "Issue",
      createdAt: "2026-04-01T00:00:00.000Z",
      webhookTimestamp: Date.now(),
      updatedFrom: { delegateId: null },
      data: {
        id: "issue-maf-adopt-ci",
        identifier: "MAF-125",
        title: "Adopt linked CI PR",
        team: { id: "team-maf", key: "MAF" },
        state: { id: "state-start", name: "In Progress", type: "started" },
        delegate: { id: "patchrelay-actor", name: "PatchRelay" },
      },
    };

    const stored = db.webhookEvents.insertFullWebhookEvent({
      webhookId: "delivery-adopt-ci",
      receivedAt: new Date().toISOString(),
      payloadJson: JSON.stringify(payload),
    });
    await handler.processWebhookEvent(stored.id);

    const issue = db.getIssue("krasnoperov/mafia", "issue-maf-adopt-ci");
    assertIssuePhase(issue, "repairing_ci");
    assert.equal(issue?.prCheckStatus, "failure");
    assert.equal(db.issueSessions.peekPendingSessionInputPlanForDiagnostics("krasnoperov/mafia", "issue-maf-adopt-ci")?.runType, "ci_repair");
    assert.deepEqual(enqueued, [{ projectId: "krasnoperov/mafia", issueId: "issue-maf-adopt-ci" }]);
  } finally {
    restorePath();
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("delegateChanged adopts a linked draft PR as implementation work", { concurrency: false }, async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-webhook-linked-pr-draft-"));
  const restorePath = installFakeGh(
    baseDir,
    JSON.stringify({
      url: "https://github.com/krasnoperov/mafia/pull/126",
      body: "Linear: MAF-126",
      headRefName: "feat-linked-draft",
      headRefOid: "sha-linked-draft",
      isDraft: true,
      isCrossRepository: false,
      state: "OPEN",
      author: { login: "external-dev" },
      reviewDecision: "REVIEW_REQUIRED",
      mergeable: "MERGEABLE",
      mergeStateStatus: "BLOCKED",
      statusCheckRollup: [{ __typename: "CheckRun", name: "verify", status: "IN_PROGRESS", conclusion: null }],
    }),
  );
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

    const linearClient: Partial<LinearClient> = {
      getIssue: async () => createHydratedIssueSnapshot({
        id: "issue-maf-adopt-draft",
        identifier: "MAF-126",
        title: "Adopt linked draft PR",
        delegateId: "patchrelay-actor",
        attachments: [{
          id: "attachment-126",
          title: "GitHub PR #126",
          url: "https://github.com/krasnoperov/mafia/pull/126",
        }],
      }),
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

    const payload: LinearWebhookPayload = {
      action: "update",
      type: "Issue",
      createdAt: "2026-04-01T00:00:00.000Z",
      webhookTimestamp: Date.now(),
      updatedFrom: { delegateId: null },
      data: {
        id: "issue-maf-adopt-draft",
        identifier: "MAF-126",
        title: "Adopt linked draft PR",
        team: { id: "team-maf", key: "MAF" },
        state: { id: "state-start", name: "In Progress", type: "started" },
        delegate: { id: "patchrelay-actor", name: "PatchRelay" },
      },
    };

    const stored = db.webhookEvents.insertFullWebhookEvent({
      webhookId: "delivery-adopt-draft",
      receivedAt: new Date().toISOString(),
      payloadJson: JSON.stringify(payload),
    });
    await handler.processWebhookEvent(stored.id);

    const issue = db.getIssue("krasnoperov/mafia", "issue-maf-adopt-draft");
    assertIssuePhase(issue, "delegated");
    assert.equal(issue?.prIsDraft, true);
    assert.equal(issue?.branchName, "feat-linked-draft");
    // drives a durable run:implementation workflow task (the session input below
    // is diagnostic dual-path only).
    const implementationTask = db.workflowTasks.listOpenRunnableTasks("krasnoperov/mafia")
      .filter((task) => task.subjectId === "issue-maf-adopt-draft" && task.taskId === "run:implementation");
    assert.equal(implementationTask.length, 1);
    assert.equal(db.issueSessions.peekPendingSessionInputPlanForDiagnostics("krasnoperov/mafia", "issue-maf-adopt-draft")?.runType, "implementation");
    assert.deepEqual(enqueued, [{ projectId: "krasnoperov/mafia", issueId: "issue-maf-adopt-draft" }]);
  } finally {
    restorePath();
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("delegateChanged adopts a linked closed same-repo PR as replacement implementation work", { concurrency: false }, async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-webhook-linked-pr-closed-"));
  const restorePath = installFakeGh(
    baseDir,
    JSON.stringify({
      url: "https://github.com/krasnoperov/mafia/pull/1260",
      body: "Linear: MAF-1260",
      headRefName: "feat-linked-closed",
      headRefOid: "sha-linked-closed",
      isDraft: false,
      isCrossRepository: false,
      state: "CLOSED",
      author: { login: "external-dev" },
      reviewDecision: "CHANGES_REQUESTED",
      mergeable: "MERGEABLE",
      mergeStateStatus: "BLOCKED",
      statusCheckRollup: [{ __typename: "CheckRun", name: "verify", status: "COMPLETED", conclusion: "SUCCESS" }],
    }),
  );
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

    const linearClient: Partial<LinearClient> = {
      getIssue: async () => createHydratedIssueSnapshot({
        id: "issue-maf-adopt-closed",
        identifier: "MAF-1260",
        title: "Adopt linked closed PR",
        delegateId: "patchrelay-actor",
        attachments: [{
          id: "attachment-1260",
          title: "GitHub PR #1260",
          url: "https://github.com/krasnoperov/mafia/pull/1260",
        }],
      }),
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

    const payload: LinearWebhookPayload = {
      action: "update",
      type: "Issue",
      createdAt: "2026-04-01T00:00:00.000Z",
      webhookTimestamp: Date.now(),
      updatedFrom: { delegateId: null },
      data: {
        id: "issue-maf-adopt-closed",
        identifier: "MAF-1260",
        title: "Adopt linked closed PR",
        team: { id: "team-maf", key: "MAF" },
        state: { id: "state-start", name: "In Progress", type: "started" },
        delegate: { id: "patchrelay-actor", name: "PatchRelay" },
      },
    };

    const stored = db.webhookEvents.insertFullWebhookEvent({
      webhookId: "delivery-adopt-closed",
      receivedAt: new Date().toISOString(),
      payloadJson: JSON.stringify(payload),
    });
    await handler.processWebhookEvent(stored.id);

    const issue = db.getIssue("krasnoperov/mafia", "issue-maf-adopt-closed");
    assertIssuePhase(issue, "delegated");
    assert.equal(issue?.prNumber, 1260);
    assert.equal(issue?.prState, "closed");
    assert.equal(db.issueSessions.peekPendingSessionInputPlanForDiagnostics("krasnoperov/mafia", "issue-maf-adopt-closed")?.runType, "implementation");
    assert.deepEqual(enqueued, [{ projectId: "krasnoperov/mafia", issueId: "issue-maf-adopt-closed" }]);
  } finally {
    restorePath();
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("delegateChanged moves linked cross-repo PR adoption to awaiting_input", { concurrency: false }, async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-webhook-linked-pr-cross-repo-"));
  const restorePath = installFakeGh(
    baseDir,
    JSON.stringify({
      url: "https://github.com/krasnoperov/mafia/pull/127",
      body: "Linear: MAF-127",
      headRefName: "feat-linked-fork",
      headRefOid: "sha-linked-fork",
      isDraft: false,
      isCrossRepository: true,
      state: "OPEN",
      author: { login: "external-dev" },
      reviewDecision: "CHANGES_REQUESTED",
      mergeable: "MERGEABLE",
      mergeStateStatus: "BLOCKED",
      statusCheckRollup: [{ __typename: "CheckRun", name: "verify", status: "COMPLETED", conclusion: "SUCCESS" }],
    }),
  );
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

    const linearClient: Partial<LinearClient> = {
      getIssue: async () => createHydratedIssueSnapshot({
        id: "issue-maf-adopt-cross",
        identifier: "MAF-127",
        title: "Adopt linked fork PR",
        delegateId: "patchrelay-actor",
        attachments: [{
          id: "attachment-127",
          title: "GitHub PR #127",
          url: "https://github.com/krasnoperov/mafia/pull/127",
        }],
      }),
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

    const payload: LinearWebhookPayload = {
      action: "update",
      type: "Issue",
      createdAt: "2026-04-01T00:00:00.000Z",
      webhookTimestamp: Date.now(),
      updatedFrom: { delegateId: null },
      data: {
        id: "issue-maf-adopt-cross",
        identifier: "MAF-127",
        title: "Adopt linked fork PR",
        team: { id: "team-maf", key: "MAF" },
        state: { id: "state-start", name: "In Progress", type: "started" },
        delegate: { id: "patchrelay-actor", name: "PatchRelay" },
      },
    };

    const stored = db.webhookEvents.insertFullWebhookEvent({
      webhookId: "delivery-adopt-cross",
      receivedAt: new Date().toISOString(),
      payloadJson: JSON.stringify(payload),
    });
    await handler.processWebhookEvent(stored.id);

    const issue = db.getIssue("krasnoperov/mafia", "issue-maf-adopt-cross");
    assertIssuePhase(issue, "awaiting_input");
    assert.equal(issue?.prNumber, 127);
    assert.equal(db.issueSessions.peekPendingSessionInputPlanForDiagnostics("krasnoperov/mafia", "issue-maf-adopt-cross"), undefined);
    assert.deepEqual(enqueued, []);
  } finally {
    restorePath();
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("delegateChanged rejects ambiguous multiple PR attachments instead of guessing ownership", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-webhook-linked-pr-ambiguous-"));
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

    const linearClient: Partial<LinearClient> = {
      getIssue: async () => createHydratedIssueSnapshot({
        id: "issue-maf-adopt-ambiguous",
        identifier: "MAF-128",
        title: "Adopt ambiguous PR links",
        delegateId: "patchrelay-actor",
        attachments: [
          { id: "attachment-128a", title: "GitHub PR #128", url: "https://github.com/krasnoperov/mafia/pull/128" },
          { id: "attachment-128b", title: "GitHub PR #129", url: "https://github.com/krasnoperov/mafia/pull/129" },
        ],
      }),
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

    const payload: LinearWebhookPayload = {
      action: "update",
      type: "Issue",
      createdAt: "2026-04-01T00:00:00.000Z",
      webhookTimestamp: Date.now(),
      updatedFrom: { delegateId: null },
      data: {
        id: "issue-maf-adopt-ambiguous",
        identifier: "MAF-128",
        title: "Adopt ambiguous PR links",
        team: { id: "team-maf", key: "MAF" },
        state: { id: "state-start", name: "In Progress", type: "started" },
        delegate: { id: "patchrelay-actor", name: "PatchRelay" },
      },
    };

    const stored = db.webhookEvents.insertFullWebhookEvent({
      webhookId: "delivery-adopt-ambiguous",
      receivedAt: new Date().toISOString(),
      payloadJson: JSON.stringify(payload),
    });
    await handler.processWebhookEvent(stored.id);

    const issue = db.getIssue("krasnoperov/mafia", "issue-maf-adopt-ambiguous");
    assertIssuePhase(issue, "awaiting_input");
    assert.equal(db.workflowTasks.listOpenRunnableTasks("krasnoperov/mafia")
      .some((task) => task.subjectId === "issue-maf-adopt-ambiguous" && task.taskId === "run:implementation"), false);
    assert.deepEqual(enqueued, []);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("later issue webhooks recover missed re-delegation from live Linear delegate state", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-webhook-redelegate-repair-"));
  try {
    const config = createConfig(baseDir);
    config.projects[0] = {
      ...config.projects[0]!,
      triggerEvents: [...config.projects[0]!.triggerEvents, "commentUpdated"],
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
      linearIssueId: "issue-maf-52c",
      issueKey: "MAF-52C",
      title: "Repair missed re-delegation",
      delegatedToPatchRelay: false,
      workflowOutcome: "escalated",
      prNumber: 122,
      prState: "open",
      prHeadSha: "sha-redelegate-repair-review",
      prReviewState: "changes_requested",
    });

    const linearClient: Partial<LinearClient> = {
      getIssue: async (issueId: string) => {
        assert.equal(issueId, "issue-maf-52c");
        return {
          id: "issue-maf-52c",
          identifier: "MAF-52C",
          title: "Repair missed re-delegation",
          teamId: "team-maf",
          teamKey: "MAF",
          delegateId: "patchrelay-actor",
          stateId: "state-start",
          stateName: "In Progress",
          stateType: "started",
          workflowStates: [],
          labelIds: [],
          labels: [],
          teamLabels: [],
          blockedBy: [],
          blocks: [],
        };
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

    const payload: LinearWebhookPayload = {
      action: "update",
      type: "Comment",
      createdAt: "2026-04-01T00:00:00.000Z",
      webhookTimestamp: Date.now(),
      data: {
        id: "comment-redelegate-repair",
        body: "PatchRelay, please continue on the latest review.",
        user: { name: "Alex Operator" },
        issue: {
          id: "issue-maf-52c",
          identifier: "MAF-52C",
          title: "Repair missed re-delegation",
          team: { id: "team-maf", key: "MAF" },
          state: { id: "state-start", name: "In Progress", type: "started" },
        },
      },
    };

    const stored = db.webhookEvents.insertFullWebhookEvent({
      webhookId: "delivery-redelegate-repair",
      receivedAt: new Date().toISOString(),
      payloadJson: JSON.stringify(payload),
    });

    await handler.processWebhookEvent(stored.id);

    const issue = db.getIssue("krasnoperov/mafia", "issue-maf-52c");
    assert.equal(issue?.delegatedToPatchRelay, true);
    assertIssuePhase(issue, "changes_requested");
    const workflowTask = db.issueSessions.peekPendingSessionInputPlanForDiagnostics("krasnoperov/mafia", "issue-maf-52c");
    assert.equal(workflowTask?.runType, "review_fix");
    // The recovery comment must enqueue the re-delegated issue so the
    // orchestrator picks up the captured workflowTask on the next drain. The
    // SerialWorkQueue dedupes if other passes also enqueue.
    assert.deepEqual(enqueued, [{ projectId: "krasnoperov/mafia", issueId: "issue-maf-52c" }]);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("re-delegation preserves completion-check questions instead of restarting implementation", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-webhook-redelegate-completion-check-"));
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

    const issue = db.upsertIssue({
      projectId: "krasnoperov/mafia",
      linearIssueId: "issue-maf-52b",
      issueKey: "MAF-52B",
      title: "Needs product answer",
      delegatedToPatchRelay: false,
      inputRequestKind: "completion_check_question",
    });
    const run = db.runs.createRun({
      issueId: issue.id,
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      runType: "implementation",
      promptText: "Ship it",
    });
    db.runs.finishRun(run.id, {
      status: "completed",
      summaryJson: JSON.stringify({ latestAssistantMessage: "I need approval before continuing." }),
    });
    db.runs.saveCompletionCheck(run.id, {
      outcome: "needs_input",
      summary: "Approval is required before continuing.",
      question: "Approve the product direction?",
      why: "The issue leaves an important product choice unresolved.",
      recommendedReply: "Approved: continue with the proposed direction.",
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
      updatedFrom: { delegateId: null },
      data: {
        id: "issue-maf-52b",
        identifier: "MAF-52B",
        title: "Needs product answer",
        team: { id: "team-maf", key: "MAF" },
        state: { id: "state-start", name: "Start", type: "started" },
        delegate: { id: "patchrelay-actor", name: "PatchRelay" },
      },
    };

    const stored = db.webhookEvents.insertFullWebhookEvent({
      webhookId: "delivery-redelegate-52b",
      receivedAt: new Date().toISOString(),
      payloadJson: JSON.stringify(payload),
    });

    await handler.processWebhookEvent(stored.id);

    const updatedIssue = db.getIssue("krasnoperov/mafia", "issue-maf-52b");
    assert.equal(updatedIssue?.delegatedToPatchRelay, true);
    assertIssuePhase(updatedIssue, "awaiting_input");
    assert.equal(db.issueSessions.peekPendingSessionInputPlanForDiagnostics("krasnoperov/mafia", "issue-maf-52b"), undefined);
    assert.deepEqual(enqueued, []);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("re-delegation resumes paused local work from implementing state", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-webhook-redelegate-paused-local-work-"));
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
      linearIssueId: "issue-maf-52c",
      issueKey: "MAF-52C",
      title: "Resume paused implementation",
      delegatedToPatchRelay: false,
      workflowOutcome: undefined,
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
      updatedFrom: { delegateId: null },
      data: {
        id: "issue-maf-52c",
        identifier: "MAF-52C",
        title: "Resume paused implementation",
        team: { id: "team-maf", key: "MAF" },
        state: { id: "state-start", name: "Start", type: "started" },
        delegate: { id: "patchrelay-actor", name: "PatchRelay" },
      },
    };

    const stored = db.webhookEvents.insertFullWebhookEvent({
      webhookId: "delivery-redelegate-52c",
      receivedAt: new Date().toISOString(),
      payloadJson: JSON.stringify(payload),
    });

    await handler.processWebhookEvent(stored.id);

    const issue = db.getIssue("krasnoperov/mafia", "issue-maf-52c");
    assert.equal(issue?.delegatedToPatchRelay, true);
    assertIssuePhase(issue, "delegated");
    const workflowTask = db.issueSessions.peekPendingSessionInputPlanForDiagnostics("krasnoperov/mafia", "issue-maf-52c");
    assert.equal(workflowTask?.runType, "implementation");
    assert.deepEqual(enqueued, [{ projectId: "krasnoperov/mafia", issueId: "issue-maf-52c" }]);
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
      workflowOutcome: undefined,
    });
    const run = db.runs.createRun({
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

    const stored = db.webhookEvents.insertFullWebhookEvent({
      webhookId: "delivery-remove-52",
      receivedAt: new Date().toISOString(),
      payloadJson: JSON.stringify(payload),
    });

    await handler.processWebhookEvent(stored.id);

    const issue = db.getIssue("krasnoperov/mafia", "issue-maf-52");
    assertIssuePhase(issue, "failed");
    assert.equal(issue?.activeRunId, undefined);

    const finishedRun = db.runs.getRunById(run.id);
    assert.equal(finishedRun?.status, "released");
    assert.ok(finishedRun?.failureReason?.includes("removed"));
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("issueRemoved without an active run marks the issue failed and clears pending workflow tasks", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-webhook-removed-idle-"));
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
      linearIssueId: "issue-maf-53",
      issueKey: "MAF-53",
      title: "Removed while idle",
      workflowOutcome: undefined,
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
        id: "issue-maf-53",
        identifier: "MAF-53",
        title: "Removed while idle",
        team: { id: "team-maf", key: "MAF" },
        state: { id: "state-start", name: "In Progress", type: "started" },
      },
    };

    const stored = db.webhookEvents.insertFullWebhookEvent({
      webhookId: "delivery-remove-idle-53",
      receivedAt: new Date().toISOString(),
      payloadJson: JSON.stringify(payload),
    });

    await handler.processWebhookEvent(stored.id);

    const issue = db.getIssue("krasnoperov/mafia", "issue-maf-53");
    assertIssuePhase(issue, "failed");
    assert.equal(db.issueSessions.peekPendingSessionInputPlanForDiagnostics("krasnoperov/mafia", "issue-maf-53"), undefined);
    assert.equal(db.issueSessions.listIssueSessionEvents("krasnoperov/mafia", "issue-maf-53", { pendingOnly: true }).length, 0);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("idle delegated comments with explicit PatchRelay intent queue a follow-up session event instead of rewriting pending context", async () => {
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
      workflowOutcome: undefined,
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
        body: "PatchRelay, please keep this compatible with the old contract.",
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

    const stored = db.webhookEvents.insertFullWebhookEvent({
      webhookId: "delivery-comment-followup",
      receivedAt: new Date().toISOString(),
      payloadJson: JSON.stringify(payload),
    });
    await handler.processWebhookEvent(stored.id);

    const workflowTask = db.issueSessions.peekPendingSessionInputPlanForDiagnostics("krasnoperov/mafia", "issue-maf-comment");
    assert.equal(workflowTask?.runType, "implementation");
    assert.equal(Array.isArray(workflowTask?.context.followUps), true);
    assert.equal(workflowTask?.context.followUps?.[0]?.text, "please keep this compatible with the old contract.");
    assert.deepEqual(enqueued, [{ projectId: "krasnoperov/mafia", issueId: "issue-maf-comment" }]);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("idle comments without explicit PatchRelay intent are ignored", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-webhook-comment-ignored-"));
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
      linearIssueId: "issue-maf-comment-ignored",
      issueKey: "MAF-91C",
      title: "Commentable issue",
      currentLinearState: "Review",
      currentLinearStateType: "started",
      workflowOutcome: undefined,
      prNumber: 92,
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
        id: "user-3",
        name: "Taylor Operator",
        email: "taylor@example.com",
        type: "User",
      } as unknown as Record<string, unknown>,
      data: {
        id: "comment-ignored-1",
        body: "Please keep this compatible with the old contract.",
        user: { name: "Taylor Operator" },
        issue: {
          id: "issue-maf-comment-ignored",
          identifier: "MAF-91C",
          title: "Commentable issue",
          team: { id: "team-maf", key: "MAF" },
          state: { id: "state-review", name: "Review", type: "started" },
          delegate: { id: "patchrelay-actor", name: "PatchRelay" },
        },
      },
    };

    const stored = db.webhookEvents.insertFullWebhookEvent({
      webhookId: "delivery-comment-ignored",
      receivedAt: new Date().toISOString(),
      payloadJson: JSON.stringify(payload),
    });
    await handler.processWebhookEvent(stored.id);

    assert.equal(db.issueSessions.peekPendingSessionInputPlanForDiagnostics("krasnoperov/mafia", "issue-maf-comment-ignored"), undefined);
    assert.equal(db.issueSessions.listIssueSessionEvents("krasnoperov/mafia", "issue-maf-comment-ignored").length, 0);
    assert.deepEqual(enqueued, []);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("idle delegated comments with PatchRelay status intent do not queue implementation", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-webhook-comment-status-intent-"));
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
      linearIssueId: "issue-maf-comment-status",
      issueKey: "MAF-91G",
      title: "Comment status issue",
      currentLinearState: "Review",
      currentLinearStateType: "started",
      workflowOutcome: undefined,
      prNumber: 93,
    });

    const enqueued: Array<{ projectId: string; issueId: string }> = [];
    const handler = new WebhookHandler(
      config,
      db,
      { forProject: async () => undefined } as never,
      { steerTurn: async () => undefined } as never,
      (projectId, issueId) => { enqueued.push({ projectId, issueId }); },
      pino({ enabled: false }),
      undefined,
      fakeFollowupClassifier("status"),
    );

    const payload: LinearWebhookPayload = {
      action: "create",
      type: "Comment",
      createdAt: "2026-04-01T02:02:00.000Z",
      webhookTimestamp: Date.now(),
      actor: {
        id: "user-5",
        name: "Riley Operator",
        email: "riley@example.com",
        type: "User",
      } as unknown as Record<string, unknown>,
      data: {
        id: "comment-status-2",
        body: "PatchRelay, what's the status?",
        user: { name: "Riley Operator" },
        issue: {
          id: "issue-maf-comment-status",
          identifier: "MAF-91G",
          title: "Comment status issue",
          team: { id: "team-maf", key: "MAF" },
          state: { id: "state-review", name: "Review", type: "started" },
          delegate: { id: "patchrelay-actor", name: "PatchRelay" },
        },
      },
    };

    const stored = db.webhookEvents.insertFullWebhookEvent({
      webhookId: "delivery-comment-status-intent",
      receivedAt: new Date().toISOString(),
      payloadJson: JSON.stringify(payload),
    });
    await handler.processWebhookEvent(stored.id);

    assert.equal(db.issueSessions.peekPendingSessionInputPlanForDiagnostics("krasnoperov/mafia", "issue-maf-comment-status"), undefined);
    assert.equal(db.issueSessions.listIssueSessionEvents("krasnoperov/mafia", "issue-maf-comment-status").length, 0);
    assert.deepEqual(enqueued, []);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("awaiting_input issue comments without explicit PatchRelay address are ignored", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-webhook-comment-awaiting-input-ignored-"));
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
      linearIssueId: "issue-maf-awaiting-input-ignored",
      issueKey: "MAF-91F",
      title: "Awaiting input issue",
      currentLinearState: "Needs input",
      currentLinearStateType: "unstarted",
      inputRequestKind: "completion_check_question",
      threadId: "thread-awaiting-input-ignored",
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
      createdAt: "2026-04-01T02:10:00.000Z",
      webhookTimestamp: Date.now(),
      actor: {
        id: "user-4",
        name: "Jordan Reviewer",
        email: "jordan@example.com",
        type: "User",
      } as unknown as Record<string, unknown>,
      data: {
        id: "comment-awaiting-input-ignored",
        body: "Please keep the current API surface intact.",
        user: { name: "Jordan Reviewer" },
        issue: {
          id: "issue-maf-awaiting-input-ignored",
          identifier: "MAF-91F",
          title: "Awaiting input issue",
          team: { id: "team-maf", key: "MAF" },
          state: { id: "state-input", name: "Needs input", type: "unstarted" },
          delegate: { id: "patchrelay-actor", name: "PatchRelay" },
        },
      },
    };

    const stored = db.webhookEvents.insertFullWebhookEvent({
      webhookId: "delivery-awaiting-input-comment-ignored",
      receivedAt: new Date().toISOString(),
      payloadJson: JSON.stringify(payload),
    });
    await handler.processWebhookEvent(stored.id);

    const workflowTask = db.issueSessions.peekPendingSessionInputPlanForDiagnostics("krasnoperov/mafia", "issue-maf-awaiting-input-ignored");
    const events = db.issueSessions.listIssueSessionEvents("krasnoperov/mafia", "issue-maf-awaiting-input-ignored");
    assert.equal(workflowTask, undefined);
    assert.deepEqual(
      events.map((event) => event.eventType).filter((eventType) => eventType === "followup_comment" || eventType === "direct_reply"),
      [],
    );
    assert.deepEqual(enqueued, []);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("explicit PatchRelay comments on awaiting_input resume work as direct replies on the same thread", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-webhook-awaiting-input-comment-"));
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
      linearIssueId: "issue-maf-awaiting-input",
      issueKey: "MAF-91A",
      title: "Needs operator reply",
      currentLinearState: "Needs input",
      currentLinearStateType: "unstarted",
      inputRequestKind: "completion_check_question",
      threadId: "thread-awaiting-input",
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
      createdAt: "2026-04-01T02:05:00.000Z",
      webhookTimestamp: Date.now(),
      actor: {
        id: "user-2",
        name: "Jamie Operator",
        email: "jamie@example.com",
        type: "User",
      } as unknown as Record<string, unknown>,
      data: {
        id: "comment-2",
        body: "PatchRelay, use the staged rollout copy, not the earlier draft.",
        user: { name: "Jamie Operator" },
        issue: {
          id: "issue-maf-awaiting-input",
          identifier: "MAF-91A",
          title: "Needs operator reply",
          team: { id: "team-maf", key: "MAF" },
          state: { id: "state-input", name: "Needs input", type: "unstarted" },
          delegate: { id: "patchrelay-actor", name: "PatchRelay" },
        },
      },
    };

    const stored = db.webhookEvents.insertFullWebhookEvent({
      webhookId: "delivery-awaiting-input-comment",
      receivedAt: new Date().toISOString(),
      payloadJson: JSON.stringify(payload),
    });
    await handler.processWebhookEvent(stored.id);

    const workflowTask = db.issueSessions.peekPendingSessionInputPlanForDiagnostics("krasnoperov/mafia", "issue-maf-awaiting-input");
    assert.equal(workflowTask?.runType, "implementation");
    assert.equal(workflowTask?.resumeThread, true);
    assert.equal(workflowTask?.workflowReason, "direct_reply");
    assert.equal(workflowTask?.context.directReplyMode, true);
    assert.equal(workflowTask?.context.followUps?.[0]?.text, "use the staged rollout copy, not the earlier draft.");
    assert.deepEqual(enqueued, [{ projectId: "krasnoperov/mafia", issueId: "issue-maf-awaiting-input" }]);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("explicit PatchRelay answers to outstanding questions are classified as direct replies", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-webhook-direct-reply-"));
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
    const issue = db.upsertIssue({
      projectId: "krasnoperov/mafia",
      linearIssueId: "issue-maf-direct-reply",
      issueKey: "MAF-91B",
      title: "Needs direct answer",
      currentLinearState: "Needs input",
      currentLinearStateType: "unstarted",
      inputRequestKind: "completion_check_question",
      threadId: "thread-direct-reply",
    });
    const run = db.runs.createRun({
      issueId: issue.id,
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      runType: "implementation",
      promptText: "Which rollout copy should I use?",
    });
    db.runs.finishRun(run.id, {
      status: "completed",
      summaryJson: JSON.stringify({ latestAssistantMessage: "Which rollout copy should I use?" }),
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
      createdAt: "2026-04-01T02:05:00.000Z",
      webhookTimestamp: Date.now(),
      actor: {
        id: "user-2",
        name: "Jamie Operator",
        email: "jamie@example.com",
        type: "User",
      } as unknown as Record<string, unknown>,
      data: {
        id: "comment-direct-reply",
        body: "@PatchRelay use the staged rollout copy.",
        user: { name: "Jamie Operator" },
        issue: {
          id: "issue-maf-direct-reply",
          identifier: "MAF-91B",
          title: "Needs direct answer",
          team: { id: "team-maf", key: "MAF" },
          state: { id: "state-input", name: "Needs input", type: "unstarted" },
          delegate: { id: "patchrelay-actor", name: "PatchRelay" },
        },
      },
    };

    const stored = db.webhookEvents.insertFullWebhookEvent({
      webhookId: "delivery-direct-reply-comment",
      receivedAt: new Date().toISOString(),
      payloadJson: JSON.stringify(payload),
    });
    await handler.processWebhookEvent(stored.id);

    const workflowTask = db.issueSessions.peekPendingSessionInputPlanForDiagnostics("krasnoperov/mafia", "issue-maf-direct-reply");
    assert.equal(workflowTask?.workflowReason, "direct_reply");
    assert.equal(workflowTask?.resumeThread, true);
    assert.equal(workflowTask?.context.directReplyMode, true);
    assert.equal(workflowTask?.context.followUps?.[0]?.text, "use the staged rollout copy.");
    assert.deepEqual(enqueued, [{ projectId: "krasnoperov/mafia", issueId: "issue-maf-direct-reply" }]);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("PatchRelay-authored comments are recorded as inert session events without enqueueing work", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-webhook-self-comment-"));
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
      linearIssueId: "issue-maf-self-comment",
      issueKey: "MAF-91B",
      title: "Self comment issue",
      currentLinearState: "Review",
      currentLinearStateType: "started",
      workflowOutcome: undefined,
      prNumber: 911,
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
      createdAt: "2026-04-01T02:05:00.000Z",
      webhookTimestamp: Date.now(),
      actor: {
        id: "patchrelay-actor",
        name: "PatchRelay",
        email: "patchrelay@example.com",
        type: "Application",
      } as unknown as Record<string, unknown>,
      data: {
        id: "comment-self-1",
        body: "PatchRelay status update",
        user: { name: "PatchRelay" },
        issue: {
          id: "issue-maf-self-comment",
          identifier: "MAF-91B",
          title: "Self comment issue",
          team: { id: "team-maf", key: "MAF" },
          state: { id: "state-review", name: "Review", type: "started" },
          delegate: { id: "patchrelay-actor", name: "PatchRelay" },
        },
      },
    };

    const stored = db.webhookEvents.insertFullWebhookEvent({
      webhookId: "delivery-self-comment",
      receivedAt: new Date().toISOString(),
      payloadJson: JSON.stringify(payload),
    });
    await handler.processWebhookEvent(stored.id);

    const events = db.issueSessions.listIssueSessionEvents("krasnoperov/mafia", "issue-maf-self-comment");
    assert.equal(events.length, 1);
    assert.equal(events[0]?.eventType, "self_comment");
    assert.equal(db.issueSessions.peekPendingSessionInputPlanForDiagnostics("krasnoperov/mafia", "issue-maf-self-comment"), undefined);
    assert.deepEqual(enqueued, []);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("PatchRelay managed status comment updates stay inert even when the webhook actor is not PatchRelay", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-webhook-managed-status-comment-"));
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
      linearIssueId: "issue-maf-managed-status",
      issueKey: "MAF-91D",
      title: "Managed status issue",
      currentLinearState: "Review",
      currentLinearStateType: "started",
      workflowOutcome: undefined,
      prNumber: 912,
      statusCommentId: "comment-status-1",
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
      type: "Comment",
      createdAt: "2026-04-01T02:06:00.000Z",
      webhookTimestamp: Date.now(),
      actor: {
        id: "linear-system",
        name: "Linear",
        email: "system@example.com",
        type: "Application",
      } as unknown as Record<string, unknown>,
      data: {
        id: "comment-status-1",
        body: [
          "## PatchRelay status",
          "",
          "PatchRelay is waiting on review.",
          "",
          "_PatchRelay updates this comment as it works. Review and merge remain downstream._",
        ].join("\n"),
        user: { name: "Linear" },
        issue: {
          id: "issue-maf-managed-status",
          identifier: "MAF-91D",
          title: "Managed status issue",
          team: { id: "team-maf", key: "MAF" },
          state: { id: "state-review", name: "Review", type: "started" },
          delegate: { id: "patchrelay-actor", name: "PatchRelay" },
        },
      },
    };

    const stored = db.webhookEvents.insertFullWebhookEvent({
      webhookId: "delivery-managed-status-comment",
      receivedAt: new Date().toISOString(),
      payloadJson: JSON.stringify(payload),
    });
    await handler.processWebhookEvent(stored.id);

    const events = db.issueSessions.listIssueSessionEvents("krasnoperov/mafia", "issue-maf-managed-status");
    assert.equal(events.length, 1);
    assert.equal(events[0]?.eventType, "self_comment");
    assert.equal(db.issueSessions.peekPendingSessionInputPlanForDiagnostics("krasnoperov/mafia", "issue-maf-managed-status"), undefined);
    assert.deepEqual(enqueued, []);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("PatchRelay-generated escalation activity comments stay inert even when Linear reports PatchRelay as a user actor", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-webhook-escalation-comment-"));
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
      linearIssueId: "issue-maf-escalation-comment",
      issueKey: "MAF-91E",
      title: "Escalated issue",
      currentLinearState: "Review",
      currentLinearStateType: "started",
      workflowOutcome: undefined,
      prNumber: 913,
      prReviewState: "changes_requested",
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
      createdAt: "2026-04-01T02:07:00.000Z",
      webhookTimestamp: Date.now(),
      actor: {
        id: "patchrelay-linear-user",
        name: "patchrelay",
        email: "patchrelay@oauthapp.linear.app",
        type: "User",
      } as unknown as Record<string, unknown>,
      data: {
        id: "comment-escalation-1",
        body: "PatchRelay needs human help to continue.\n\nReview fix budget exhausted (3 attempts)",
        user: { name: "patchrelay" },
        issue: {
          id: "issue-maf-escalation-comment",
          identifier: "MAF-91E",
          title: "Escalated issue",
          team: { id: "team-maf", key: "MAF" },
          state: { id: "state-review", name: "Review", type: "started" },
          delegate: { id: "patchrelay-actor", name: "PatchRelay" },
        },
      },
    };

    const stored = db.webhookEvents.insertFullWebhookEvent({
      webhookId: "delivery-escalation-comment",
      receivedAt: new Date().toISOString(),
      payloadJson: JSON.stringify(payload),
    });
    await handler.processWebhookEvent(stored.id);

    const events = db.issueSessions.listIssueSessionEvents("krasnoperov/mafia", "issue-maf-escalation-comment");
    assert.equal(events.length, 1);
    assert.equal(events[0]?.eventType, "self_comment");
    assert.equal(db.issueSessions.peekPendingSessionInputPlanForDiagnostics("krasnoperov/mafia", "issue-maf-escalation-comment"), undefined);
    assert.deepEqual(enqueued, []);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("PatchRelay agent activity echoes do not steer active runs or queue follow-up work", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-webhook-agent-activity-echo-"));
  try {
    const config = createConfig(baseDir);
    config.projects[0] = {
      ...config.projects[0]!,
      triggerEvents: [...config.projects[0]!.triggerEvents, "agentPrompted"],
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

    const issueRecord = db.upsertIssue({
      projectId: "krasnoperov/mafia",
      linearIssueId: "issue-maf-echo",
      issueKey: "MAF-92A",
      title: "Activity echo issue",
      delegatedToPatchRelay: true,
      currentLinearState: "In Progress",
      currentLinearStateType: "started",
      workflowOutcome: undefined,
      agentSessionId: "session-echo-1",
    });
    const run = db.runs.createRun({
      issueId: issueRecord.id,
      projectId: issueRecord.projectId,
      linearIssueId: issueRecord.linearIssueId,
      runType: "implementation",
    });
    db.runs.updateRunThread(run.id, { threadId: "thread-echo-1", turnId: "turn-echo-1" });
    db.upsertIssue({
      projectId: issueRecord.projectId,
      linearIssueId: issueRecord.linearIssueId,
      activeRunId: run.id,
    });

    const agentActivities: Array<{ agentSessionId: string; contentType: string }> = [];
    const codexSteers: Array<{ threadId: string; turnId: string; input: string }> = [];
    const enqueued: Array<{ projectId: string; issueId: string }> = [];
    const handler = new WebhookHandler(
      config,
      db,
      {
        forProject: async () => ({
          createAgentActivity: async ({ agentSessionId, content }) => {
            agentActivities.push({ agentSessionId, contentType: content.type });
          },
        } as unknown as LinearClient),
      } as never,
      {
        steerTurn: async ({ threadId, turnId, input }) => {
          codexSteers.push({ threadId, turnId, input });
        },
      } as never,
      (projectId, issueId) => { enqueued.push({ projectId, issueId }); },
      pino({ enabled: false }),
    );

    const payload: LinearWebhookPayload = {
      action: "prompted",
      type: "AgentSessionEvent",
      createdAt: "2026-04-01T02:12:00.000Z",
      webhookTimestamp: Date.now(),
      data: {
        agentSession: {
          id: "session-echo-1",
          issue: {
            id: "issue-maf-echo",
            identifier: "MAF-92A",
            title: "Activity echo issue",
            team: { id: "team-maf", key: "MAF" },
            state: { id: "state-start", name: "In Progress", type: "started" },
            delegate: { id: "patchrelay-actor", name: "PatchRelay" },
          },
        },
        agentActivity: {
          id: "activity-response-echo",
          content: {
            type: "response",
            body: "PatchRelay delivered this status update.",
          },
        },
      },
    };

    const stored = db.webhookEvents.insertFullWebhookEvent({
      webhookId: "delivery-agent-activity-echo",
      receivedAt: new Date().toISOString(),
      payloadJson: JSON.stringify(payload),
    });
    await handler.processWebhookEvent(stored.id);

    assert.deepEqual(codexSteers, []);
    assert.deepEqual(agentActivities, []);
    assert.deepEqual(enqueued, []);
    const events = db.issueSessions.listIssueSessionEvents("krasnoperov/mafia", "issue-maf-echo");
    assert.deepEqual(
      events.map((event) => event.eventType).filter((eventType) => eventType === "followup_prompt" || eventType === "direct_reply"),
      [],
    );
    assert.equal(db.issueSessions.peekPendingSessionInputPlanForDiagnostics("krasnoperov/mafia", "issue-maf-echo"), undefined);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("real agent prompt events still steer active runs", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-webhook-agent-real-prompt-"));
  try {
    const config = createConfig(baseDir);
    config.projects[0] = {
      ...config.projects[0]!,
      triggerEvents: [...config.projects[0]!.triggerEvents, "agentPrompted"],
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

    const issueRecord = db.upsertIssue({
      projectId: "krasnoperov/mafia",
      linearIssueId: "issue-maf-real-prompt",
      issueKey: "MAF-92B",
      title: "Real prompt issue",
      delegatedToPatchRelay: true,
      currentLinearState: "In Progress",
      currentLinearStateType: "started",
      workflowOutcome: undefined,
      agentSessionId: "session-real-prompt-1",
    });
    const run = db.runs.createRun({
      issueId: issueRecord.id,
      projectId: issueRecord.projectId,
      linearIssueId: issueRecord.linearIssueId,
      runType: "implementation",
    });
    db.runs.updateRunThread(run.id, { threadId: "thread-real-prompt-1", turnId: "turn-real-prompt-1" });
    db.upsertIssue({
      projectId: issueRecord.projectId,
      linearIssueId: issueRecord.linearIssueId,
      activeRunId: run.id,
    });

    const agentActivities: Array<{ agentSessionId: string; contentType: string }> = [];
    const codexSteers: Array<{ threadId: string; turnId: string; input: string }> = [];
    const handler = new WebhookHandler(
      config,
      db,
      {
        forProject: async () => ({
          createAgentActivity: async ({ agentSessionId, content }) => {
            agentActivities.push({ agentSessionId, contentType: content.type });
          },
        } as unknown as LinearClient),
      } as never,
      {
        steerTurn: async ({ threadId, turnId, input }) => {
          codexSteers.push({ threadId, turnId, input });
        },
      } as never,
      () => undefined,
      pino({ enabled: false }),
    );

    const payload: LinearWebhookPayload = {
      action: "prompted",
      type: "AgentSessionEvent",
      createdAt: "2026-04-01T02:13:00.000Z",
      webhookTimestamp: Date.now(),
      data: {
        agentSession: {
          id: "session-real-prompt-1",
          issue: {
            id: "issue-maf-real-prompt",
            identifier: "MAF-92B",
            title: "Real prompt issue",
            team: { id: "team-maf", key: "MAF" },
            state: { id: "state-start", name: "In Progress", type: "started" },
            delegate: { id: "patchrelay-actor", name: "PatchRelay" },
          },
        },
        comment: {
          id: "comment-real-prompt-1",
          body: "Please keep the API shape unchanged.",
        },
      },
    };

    const stored = db.webhookEvents.insertFullWebhookEvent({
      webhookId: "delivery-agent-real-prompt",
      receivedAt: new Date().toISOString(),
      payloadJson: JSON.stringify(payload),
    });
    await handler.processWebhookEvent(stored.id);

    assert.equal(codexSteers.length, 1);
    assert.equal(codexSteers[0]?.threadId, "thread-real-prompt-1");
    assert.equal(codexSteers[0]?.turnId, "turn-real-prompt-1");
    assert.match(codexSteers[0]?.input ?? "", /Please keep the API shape unchanged/);
    assert.match(codexSteers[0]?.input ?? "", /Checkpoint contract/);
    assert.deepEqual(agentActivities, [{ agentSessionId: "session-real-prompt-1", contentType: "thought" }]);
    assert.equal(
      db.issueSessions
        .listIssueSessionEvents("krasnoperov/mafia", "issue-maf-real-prompt")
        .some((event) => event.eventType === "prompt_delivered"),
      true,
    );
    assert.equal(db.issueSessions.peekPendingSessionInputPlanForDiagnostics("krasnoperov/mafia", "issue-maf-real-prompt"), undefined);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("active delegated agent status prompts answer as thoughts without steering or queueing work", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-webhook-agent-active-status-"));
  try {
    const config = createConfig(baseDir);
    config.projects[0] = {
      ...config.projects[0]!,
      triggerEvents: [...config.projects[0]!.triggerEvents, "agentPrompted"],
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

    const issueRecord = db.upsertIssue({
      projectId: "krasnoperov/mafia",
      linearIssueId: "issue-maf-active-status",
      issueKey: "MAF-92S",
      title: "Active status issue",
      delegatedToPatchRelay: true,
      currentLinearState: "In Progress",
      currentLinearStateType: "started",
      workflowOutcome: undefined,
      agentSessionId: "session-active-status-1",
    });
    const run = db.runs.createRun({
      issueId: issueRecord.id,
      projectId: issueRecord.projectId,
      linearIssueId: issueRecord.linearIssueId,
      runType: "implementation",
    });
    db.runs.updateRunThread(run.id, { threadId: "thread-active-status-1", turnId: "turn-active-status-1" });
    db.upsertIssue({
      projectId: issueRecord.projectId,
      linearIssueId: issueRecord.linearIssueId,
      activeRunId: run.id,
    });

    const activities: Array<{ body?: string; ephemeral?: boolean; type?: string }> = [];
    const codexSteers: Array<{ threadId: string; turnId: string; input: string }> = [];
    const enqueued: Array<{ projectId: string; issueId: string }> = [];
    const handler = new WebhookHandler(
      config,
      db,
      {
        forProject: async () => ({
          createAgentActivity: async ({ content, ephemeral }) => {
            activities.push({
              type: content.type,
              ...(typeof (content as { body?: string }).body === "string" ? { body: (content as { body: string }).body } : {}),
              ...(ephemeral !== undefined ? { ephemeral } : {}),
            });
          },
          updateAgentSession: async () => undefined,
        } as unknown as LinearClient),
      } as never,
      {
        steerTurn: async ({ threadId, turnId, input }) => {
          codexSteers.push({ threadId, turnId, input });
        },
      } as never,
      (projectId, issueId) => { enqueued.push({ projectId, issueId }); },
      pino({ enabled: false }),
      undefined,
      fakeFollowupClassifier("status"),
    );

    const payload: LinearWebhookPayload = {
      action: "prompted",
      type: "AgentSessionEvent",
      createdAt: "2026-04-01T02:13:10.000Z",
      webhookTimestamp: Date.now(),
      data: {
        agentSession: {
          id: "session-active-status-1",
          issue: {
            id: "issue-maf-active-status",
            identifier: "MAF-92S",
            title: "Active status issue",
            team: { id: "team-maf", key: "MAF" },
            state: { id: "state-start", name: "In Progress", type: "started" },
            delegate: { id: "patchrelay-actor", name: "PatchRelay" },
          },
        },
        comment: {
          id: "comment-active-status-1",
          body: "what's happening right now?",
        },
      },
    };

    const stored = db.webhookEvents.insertFullWebhookEvent({
      webhookId: "delivery-agent-active-status",
      receivedAt: new Date().toISOString(),
      payloadJson: JSON.stringify(payload),
    });
    await handler.processWebhookEvent(stored.id);

    assert.deepEqual(codexSteers, []);
    assert.deepEqual(enqueued, []);
    assert.equal(db.issueSessions.peekPendingSessionInputPlanForDiagnostics("krasnoperov/mafia", "issue-maf-active-status"), undefined);
    assert.equal(activities.length, 1);
    assert.equal(activities[0]?.type, "thought");
    assert.equal(activities[0]?.ephemeral, true);
    assert.match(activities[0]?.body ?? "", /PatchRelay status: MAF-92S is implementing/);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("active agent prompt delivery failure records diagnostics and Linear-visible feedback", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-webhook-agent-prompt-failure-"));
  try {
    const config = createConfig(baseDir);
    config.projects[0] = {
      ...config.projects[0]!,
      triggerEvents: [...config.projects[0]!.triggerEvents, "agentPrompted"],
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

    const issueRecord = db.upsertIssue({
      projectId: "krasnoperov/mafia",
      linearIssueId: "issue-maf-prompt-failure",
      issueKey: "MAF-92F",
      title: "Prompt failure issue",
      delegatedToPatchRelay: true,
      currentLinearState: "In Progress",
      currentLinearStateType: "started",
      workflowOutcome: undefined,
      agentSessionId: "session-prompt-failure-1",
    });
    const run = db.runs.createRun({
      issueId: issueRecord.id,
      projectId: issueRecord.projectId,
      linearIssueId: issueRecord.linearIssueId,
      runType: "implementation",
    });
    db.runs.updateRunThread(run.id, { threadId: "thread-prompt-failure-1", turnId: "turn-prompt-failure-1" });
    db.upsertIssue({
      projectId: issueRecord.projectId,
      linearIssueId: issueRecord.linearIssueId,
      activeRunId: run.id,
    });

    const agentActivities: Array<{ agentSessionId: string; body?: string; ephemeral?: boolean; type: string }> = [];
    const feedEvents: Array<{ status?: string; summary?: string }> = [];
    const handler = new WebhookHandler(
      config,
      db,
      {
        forProject: async () => ({
          createAgentActivity: async ({ agentSessionId, content, ephemeral }) => {
            agentActivities.push({
              agentSessionId,
              type: content.type,
              ...(typeof content.body === "string" ? { body: content.body } : {}),
              ...(ephemeral !== undefined ? { ephemeral } : {}),
            });
          },
        } as unknown as LinearClient),
      } as never,
      {
        steerTurn: async () => {
          throw new Error("turn already finished");
        },
      } as never,
      () => undefined,
      pino({ enabled: false }),
      { publish: (event) => { feedEvents.push({ status: event.status, summary: event.summary }); } } as never,
      fakeFollowupClassifier("implementation_instruction"),
    );

    const payload: LinearWebhookPayload = {
      action: "prompted",
      type: "AgentSessionEvent",
      createdAt: "2026-04-01T02:13:30.000Z",
      webhookTimestamp: Date.now(),
      data: {
        agentSession: {
          id: "session-prompt-failure-1",
          issue: {
            id: "issue-maf-prompt-failure",
            identifier: "MAF-92F",
            title: "Prompt failure issue",
            team: { id: "team-maf", key: "MAF" },
            state: { id: "state-start", name: "In Progress", type: "started" },
            delegate: { id: "patchrelay-actor", name: "PatchRelay" },
          },
        },
        comment: {
          id: "comment-prompt-failure-1",
          body: "Please keep the API shape unchanged.",
        },
      },
    };

    const stored = db.webhookEvents.insertFullWebhookEvent({
      webhookId: "delivery-agent-prompt-failure",
      receivedAt: new Date().toISOString(),
      payloadJson: JSON.stringify(payload),
    });
    await handler.processWebhookEvent(stored.id);

    const deliveryEvent = db.issueSessions
      .listIssueSessionEvents("krasnoperov/mafia", "issue-maf-prompt-failure")
      .find((event) => event.eventType === "prompt_delivered");
    assert.ok(deliveryEvent);
    const eventJson = JSON.parse(deliveryEvent.eventJson ?? "{}") as Record<string, unknown>;
    assert.equal(eventJson.status, "delivery_failed");
    assert.equal(eventJson.runId, run.id);
    assert.ok(feedEvents.some((event) => event.status === "delivery_failed"));
    assert.equal(agentActivities.length, 1);
    assert.equal(agentActivities[0]?.agentSessionId, "session-prompt-failure-1");
    assert.equal(agentActivities[0]?.type, "thought");
    assert.equal(agentActivities[0]?.ephemeral, true);
    assert.match(agentActivities[0]?.body ?? "", /could not route your latest instructions/);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("idle delegated agent status prompts respond without queueing implementation", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-webhook-agent-status-prompt-"));
  try {
    const config = createConfig(baseDir);
    config.projects[0] = {
      ...config.projects[0]!,
      triggerEvents: [...config.projects[0]!.triggerEvents, "agentPrompted"],
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
      linearIssueId: "issue-maf-status-prompt",
      issueKey: "MAF-92C",
      title: "Status prompt issue",
      delegatedToPatchRelay: true,
      currentLinearState: "Review",
      currentLinearStateType: "started",
      workflowOutcome: undefined,
      prNumber: 92,
      agentSessionId: "session-status-prompt-1",
    });

    const activities: Array<{ agentSessionId: string; body?: string; type?: string }> = [];
    const enqueued: Array<{ projectId: string; issueId: string }> = [];
    const handler = new WebhookHandler(
      config,
      db,
      {
        forProject: async () => ({
          createAgentActivity: async ({ agentSessionId, content }) => {
            activities.push({
              agentSessionId,
              type: content.type,
              ...(typeof (content as { body?: string }).body === "string" ? { body: (content as { body: string }).body } : {}),
            });
          },
          updateAgentSession: async () => undefined,
        } as unknown as LinearClient),
      } as never,
      { steerTurn: async () => undefined } as never,
      (projectId, issueId) => { enqueued.push({ projectId, issueId }); },
      pino({ enabled: false }),
      undefined,
      fakeFollowupClassifier("status"),
    );

    const payload: LinearWebhookPayload = {
      action: "prompted",
      type: "AgentSessionEvent",
      createdAt: "2026-04-01T02:14:00.000Z",
      webhookTimestamp: Date.now(),
      data: {
        agentSession: {
          id: "session-status-prompt-1",
          issue: {
            id: "issue-maf-status-prompt",
            identifier: "MAF-92C",
            title: "Status prompt issue",
            team: { id: "team-maf", key: "MAF" },
            state: { id: "state-review", name: "Review", type: "started" },
            delegate: { id: "patchrelay-actor", name: "PatchRelay" },
          },
        },
        comment: {
          id: "comment-status-prompt-1",
          body: "what's the status?",
        },
      },
    };

    const stored = db.webhookEvents.insertFullWebhookEvent({
      webhookId: "delivery-agent-status-prompt",
      receivedAt: new Date().toISOString(),
      payloadJson: JSON.stringify(payload),
    });
    await handler.processWebhookEvent(stored.id);

    assert.deepEqual(enqueued, []);
    assert.equal(db.issueSessions.peekPendingSessionInputPlanForDiagnostics("krasnoperov/mafia", "issue-maf-status-prompt"), undefined);
    assert.deepEqual(
      db.issueSessions
        .listIssueSessionEvents("krasnoperov/mafia", "issue-maf-status-prompt")
        .map((event) => event.eventType)
        .filter((eventType) => eventType === "followup_prompt" || eventType === "direct_reply"),
      [],
    );
    assert.equal(activities.length, 1);
    assert.equal(activities[0]?.agentSessionId, "session-status-prompt-1");
    assert.equal(activities[0]?.type, "response");
    assert.match(activities[0]?.body ?? "", /PatchRelay status: MAF-92C is pr open/);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("idle delegated agent retry prompts queue follow-up implementation", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-webhook-agent-retry-prompt-"));
  try {
    const config = createConfig(baseDir);
    config.projects[0] = {
      ...config.projects[0]!,
      triggerEvents: [...config.projects[0]!.triggerEvents, "agentPrompted"],
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
      linearIssueId: "issue-maf-retry-prompt",
      issueKey: "MAF-92D",
      title: "Retry prompt issue",
      delegatedToPatchRelay: true,
      currentLinearState: "Needs input",
      currentLinearStateType: "unstarted",
      inputRequestKind: "completion_check_question",
      agentSessionId: "session-retry-prompt-1",
    });

    const activities: Array<{ body?: string; type?: string }> = [];
    const enqueued: Array<{ projectId: string; issueId: string }> = [];
    const handler = new WebhookHandler(
      config,
      db,
      {
        forProject: async () => ({
          createAgentActivity: async ({ content }) => {
            activities.push({
              type: content.type,
              ...(typeof (content as { body?: string }).body === "string" ? { body: (content as { body: string }).body } : {}),
            });
          },
          updateAgentSession: async () => undefined,
        } as unknown as LinearClient),
      } as never,
      { steerTurn: async () => undefined } as never,
      (projectId, issueId) => { enqueued.push({ projectId, issueId }); },
      pino({ enabled: false }),
      undefined,
      fakeFollowupClassifier("resume_or_retry"),
    );

    const payload: LinearWebhookPayload = {
      action: "prompted",
      type: "AgentSessionEvent",
      createdAt: "2026-04-01T02:15:00.000Z",
      webhookTimestamp: Date.now(),
      data: {
        agentSession: {
          id: "session-retry-prompt-1",
          issue: {
            id: "issue-maf-retry-prompt",
            identifier: "MAF-92D",
            title: "Retry prompt issue",
            team: { id: "team-maf", key: "MAF" },
            state: { id: "state-input", name: "Needs input", type: "unstarted" },
            delegate: { id: "patchrelay-actor", name: "PatchRelay" },
          },
        },
        comment: {
          id: "comment-retry-prompt-1",
          body: "please continue",
        },
      },
    };

    const stored = db.webhookEvents.insertFullWebhookEvent({
      webhookId: "delivery-agent-retry-prompt",
      receivedAt: new Date().toISOString(),
      payloadJson: JSON.stringify(payload),
    });
    await handler.processWebhookEvent(stored.id);

    const workflowTask = db.issueSessions.peekPendingSessionInputPlanForDiagnostics("krasnoperov/mafia", "issue-maf-retry-prompt");
    const events = db.issueSessions.listIssueSessionEvents("krasnoperov/mafia", "issue-maf-retry-prompt");
    assert.equal(workflowTask?.runType, "implementation");
    assert.equal(workflowTask?.workflowReason, "followup_prompt");
    assert.deepEqual(enqueued, [{ projectId: "krasnoperov/mafia", issueId: "issue-maf-retry-prompt" }]);
    assert.equal(events.at(-1)?.eventType, "followup_prompt");
    assert.ok(activities.some((activity) => activity.body?.includes("PatchRelay routed your latest instructions")));
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("agent prompts on completed PRs reopen work as replacement PR runs with prior PR context", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-webhook-agent-done-replacement-"));
  try {
    const config = createConfig(baseDir);
    config.projects[0] = {
      ...config.projects[0]!,
      triggerEvents: [...config.projects[0]!.triggerEvents, "agentPrompted"],
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
      linearIssueId: "issue-maf-done-replacement",
      issueKey: "MAF-92R",
      title: "Completed PR follow-up",
      delegatedToPatchRelay: true,
      currentLinearState: "Done",
      currentLinearStateType: "completed",
      workflowOutcome: "completed",
      branchName: "maf/MAF-92R",
      prNumber: 929,
      prUrl: "https://github.example/pull/929",
      prState: "merged",
      prHeadSha: "abc123",
      agentSessionId: "session-done-replacement-1",
    });

    const activities: Array<{ action?: string; parameter?: string; type?: string; ephemeral?: boolean }> = [];
    const enqueued: Array<{ projectId: string; issueId: string }> = [];
    const handler = new WebhookHandler(
      config,
      db,
      {
        forProject: async () => ({
          createAgentActivity: async ({ content, ephemeral }) => {
            activities.push({
              type: content.type,
              ...("action" in content && typeof content.action === "string" ? { action: content.action } : {}),
              ...("parameter" in content && typeof content.parameter === "string" ? { parameter: content.parameter } : {}),
              ...(ephemeral !== undefined ? { ephemeral } : {}),
            });
          },
          updateAgentSession: async () => undefined,
        } as unknown as LinearClient),
      } as never,
      { steerTurn: async () => undefined } as never,
      (projectId, issueId) => { enqueued.push({ projectId, issueId }); },
      pino({ enabled: false }),
      undefined,
      fakeFollowupClassifier("implementation_instruction"),
    );

    const payload: LinearWebhookPayload = {
      action: "prompted",
      type: "AgentSessionEvent",
      createdAt: "2026-04-01T02:16:00.000Z",
      webhookTimestamp: Date.now(),
      data: {
        agentSession: {
          id: "session-done-replacement-1",
          issue: {
            id: "issue-maf-done-replacement",
            identifier: "MAF-92R",
            title: "Completed PR follow-up",
            team: { id: "team-maf", key: "MAF" },
            state: { id: "state-done", name: "Done", type: "completed" },
            delegate: { id: "patchrelay-actor", name: "PatchRelay" },
          },
        },
        comment: {
          id: "comment-done-replacement-1",
          body: "Please also add the dashboard copy changes.",
        },
      },
    };

    const stored = db.webhookEvents.insertFullWebhookEvent({
      webhookId: "delivery-agent-done-replacement",
      receivedAt: new Date().toISOString(),
      payloadJson: JSON.stringify(payload),
    });
    await handler.processWebhookEvent(stored.id);

    const issue = db.getIssue("krasnoperov/mafia", "issue-maf-done-replacement");
    const workflowTask = db.issueSessions.peekPendingSessionInputPlanForDiagnostics("krasnoperov/mafia", "issue-maf-done-replacement");
    assertIssuePhase(issue, "delegated");
    assert.equal(issue?.prNumber, undefined);
    assert.match(issue?.branchName ?? "", /^maf\/MAF-92R-replacement-/);
    assert.equal(workflowTask?.runType, "implementation");
    assert.equal(workflowTask?.resumeThread, true);
    assert.equal(workflowTask?.context.replacementPrRequired, true);
    assert.equal(workflowTask?.context.previousPrNumber, 929);
    assert.equal(workflowTask?.context.previousPrUrl, "https://github.example/pull/929");
    assert.equal(workflowTask?.context.previousPrState, "merged");
    assert.equal(workflowTask?.context.previousPrHeadSha, "abc123");
    assert.equal(workflowTask?.context.followUps?.[0]?.text, "Please also add the dashboard copy changes.");
    assert.deepEqual(enqueued, [{ projectId: "krasnoperov/mafia", issueId: "issue-maf-done-replacement" }]);
    assert.deepEqual(activities, [{
      type: "action",
      action: "Reopening",
      parameter: "completed PR #929 for replacement work",
      ephemeral: true,
    }]);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("agent signal stop requests halt the active run and emit a stop_requested session event", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-webhook-stop-signal-"));
  try {
    const config = createConfig(baseDir);
    config.projects[0] = {
      ...config.projects[0]!,
      triggerEvents: [...config.projects[0]!.triggerEvents, "agentSignal"],
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
    const worktreePath = path.join(baseDir, "repo");
    execFileSync("git", ["init", worktreePath], { stdio: "ignore" });
    execFileSync("git", ["-C", worktreePath, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", worktreePath, "config", "user.name", "Test User"]);
    writeFileSync(path.join(worktreePath, "file.txt"), "base\n");
    execFileSync("git", ["-C", worktreePath, "add", "file.txt"]);
    execFileSync("git", ["-C", worktreePath, "commit", "-m", "base"], { stdio: "ignore" });
    writeFileSync(path.join(worktreePath, "file.txt"), "dirty\n");

    const issueRecord = db.upsertIssue({
      projectId: "krasnoperov/mafia",
      linearIssueId: "issue-maf-stop",
      issueKey: "MAF-97",
      title: "Stop requested issue",
      workflowOutcome: undefined,
      agentSessionId: "session-stop-1",
      worktreePath,
    });
    const run = db.runs.createRun({
      issueId: issueRecord.id,
      projectId: "krasnoperov/mafia",
      linearIssueId: "issue-maf-stop",
      runType: "implementation",
      promptText: "Keep working until the stop signal arrives.",
    });
    db.upsertIssue({
      projectId: "krasnoperov/mafia",
      linearIssueId: "issue-maf-stop",
      activeRunId: run.id,
    });
    db.runs.updateRunThread(run.id, { threadId: "thread-stop-1", turnId: "turn-stop-1" });

    const agentActivities: Array<{ agentSessionId: string; contentType: string; body?: string }> = [];
    const sessionUpdates: Array<{ agentSessionId: string; planLength: number }> = [];
    const codexSteers: Array<{ threadId: string; turnId: string; input: string }> = [];
    const handler = new WebhookHandler(
      config,
      db,
      {
        forProject: async () => ({
          createAgentActivity: async ({ agentSessionId, content }) => {
            agentActivities.push({
              agentSessionId,
              contentType: content.type,
              ...(typeof content.body === "string" ? { body: content.body } : {}),
            });
          },
          updateAgentSession: async ({ agentSessionId, plan }) => {
            sessionUpdates.push({ agentSessionId, planLength: Array.isArray(plan) ? plan.length : 0 });
          },
        } as unknown as LinearClient),
      } as never,
      {
        steerTurn: async ({ threadId, turnId, input }) => {
          codexSteers.push({ threadId, turnId, input });
        },
      } as never,
      () => undefined,
      pino({ enabled: false }),
    );

    const payload: LinearWebhookPayload = {
      action: "created",
      type: "AgentSessionEvent",
      createdAt: "2026-04-01T02:20:00.000Z",
      webhookTimestamp: Date.now(),
      agentSession: {
        id: "session-stop-1",
        issue: {
          id: "issue-maf-stop",
          identifier: "MAF-97",
          title: "Stop requested issue",
          team: { id: "team-maf", key: "MAF" },
          state: { id: "state-start", name: "In Progress", type: "started" },
          delegate: { id: "patchrelay-actor", name: "PatchRelay" },
        },
      },
      agentActivity: {
        signal: "stop",
      },
    } as unknown as LinearWebhookPayload;

    const stored = db.webhookEvents.insertFullWebhookEvent({
      webhookId: "delivery-stop-signal",
      receivedAt: new Date().toISOString(),
      payloadJson: JSON.stringify(payload),
    });

    await handler.processWebhookEvent(stored.id);

    const issue = db.getIssue("krasnoperov/mafia", "issue-maf-stop");
    const runAfter = db.runs.getRunById(run.id);
    const events = db.issueSessions.listIssueSessionEvents("krasnoperov/mafia", "issue-maf-stop");
    assertIssuePhase(issue, "awaiting_input");
    assert.equal(issue?.activeRunId, undefined);
    assert.equal(runAfter?.status, "released");
    assert.match(runAfter?.failureReason ?? "", /Worktree has/);
    assert.match(runAfter?.failureReason ?? "", /file\.txt/);
    const stopEvent = events.find((event) => event.eventType === "stop_requested");
    assert.match(stopEvent?.eventJson ?? "", /dirtyWorktree/);
    assert.equal(codexSteers.length, 1);
    assert.equal(codexSteers[0]?.threadId, "thread-stop-1");
    assert.equal(codexSteers[0]?.turnId, "turn-stop-1");
    assert.match(codexSteers[0]?.input ?? "", /STOP: The user has requested you stop working immediately/);
    assert.equal(agentActivities.length, 1);
    assert.equal(agentActivities[0]?.agentSessionId, "session-stop-1");
    assert.equal(sessionUpdates.length, 1);
    assert.equal(sessionUpdates[0]?.agentSessionId, "session-stop-1");
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
    const sessionEvent = db.webhookEvents.insertFullWebhookEvent({
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
    const notificationEvent = db.webhookEvents.insertFullWebhookEvent({
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

test("agent session creation does not post a delegate prompt when Linear already shows PatchRelay delegated", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-webhook-agent-session-delegated-race-"));
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

    const activities: Array<{ agentSessionId: string; body?: string; type?: string }> = [];
    const linearClient: Partial<LinearClient> = {
      getIssue: async () => ({
        id: "issue-maf-session",
        identifier: "MAF-93",
        title: "Delegation race",
        teamId: "team-maf",
        teamKey: "MAF",
        delegateId: "patchrelay-actor",
        stateId: "state-start",
        stateName: "In Progress",
        stateType: "started",
        workflowStates: [],
        labelIds: [],
        labels: [],
        teamLabels: [],
        blockedBy: [],
        blocks: [],
      }),
      createAgentActivity: async ({ agentSessionId, content }) => {
        activities.push({
          agentSessionId,
          type: content.type,
          ...(typeof (content as { body?: string }).body === "string" ? { body: (content as { body: string }).body } : {}),
        });
      },
    };

    const handler = new WebhookHandler(
      config,
      db,
      { forProject: async () => linearClient as LinearClient } as never,
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
        promptContext: "<issue identifier=\"MAF-93\"><title>Delegation race</title></issue>",
        agentSession: {
          id: "session-93",
          issue: {
            id: "issue-maf-session",
            identifier: "MAF-93",
            title: "Delegation race",
            team: { id: "team-maf", key: "MAF" },
            state: { id: "state-start", name: "In Progress", type: "started" },
          },
        },
      },
    };
    const stored = db.webhookEvents.insertFullWebhookEvent({
      webhookId: "delivery-agent-session-race",
      receivedAt: new Date().toISOString(),
      payloadJson: JSON.stringify(sessionPayload),
    });

    await handler.processWebhookEvent(stored.id);

    assert.deepEqual(
      activities.filter((entry) => entry.body?.includes("Delegate the issue to PatchRelay to start work.")),
      [],
    );
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("agent session creation before delegation persists the session id for later sync", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-webhook-agent-session-predelegate-"));
  try {
    const config = createConfig(baseDir);
    config.projects[0] = {
      ...config.projects[0]!,
      triggerEvents: [...config.projects[0]!.triggerEvents, "agentSessionCreated", "delegateChanged"],
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

    const activities: Array<{ agentSessionId: string; body?: string; type?: string }> = [];
    const sessionUpdates: Array<{ agentSessionId: string; planLength: number }> = [];
    const linearClient: Partial<LinearClient> = {
      getIssue: async () => ({
        id: "issue-maf-session",
        identifier: "MAF-94",
        title: "Pre-delegation session",
        teamId: "team-maf",
        teamKey: "MAF",
        delegateId: undefined,
        stateId: "state-backlog",
        stateName: "Backlog",
        stateType: "unstarted",
        workflowStates: [],
        labelIds: [],
        labels: [],
        teamLabels: [],
        blockedBy: [],
        blocks: [],
      }),
      createAgentActivity: async ({ agentSessionId, content }) => {
        activities.push({
          agentSessionId,
          type: content.type,
          ...(typeof (content as { body?: string }).body === "string" ? { body: (content as { body: string }).body } : {}),
        });
      },
      updateAgentSession: async ({ agentSessionId, plan }) => {
        sessionUpdates.push({ agentSessionId, planLength: Array.isArray(plan) ? plan.length : 0 });
      },
    };

    const handler = new WebhookHandler(
      config,
      db,
      { forProject: async () => linearClient as LinearClient } as never,
      { steerTurn: async () => undefined } as never,
      () => undefined,
      pino({ enabled: false }),
    );

    const agentSessionPayload: LinearWebhookPayload = {
      action: "created",
      type: "AgentSessionEvent",
      createdAt: "2026-04-01T03:00:00.000Z",
      webhookTimestamp: Date.now(),
      agentSession: {
        id: "session-94",
        issueId: "issue-maf-session",
        comment: {
          id: "comment-94",
          body: "This thread is for an agent session with patchrelay.",
          issueId: "issue-maf-session",
        },
        issue: {
          id: "issue-maf-session",
          identifier: "MAF-94",
          title: "Pre-delegation session",
          team: { id: "team-maf", key: "MAF" },
          state: { id: "state-backlog", name: "Backlog", type: "unstarted" },
        },
      },
      promptContext: "<issue identifier=\"MAF-94\"><title>Pre-delegation session</title></issue>",
    };
    const sessionEvent = db.webhookEvents.insertFullWebhookEvent({
      webhookId: "delivery-agent-session-predelegate",
      receivedAt: new Date().toISOString(),
      payloadJson: JSON.stringify(agentSessionPayload),
    });
    await handler.processWebhookEvent(sessionEvent.id);

    const preDelegationIssue = db.getIssue("krasnoperov/mafia", "issue-maf-session");
    assert.equal(preDelegationIssue?.agentSessionId, "session-94");
    assertIssuePhase(preDelegationIssue, "awaiting_input");
    assert.deepEqual(
      activities.filter((entry) => entry.body?.includes("Delegate the issue to PatchRelay to start work.")),
      [],
    );
    assert.deepEqual(sessionUpdates, [{ agentSessionId: "session-94", planLength: 4 }]);

    const delegatePayload: LinearWebhookPayload = {
      action: "update",
      type: "Issue",
      createdAt: "2026-04-01T03:01:00.000Z",
      webhookTimestamp: Date.now(),
      updatedFrom: { delegateId: null },
      data: {
        id: "issue-maf-session",
        identifier: "MAF-94",
        title: "Pre-delegation session",
        delegateId: "patchrelay-actor",
        delegate: { id: "patchrelay-actor", name: "PatchRelay" },
        team: { id: "team-maf", key: "MAF" },
        state: { id: "state-start", name: "Start", type: "started" },
      },
    };
    const delegateEvent = db.webhookEvents.insertFullWebhookEvent({
      webhookId: "delivery-agent-session-delegate",
      receivedAt: new Date().toISOString(),
      payloadJson: JSON.stringify(delegatePayload),
    });
    await handler.processWebhookEvent(delegateEvent.id);

    const delegatedIssue = db.getIssue("krasnoperov/mafia", "issue-maf-session");
    assert.equal(delegatedIssue?.agentSessionId, "session-94");
    const delegatedTask = db.issueSessions.peekPendingSessionInputPlanForDiagnostics("krasnoperov/mafia", "issue-maf-session");
    assert.equal(delegatedTask?.runType, "implementation");
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("issueCreated recovers delegated startup after an early agent session left the issue awaiting_input", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-webhook-agent-session-created-startup-recovery-"));
  try {
    const config = createConfig(baseDir);
    config.projects[0] = {
      ...config.projects[0]!,
      triggerEvents: ["delegateChanged", "statusChanged", "agentSessionCreated", "agentPrompted", "commentCreated", "commentUpdated"],
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

    let hydratedDelegateId: string | undefined;
    const linearClient: Partial<LinearClient> = {
      getIssue: async () => ({
        id: "issue-maf-startup",
        identifier: "MAF-95",
        title: "Delegated startup recovery",
        teamId: "team-maf",
        teamKey: "MAF",
        delegateId: hydratedDelegateId,
        stateId: "state-backlog",
        stateName: "Backlog",
        stateType: "unstarted",
        workflowStates: [],
        labelIds: [],
        labels: [],
        teamLabels: [],
        blockedBy: [],
        blocks: [],
      }),
      createAgentActivity: async () => undefined,
      updateAgentSession: async () => undefined,
    };

    const enqueued: Array<{ projectId: string; issueId: string }> = [];
    const handler = new WebhookHandler(
      config,
      db,
      { forProject: async () => linearClient as LinearClient } as never,
      { steerTurn: async () => undefined } as never,
      (projectId, issueId) => {
        enqueued.push({ projectId, issueId });
      },
      pino({ enabled: false }),
    );

    hydratedDelegateId = undefined;
    const agentSessionPayload: LinearWebhookPayload = {
      action: "created",
      type: "AgentSessionEvent",
      createdAt: "2026-04-01T03:00:00.000Z",
      webhookTimestamp: Date.now(),
      agentSession: {
        id: "session-95",
        issueId: "issue-maf-startup",
        comment: {
          id: "comment-95",
          body: "This thread is for an agent session with patchrelay.",
          issueId: "issue-maf-startup",
        },
        issue: {
          id: "issue-maf-startup",
          identifier: "MAF-95",
          title: "Delegated startup recovery",
          team: { id: "team-maf", key: "MAF" },
          state: { id: "state-backlog", name: "Backlog", type: "unstarted" },
        },
      },
      promptContext: "<issue identifier=\"MAF-95\"><title>Delegated startup recovery</title></issue>",
    };
    const sessionEvent = db.webhookEvents.insertFullWebhookEvent({
      webhookId: "delivery-agent-session-startup-race",
      receivedAt: new Date().toISOString(),
      payloadJson: JSON.stringify(agentSessionPayload),
    });
    await handler.processWebhookEvent(sessionEvent.id);

    const preIssue = db.getIssue("krasnoperov/mafia", "issue-maf-startup");
    assertIssuePhase(preIssue, "awaiting_input");

    hydratedDelegateId = "patchrelay-actor";
    const issueCreatedPayload: LinearWebhookPayload = {
      action: "create",
      type: "Issue",
      createdAt: "2026-04-01T03:00:10.000Z",
      webhookTimestamp: Date.now(),
      data: {
        id: "issue-maf-startup",
        identifier: "MAF-95",
        title: "Delegated startup recovery",
        team: { id: "team-maf", key: "MAF" },
        state: { id: "state-backlog", name: "Backlog", type: "unstarted" },
        delegateId: "patchrelay-actor",
        delegate: { id: "patchrelay-actor", name: "PatchRelay" },
      },
    };
    const issueCreatedEvent = db.webhookEvents.insertFullWebhookEvent({
      webhookId: "delivery-issue-created-startup-race",
      receivedAt: new Date().toISOString(),
      payloadJson: JSON.stringify(issueCreatedPayload),
    });
    await handler.processWebhookEvent(issueCreatedEvent.id);

    const recoveredIssue = db.getIssue("krasnoperov/mafia", "issue-maf-startup");
    const recoveredTask = db.issueSessions.peekPendingSessionInputPlanForDiagnostics("krasnoperov/mafia", "issue-maf-startup");
    assertIssuePhase(recoveredIssue, "delegated");
    assert.equal(recoveredTask?.runType, "implementation");
    assert.deepEqual(enqueued, [{ projectId: "krasnoperov/mafia", issueId: "issue-maf-startup" }]);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("issueCreated recovers delegated blocked startup without queueing implementation", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-webhook-agent-session-created-blocked-recovery-"));
  try {
    const config = createConfig(baseDir);
    config.projects[0] = {
      ...config.projects[0]!,
      triggerEvents: ["delegateChanged", "statusChanged", "agentSessionCreated", "agentPrompted", "commentCreated", "commentUpdated"],
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

    let hydratedDelegateId: string | undefined;
    const linearClient: Partial<LinearClient> = {
      getIssue: async () => ({
        id: "issue-maf-blocked-startup",
        identifier: "MAF-96",
        title: "Delegated blocked startup recovery",
        teamId: "team-maf",
        teamKey: "MAF",
        delegateId: hydratedDelegateId,
        stateId: "state-backlog",
        stateName: "Backlog",
        stateType: "unstarted",
        workflowStates: [],
        labelIds: [],
        labels: [],
        teamLabels: [],
        blockedBy: [{
          id: "issue-blocker-1",
          identifier: "MAF-10",
          title: "Blocking task",
          stateName: "In Progress",
          stateType: "started",
        }],
        blocks: [],
      }),
      createAgentActivity: async () => undefined,
      updateAgentSession: async () => undefined,
    };

    const enqueued: Array<{ projectId: string; issueId: string }> = [];
    const handler = new WebhookHandler(
      config,
      db,
      { forProject: async () => linearClient as LinearClient } as never,
      { steerTurn: async () => undefined } as never,
      (projectId, issueId) => {
        enqueued.push({ projectId, issueId });
      },
      pino({ enabled: false }),
    );

    hydratedDelegateId = undefined;
    const agentSessionPayload: LinearWebhookPayload = {
      action: "created",
      type: "AgentSessionEvent",
      createdAt: "2026-04-01T03:00:00.000Z",
      webhookTimestamp: Date.now(),
      agentSession: {
        id: "session-96",
        issueId: "issue-maf-blocked-startup",
        comment: {
          id: "comment-96",
          body: "This thread is for an agent session with patchrelay.",
          issueId: "issue-maf-blocked-startup",
        },
        issue: {
          id: "issue-maf-blocked-startup",
          identifier: "MAF-96",
          title: "Delegated blocked startup recovery",
          team: { id: "team-maf", key: "MAF" },
          state: { id: "state-backlog", name: "Backlog", type: "unstarted" },
        },
      },
      promptContext: "<issue identifier=\"MAF-96\"><title>Delegated blocked startup recovery</title></issue>",
    };
    const sessionEvent = db.webhookEvents.insertFullWebhookEvent({
      webhookId: "delivery-agent-session-blocked-startup-race",
      receivedAt: new Date().toISOString(),
      payloadJson: JSON.stringify(agentSessionPayload),
    });
    await handler.processWebhookEvent(sessionEvent.id);

    hydratedDelegateId = "patchrelay-actor";
    const issueCreatedPayload: LinearWebhookPayload = {
      action: "create",
      type: "Issue",
      createdAt: "2026-04-01T03:00:10.000Z",
      webhookTimestamp: Date.now(),
      data: {
        id: "issue-maf-blocked-startup",
        identifier: "MAF-96",
        title: "Delegated blocked startup recovery",
        team: { id: "team-maf", key: "MAF" },
        state: { id: "state-backlog", name: "Backlog", type: "unstarted" },
        delegateId: "patchrelay-actor",
        delegate: { id: "patchrelay-actor", name: "PatchRelay" },
      },
    };
    const issueCreatedEvent = db.webhookEvents.insertFullWebhookEvent({
      webhookId: "delivery-issue-created-blocked-startup-race",
      receivedAt: new Date().toISOString(),
      payloadJson: JSON.stringify(issueCreatedPayload),
    });
    await handler.processWebhookEvent(issueCreatedEvent.id);

    const recoveredIssue = db.getIssue("krasnoperov/mafia", "issue-maf-blocked-startup");
    assertIssuePhase(recoveredIssue, "delegated");
    assert.equal(db.countUnresolvedBlockers("krasnoperov/mafia", "issue-maf-blocked-startup"), 1);
    assert.deepEqual(enqueued, []);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("orchestration parents do not dispatch workflow tasks on non-terminal child status churn", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-webhook-orchestration-child-churn-"));
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
      linearIssueId: "issue-maf-parent",
      issueKey: "MAF-200",
      title: "Umbrella parent",
      delegatedToPatchRelay: true,
      workflowOutcome: undefined,
      currentLinearState: "Start",
      currentLinearStateType: "started",
    });
    db.upsertIssue({
      projectId: "krasnoperov/mafia",
      linearIssueId: "issue-maf-child",
      issueKey: "MAF-201",
      title: "Child implementation",
      delegatedToPatchRelay: true,
      workflowOutcome: undefined,
      currentLinearState: "Implementing",
      currentLinearStateType: "started",
      prNumber: 201,
      prState: "open",
      parentLinearIssueId: "issue-maf-parent",
      parentIssueKey: "MAF-200",
    });

    const linearClient: Partial<LinearClient> = {
      getIssue: async () => ({
        id: "issue-maf-child",
        identifier: "MAF-201",
        title: "Child implementation",
        parentId: "issue-maf-parent",
        parentIdentifier: "MAF-200",
        parentTitle: "Umbrella parent",
        teamId: "team-maf",
        teamKey: "MAF",
        delegateId: "patchrelay-actor",
        stateId: "state-reviewing",
        stateName: "In Review",
        stateType: "started",
        workflowStates: [],
        labelIds: [],
        labels: [],
        teamLabels: [],
        blockedBy: [],
        blocks: [],
      }),
      createAgentActivity: async () => undefined,
      updateAgentSession: async () => undefined,
    };

    const enqueued: Array<{ projectId: string; issueId: string }> = [];
    const handler = new WebhookHandler(
      config,
      db,
      { forProject: async () => linearClient as LinearClient } as never,
      { steerTurn: async () => undefined } as never,
      (projectId, issueId) => {
        enqueued.push({ projectId, issueId });
      },
      pino({ enabled: false }),
    );

    const payload: LinearWebhookPayload = {
      action: "update",
      type: "Issue",
      createdAt: "2026-04-01T00:00:00.000Z",
      webhookTimestamp: Date.now(),
      updatedFrom: { stateId: "state-implementing" },
      data: {
        id: "issue-maf-child",
        identifier: "MAF-201",
        title: "Child implementation",
        parent: { id: "issue-maf-parent", identifier: "MAF-200", title: "Umbrella parent" },
        team: { id: "team-maf", key: "MAF" },
        delegateId: "patchrelay-actor",
        delegate: { id: "patchrelay-actor", name: "PatchRelay" },
        state: { id: "state-reviewing", name: "In Review", type: "started" },
      },
    };

    const stored = db.webhookEvents.insertFullWebhookEvent({
      webhookId: "delivery-orchestration-child-churn",
      receivedAt: new Date().toISOString(),
      payloadJson: JSON.stringify(payload),
    });

    await handler.processWebhookEvent(stored.id);

    assert.equal(db.issueSessions.peekPendingSessionInputPlanForDiagnostics("krasnoperov/mafia", "issue-maf-parent"), undefined);
    assert.deepEqual(
      db.issueSessions
        .listIssueSessionEvents("krasnoperov/mafia", "issue-maf-parent")
        .filter((event) => event.eventType === "child_changed" || event.eventType === "child_delivered" || event.eventType === "child_regressed"),
      [],
    );
    assert.deepEqual(enqueued, []);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});
