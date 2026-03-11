import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import pino from "pino";
import { PatchRelayDatabase } from "../src/db.ts";
import { ServiceWebhookProcessor } from "../src/service-webhook-processor.ts";
import type { AppConfig, LinearAgentActivityContent, LinearClient, LinearIssueSnapshot } from "../src/types.ts";

const DEFAULT_WORKFLOW_STATES = [
  { id: "start", name: "Start" },
  { id: "implementing", name: "Implementing" },
  { id: "review", name: "Review" },
  { id: "reviewing", name: "Reviewing" },
];

class FakeLinearClient implements LinearClient {
  readonly issues = new Map<string, LinearIssueSnapshot>();
  readonly agentActivities: Array<{ agentSessionId: string; content: LinearAgentActivityContent; ephemeral: boolean }> = [];

  async getIssue(issueId: string): Promise<LinearIssueSnapshot> {
    const issue = this.issues.get(issueId);
    assert.ok(issue);
    return issue;
  }

  async setIssueState(issueId: string, stateName: string): Promise<LinearIssueSnapshot> {
    const issue = await this.getIssue(issueId);
    const nextIssue = { ...issue, stateName };
    this.issues.set(issueId, nextIssue);
    return nextIssue;
  }

  async upsertIssueComment(params: { issueId: string; commentId?: string; body: string }) {
    return { id: params.commentId ?? "comment-1", body: params.body };
  }

  async createAgentActivity(params: {
    agentSessionId: string;
    content: LinearAgentActivityContent;
    ephemeral?: boolean;
  }) {
    this.agentActivities.push({
      agentSessionId: params.agentSessionId,
      content: params.content,
      ephemeral: params.ephemeral ?? false,
    });
    return { id: `agent-activity-${this.agentActivities.length}` };
  }

  async updateIssueLabels(): Promise<LinearIssueSnapshot> {
    throw new Error("not implemented in this test");
  }

  async getActorProfile() {
    return {};
  }
}

class FakeCodexClient {
  readonly steeredTurns: Array<{ threadId: string; turnId: string; input: string }> = [];

  async steerTurn(params: { threadId: string; turnId: string; input: string }): Promise<void> {
    this.steeredTurns.push(params);
  }
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
        actor: "app",
      },
      tokenEncryptionKey: "0123456789abcdef0123456789abcdef",
    },
    operatorApi: {
      enabled: false,
    },
    runner: {
      gitBin: "git",
      codex: {
        bin: "codex",
        args: ["app-server"],
        approvalPolicy: "never",
        sandboxMode: "danger-full-access",
        persistExtendedHistory: true,
      },
    },
    projects: [
      {
        id: "usertold",
        repoPath: path.join(baseDir, "repo"),
        worktreeRoot: path.join(baseDir, "worktrees"),
        workflows: [
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
        ],
        issueKeyPrefixes: ["USE"],
        linearTeamIds: ["USE"],
        allowLabels: [],
        trustedActors: {
          ids: [],
          names: [],
          emails: [],
          emailDomains: [],
        },
        triggerEvents: ["statusChanged", "commentCreated", "commentUpdated", "agentPrompted"],
        branchPrefix: "use",
      },
    ],
  };
}

function createHarness(baseDir: string) {
  const config = createConfig(baseDir);
  const db = new PatchRelayDatabase(config.database.path, true);
  db.runMigrations();

  const linear = new FakeLinearClient();
  const codex = new FakeCodexClient();
  linear.issues.set("issue_1", {
    id: "issue_1",
    identifier: "USE-25",
    title: "Build app server orchestration",
    stateId: "start",
    stateName: "Start",
    teamId: "USE",
    teamKey: "USE",
    workflowStates: DEFAULT_WORKFLOW_STATES,
    labelIds: [],
    labels: [],
    teamLabels: [],
  });

  const enqueuedIssues: Array<{ projectId: string; issueId: string }> = [];
  const processor = new ServiceWebhookProcessor(
    config,
    db,
    {
      async forProject(projectId: string) {
        return projectId === "usertold" ? linear : undefined;
      },
    },
    codex as never,
    (projectId, issueId) => {
      enqueuedIssues.push({ projectId, issueId });
    },
    pino({ enabled: false }),
  );

  return { config, db, linear, codex, processor, enqueuedIssues };
}

function installPatchRelayApp(db: PatchRelayDatabase, projectId = "usertold", actorId = "patchrelay-app") {
  const installation = db.linearInstallations.saveLinearInstallation({
    workspaceId: "workspace-1",
    workspaceName: "Workspace One",
    workspaceKey: "WS1",
    actorId,
    actorName: "PatchRelay",
    accessTokenCiphertext: "ciphertext",
    scopesJson: JSON.stringify(["read", "write"]),
  });
  db.linearInstallations.linkProjectInstallation(projectId, installation.id);
  return installation;
}

test("webhook processor records desired stage and enqueues matching issues", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-webhook-processor-"));
  try {
    const { db, processor, enqueuedIssues } = createHarness(baseDir);
    const event = db.webhookEvents.insertWebhookEvent({
      webhookId: "delivery-start",
      receivedAt: new Date().toISOString(),
      eventType: "Issue.update",
      issueId: "issue_1",
      headersJson: "{}",
      payloadJson: JSON.stringify({
        action: "update",
        type: "Issue",
        createdAt: "2026-03-08T12:00:00.000Z",
        webhookTimestamp: 1000,
        updatedFrom: { stateId: "todo" },
        data: {
          id: "issue_1",
          identifier: "USE-25",
          title: "Build app server orchestration",
          url: "https://linear.app/example/issue/USE-25",
          team: { key: "USE" },
          state: { name: "Start" },
        },
      }),
      signatureValid: true,
      dedupeStatus: "accepted",
    });

    await processor.processWebhookEvent(event.id);

    const issue = db.issueWorkflows.getTrackedIssue("usertold", "issue_1");
    assert.equal(issue?.desiredStage, "development");
    assert.equal(db.webhookEvents.getWebhookEvent(event.id)?.processingStatus, "processed");
    assert.deepEqual(enqueuedIssues, [{ projectId: "usertold", issueId: "issue_1" }]);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("webhook processor routes prompted agent follow-ups into the active stage", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-webhook-processor-active-"));
  try {
    const { config, db, linear, codex, processor, enqueuedIssues } = createHarness(baseDir);
    installPatchRelayApp(db);

    db.issueWorkflows.recordDesiredStage({
      projectId: "usertold",
      linearIssueId: "issue_1",
      issueKey: "USE-25",
      title: "Build app server orchestration",
      issueUrl: "https://linear.app/example/issue/USE-25",
      currentLinearState: "Implementing",
      desiredStage: "development",
      desiredWebhookId: "delivery-start",
      lastWebhookAt: new Date().toISOString(),
    });
    const claim = db.issueWorkflows.claimStageRun({
      projectId: "usertold",
      linearIssueId: "issue_1",
      stage: "development",
      triggerWebhookId: "delivery-start",
      branchName: "use/USE-25",
      worktreePath: path.join(config.projects[0].worktreeRoot, "USE-25"),
      workflowFile: config.projects[0].workflows[0]!.workflowFile,
      promptText: "Implement carefully.",
    });
    assert.ok(claim);
    db.issueWorkflows.updateStageRunThread({
      stageRunId: claim.stageRun.id,
      threadId: "thread-1",
      turnId: "turn-1",
    });

    const event = db.webhookEvents.insertWebhookEvent({
      webhookId: "delivery-agent-prompt",
      receivedAt: new Date().toISOString(),
      eventType: "AgentSessionEvent.prompted",
      issueId: "issue_1",
      headersJson: "{}",
      payloadJson: JSON.stringify({
        action: "prompted",
        type: "AgentSessionEvent",
        createdAt: "2026-03-08T12:05:00.000Z",
        webhookTimestamp: 1005,
        data: {
          agentActivity: {
            body: "Please add tests for the queueing behavior.",
          },
          agentSession: {
            id: "session-1",
            issue: {
              id: "issue_1",
              identifier: "USE-25",
              title: "Build app server orchestration",
              team: { key: "USE" },
              delegate: { id: "patchrelay-app", name: "PatchRelay" },
              state: { name: "Implementing" },
            },
          },
        },
      }),
      signatureValid: true,
      dedupeStatus: "accepted",
    });

    await processor.processWebhookEvent(event.id);

    const pending = db.stageEvents.listPendingTurnInputs(claim.stageRun.id);
    assert.equal(pending.length, 0);
    assert.equal(codex.steeredTurns.length, 1);
    assert.match(codex.steeredTurns[0]!.input, /Please add tests/);
    assert.deepEqual(enqueuedIssues, []);
    assert.ok(
      linear.agentActivities.some(
        (activity) =>
          activity.agentSessionId === "session-1" &&
          activity.content.type === "thought" &&
          activity.ephemeral === true,
      ),
    );
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("webhook processor ignores out-of-scope issues even in a single-project setup", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-webhook-processor-routing-"));
  try {
    const { db, processor, enqueuedIssues } = createHarness(baseDir);
    const event = db.webhookEvents.insertWebhookEvent({
      webhookId: "delivery-out-of-scope",
      receivedAt: new Date().toISOString(),
      eventType: "Issue.update",
      issueId: "issue_foreign",
      headersJson: "{}",
      payloadJson: JSON.stringify({
        action: "update",
        type: "Issue",
        createdAt: "2026-03-08T12:00:00.000Z",
        webhookTimestamp: 1000,
        updatedFrom: { stateId: "todo" },
        data: {
          id: "issue_foreign",
          identifier: "OPS-25",
          title: "Outside configured scope",
          url: "https://linear.app/example/issue/OPS-25",
          team: { key: "OPS" },
          state: { name: "Start" },
        },
      }),
      signatureValid: true,
      dedupeStatus: "accepted",
    });

    await processor.processWebhookEvent(event.id);

    assert.equal(db.issueWorkflows.getTrackedIssueByKey("OPS-25"), undefined);
    assert.equal(db.webhookEvents.getWebhookEvent(event.id)?.processingStatus, "processed");
    assert.deepEqual(enqueuedIssues, []);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("webhook processor does not steer prompted agent follow-ups when agentPrompted is disabled", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-webhook-processor-prompt-triggers-"));
  try {
    const { config, db, codex, processor, enqueuedIssues } = createHarness(baseDir);
    config.projects[0]!.triggerEvents = ["statusChanged"];
    installPatchRelayApp(db);

    db.issueWorkflows.recordDesiredStage({
      projectId: "usertold",
      linearIssueId: "issue_1",
      issueKey: "USE-25",
      title: "Build app server orchestration",
      issueUrl: "https://linear.app/example/issue/USE-25",
      currentLinearState: "Implementing",
      desiredStage: "development",
      desiredWebhookId: "delivery-start",
      lastWebhookAt: new Date().toISOString(),
    });
    const claim = db.issueWorkflows.claimStageRun({
      projectId: "usertold",
      linearIssueId: "issue_1",
      stage: "development",
      triggerWebhookId: "delivery-start",
      branchName: "use/USE-25",
      worktreePath: path.join(config.projects[0]!.worktreeRoot, "USE-25"),
      workflowFile: config.projects[0]!.workflows[0]!.workflowFile,
      promptText: "Implement carefully.",
    });
    assert.ok(claim);
    db.issueWorkflows.updateStageRunThread({
      stageRunId: claim.stageRun.id,
      threadId: "thread-1",
      turnId: "turn-1",
    });

    const event = db.webhookEvents.insertWebhookEvent({
      webhookId: "delivery-agent-prompt-disabled",
      receivedAt: new Date().toISOString(),
      eventType: "AgentSessionEvent.prompted",
      issueId: "issue_1",
      headersJson: "{}",
      payloadJson: JSON.stringify({
        action: "prompted",
        type: "AgentSessionEvent",
        createdAt: "2026-03-08T12:05:00.000Z",
        webhookTimestamp: 1005,
        data: {
          agentActivity: {
            body: "Please add tests for the queueing behavior.",
          },
          agentSession: {
            id: "session-1",
            issue: {
              id: "issue_1",
              identifier: "USE-25",
              title: "Build app server orchestration",
              team: { key: "USE" },
              delegate: { id: "patchrelay-app", name: "PatchRelay" },
              state: { name: "Implementing" },
            },
          },
        },
      }),
      signatureValid: true,
      dedupeStatus: "accepted",
    });

    await processor.processWebhookEvent(event.id);

    assert.equal(codex.steeredTurns.length, 0);
    assert.equal(db.stageEvents.listPendingTurnInputs(claim.stageRun.id).length, 0);
    assert.deepEqual(enqueuedIssues, []);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("webhook processor does not steer issue comments when comment triggers are disabled", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-webhook-processor-comment-triggers-"));
  try {
    const { config, db, codex, processor } = createHarness(baseDir);
    config.projects[0]!.triggerEvents = ["statusChanged"];

    db.issueWorkflows.recordDesiredStage({
      projectId: "usertold",
      linearIssueId: "issue_1",
      issueKey: "USE-25",
      title: "Build app server orchestration",
      issueUrl: "https://linear.app/example/issue/USE-25",
      currentLinearState: "Implementing",
      desiredStage: "development",
      desiredWebhookId: "delivery-start",
      lastWebhookAt: new Date().toISOString(),
    });
    const claim = db.issueWorkflows.claimStageRun({
      projectId: "usertold",
      linearIssueId: "issue_1",
      stage: "development",
      triggerWebhookId: "delivery-start",
      branchName: "use/USE-25",
      worktreePath: path.join(config.projects[0]!.worktreeRoot, "USE-25"),
      workflowFile: config.projects[0]!.workflows[0]!.workflowFile,
      promptText: "Implement carefully.",
    });
    assert.ok(claim);
    db.issueWorkflows.updateStageRunThread({
      stageRunId: claim.stageRun.id,
      threadId: "thread-1",
      turnId: "turn-1",
    });

    const event = db.webhookEvents.insertWebhookEvent({
      webhookId: "delivery-comment-disabled",
      receivedAt: new Date().toISOString(),
      eventType: "Comment.create",
      issueId: "issue_1",
      headersJson: "{}",
      payloadJson: JSON.stringify({
        action: "create",
        type: "Comment",
        createdAt: "2026-03-08T12:05:00.000Z",
        webhookTimestamp: 1000,
        data: {
          id: "comment_1",
          body: "Please also update the docs.",
          user: { name: "Alex" },
          issue: {
            id: "issue_1",
            identifier: "USE-25",
            title: "Build app server orchestration",
            team: { key: "USE" },
            state: { name: "Implementing" },
          },
        },
      }),
      signatureValid: true,
      dedupeStatus: "accepted",
    });

    await processor.processWebhookEvent(event.id);

    assert.equal(codex.steeredTurns.length, 0);
    assert.equal(db.stageEvents.listPendingTurnInputs(claim.stageRun.id).length, 0);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("webhook processor keeps mention-only sessions conversational instead of enqueuing work", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-webhook-processor-mentioned-"));
  try {
    const { db, linear, processor, enqueuedIssues } = createHarness(baseDir);
    installPatchRelayApp(db);

    const event = db.webhookEvents.insertWebhookEvent({
      webhookId: "delivery-agent-created-mentioned",
      receivedAt: new Date().toISOString(),
      eventType: "AgentSessionEvent.created",
      issueId: "issue_1",
      headersJson: "{}",
      payloadJson: JSON.stringify({
        action: "created",
        type: "AgentSessionEvent",
        createdAt: "2026-03-08T12:00:00.000Z",
        webhookTimestamp: 1000,
        data: {
          promptContext: "Can you check this one?",
          agentSession: {
            id: "session-mentioned",
            issue: {
              id: "issue_1",
              identifier: "USE-25",
              title: "Build app server orchestration",
              team: { key: "USE" },
              state: { name: "Start" },
            },
          },
        },
      }),
      signatureValid: true,
      dedupeStatus: "accepted",
    });

    await processor.processWebhookEvent(event.id);

    assert.deepEqual(enqueuedIssues, []);
    assert.equal(db.issueWorkflows.getTrackedIssue("usertold", "issue_1")?.desiredStage, undefined);
    assert.ok(
      linear.agentActivities.some(
        (activity) =>
          activity.agentSessionId === "session-mentioned" &&
          activity.content.type === "elicitation" &&
          String(activity.content.body).includes("Delegate the issue to PatchRelay"),
      ),
    );
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("webhook processor handles installation-only webhooks without enqueuing issue work", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-webhook-processor-installation-"));
  try {
    const { db, processor, enqueuedIssues } = createHarness(baseDir);
    const installation = db.linearInstallations.saveLinearInstallation({
      actorId: "app_user_1",
      actorName: "PatchRelay",
      accessTokenCiphertext: "ciphertext",
      scopesJson: JSON.stringify(["read", "write"]),
    });
    db.linearInstallations.linkProjectInstallation("usertold", installation.id);

    const event = db.webhookEvents.insertWebhookEvent({
      webhookId: "delivery-permission-change",
      receivedAt: new Date().toISOString(),
      eventType: "PermissionChange.teamAccessChanged",
      headersJson: "{}",
      payloadJson: JSON.stringify({
        action: "teamAccessChanged",
        type: "PermissionChange",
        createdAt: "2026-03-10T12:00:00.000Z",
        webhookTimestamp: 1000,
        data: {
          organizationId: "org_1",
          oauthClientId: "oauth-client-1",
          appUserId: "app_user_1",
          addedTeamIds: ["team_added"],
          removedTeamIds: ["team_removed"],
          canAccessAllPublicTeams: false,
        },
      }),
      signatureValid: true,
      dedupeStatus: "accepted",
    });

    await processor.processWebhookEvent(event.id);

    assert.equal(db.webhookEvents.getWebhookEvent(event.id)?.processingStatus, "processed");
    assert.deepEqual(enqueuedIssues, []);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});
