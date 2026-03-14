import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import pino from "pino";
import { PatchRelayDatabase } from "../src/db.ts";
import { OperatorEventFeed } from "../src/operator-feed.ts";
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
  steerError?: Error;

  async steerTurn(params: { threadId: string; turnId: string; input: string }): Promise<void> {
    if (this.steerError) {
      throw this.steerError;
    }
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
  const feed = new OperatorEventFeed(db.operatorFeed);
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
    feed,
  );

  return { config, db, linear, codex, processor, enqueuedIssues, feed };
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

function seedDesiredStage(db: PatchRelayDatabase) {
  db.workflowCoordinator.recordDesiredStage({
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
}

function createActiveStageRun(
  db: PatchRelayDatabase,
  config: AppConfig,
  options?: { threadId?: string; turnId?: string; branchName?: string; worktreePath?: string; workflowFile?: string; promptText?: string },
) {
  seedDesiredStage(db);
  const claim = db.workflowCoordinator.claimStageRun({
    projectId: "usertold",
    linearIssueId: "issue_1",
    stage: "development",
    triggerWebhookId: "delivery-start",
    branchName: options?.branchName ?? "use/USE-25",
    worktreePath: options?.worktreePath ?? path.join(config.projects[0]!.worktreeRoot, "USE-25"),
    workflowFile: options?.workflowFile ?? config.projects[0]!.workflows[0]!.workflowFile,
    promptText: options?.promptText ?? "Implement carefully.",
  });
  assert.ok(claim);
  if (options?.threadId) {
    db.workflowCoordinator.updateStageRunThread({
      stageRunId: claim.stageRun.id,
      threadId: options.threadId,
      ...(options.turnId ? { turnId: options.turnId } : {}),
    });
  }
  return claim;
}

function listInputObligations(db: PatchRelayDatabase, runLeaseId?: number) {
  return db.connection
    .prepare(
      `
      SELECT id, source, status, run_lease_id, thread_id, turn_id, last_error
      FROM obligations
      WHERE kind = 'deliver_turn_input'
        AND (? IS NULL OR run_lease_id = ?)
      ORDER BY id
      `,
    )
    .all(runLeaseId ?? null, runLeaseId ?? null) as Array<Record<string, unknown>>;
}

test("webhook processor records desired stage and enqueues matching issues", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-webhook-processor-"));
  try {
    const { db, processor, enqueuedIssues } = createHarness(baseDir);
    const receipt = db.eventReceipts.insertEventReceipt({
      source: "linear-webhook",
      externalId: "delivery-start",
      eventType: "Issue.update",
      receivedAt: new Date().toISOString(),
      acceptanceStatus: "accepted",
      linearIssueId: "issue_1",
    });
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
    const issueControl = db.issueControl.getIssueControl("usertold", "issue_1");
    assert.equal(issue?.desiredStage, "development");
    assert.equal(issueControl?.desiredStage, "development");
    assert.equal(issueControl?.desiredReceiptId, receipt.id);
    assert.equal(issueControl?.lifecycleStatus, "queued");
    assert.equal(db.webhookEvents.getWebhookEvent(event.id)?.processingStatus, "processed");
    assert.equal(db.eventReceipts.getEventReceipt(receipt.id)?.processingStatus, "processed");
    assert.equal(db.eventReceipts.getEventReceipt(receipt.id)?.projectId, "usertold");
    assert.deepEqual(enqueuedIssues, [{ projectId: "usertold", issueId: "issue_1" }]);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("webhook processor enqueues delegated issueCreated events when Start matches a workflow", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-webhook-processor-issue-created-"));
  try {
    const { config, db, processor, enqueuedIssues } = createHarness(baseDir);
    config.projects[0]!.triggerEvents = [...config.projects[0]!.triggerEvents, "issueCreated"];
    installPatchRelayApp(db);
    const receipt = db.eventReceipts.insertEventReceipt({
      source: "linear-webhook",
      externalId: "delivery-created-start",
      eventType: "Issue.create",
      receivedAt: new Date().toISOString(),
      acceptanceStatus: "accepted",
      linearIssueId: "issue_1",
    });
    const event = db.webhookEvents.insertWebhookEvent({
      webhookId: "delivery-created-start",
      receivedAt: new Date().toISOString(),
      eventType: "Issue.create",
      issueId: "issue_1",
      headersJson: "{}",
      payloadJson: JSON.stringify({
        action: "create",
        type: "Issue",
        createdAt: "2026-03-08T12:00:00.000Z",
        webhookTimestamp: 1000,
        data: {
          id: "issue_1",
          identifier: "USE-25",
          title: "Build app server orchestration",
          url: "https://linear.app/example/issue/USE-25",
          team: { key: "USE" },
          delegate: { id: "patchrelay-app", name: "PatchRelay" },
          state: { name: "Start" },
        },
      }),
      signatureValid: true,
      dedupeStatus: "accepted",
    });

    await processor.processWebhookEvent(event.id);

    const issue = db.issueWorkflows.getTrackedIssue("usertold", "issue_1");
    const issueControl = db.issueControl.getIssueControl("usertold", "issue_1");
    assert.equal(issue?.desiredStage, "development");
    assert.equal(issueControl?.desiredStage, "development");
    assert.equal(issueControl?.desiredReceiptId, receipt.id);
    assert.equal(issueControl?.lifecycleStatus, "queued");
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
    const claim = createActiveStageRun(db, config, { threadId: "thread-1", turnId: "turn-1" });

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

    assert.equal(codex.steeredTurns.length, 1);
    assert.match(codex.steeredTurns[0]!.input, /Please add tests/);
    assert.equal(db.obligations.listPendingObligations({ runLeaseId: claim.stageRun.id }).length, 0);
    const obligations = listInputObligations(db, claim.stageRun.id);
    assert.equal(obligations.length, 1);
    assert.equal(obligations[0]?.status, "completed");
    assert.match(String(obligations[0]?.source), /^linear-agent-prompt:session-1:/);
    assert.equal(obligations[0]?.thread_id, "thread-1");
    assert.equal(obligations[0]?.turn_id, "turn-1");
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

test("webhook processor records durable comment obligations for later delivery when no thread is active", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-webhook-processor-comment-obligation-"));
  try {
    const { config, db, processor } = createHarness(baseDir);
    const claim = createActiveStageRun(db, config);

    const event = db.webhookEvents.insertWebhookEvent({
      webhookId: "delivery-comment-obligation",
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
          id: "comment_2",
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

    const obligations = db.obligations.listPendingObligations({ runLeaseId: claim.stageRun.id });
    assert.equal(obligations.length, 1);
    assert.equal(obligations[0]?.source, "linear-comment:comment_2");
    assert.equal(obligations[0]?.threadId, undefined);
    assert.equal(obligations[0]?.turnId, undefined);
    const stored = listInputObligations(db, claim.stageRun.id);
    assert.equal(stored.length, 1);
    assert.equal(stored[0]?.status, "pending");
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("webhook processor dedupes duplicate comment deliveries before enqueuing turn input", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-webhook-processor-comment-dedupe-"));
  try {
    const { config, db, processor } = createHarness(baseDir);
    const claim = createActiveStageRun(db, config);

    const duplicatePayload = JSON.stringify({
      action: "create",
      type: "Comment",
      createdAt: "2026-03-08T12:05:00.000Z",
      webhookTimestamp: 1000,
      data: {
        id: "comment_2",
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
    });
    const firstEvent = db.webhookEvents.insertWebhookEvent({
      webhookId: "delivery-comment-dedupe-1",
      receivedAt: new Date().toISOString(),
      eventType: "Comment.create",
      issueId: "issue_1",
      headersJson: "{}",
      payloadJson: duplicatePayload,
      signatureValid: true,
      dedupeStatus: "accepted",
    });
    const secondEvent = db.webhookEvents.insertWebhookEvent({
      webhookId: "delivery-comment-dedupe-2",
      receivedAt: new Date().toISOString(),
      eventType: "Comment.create",
      issueId: "issue_1",
      headersJson: "{}",
      payloadJson: duplicatePayload,
      signatureValid: true,
      dedupeStatus: "accepted",
    });

    await processor.processWebhookEvent(firstEvent.id);
    await processor.processWebhookEvent(secondEvent.id);

    assert.equal(db.obligations.listPendingObligations({ runLeaseId: claim.stageRun.id }).length, 1);
    assert.equal(listInputObligations(db, claim.stageRun.id).length, 1);
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
    const claim = createActiveStageRun(db, config, { threadId: "thread-1", turnId: "turn-1" });

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
    assert.equal(db.obligations.listPendingObligations({ runLeaseId: claim.stageRun.id }).length, 0);
    assert.equal(listInputObligations(db, claim.stageRun.id).length, 0);
    assert.deepEqual(enqueuedIssues, []);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("webhook processor does not enqueue launch input from prompted sessions when agentPrompted is disabled", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-webhook-processor-prompt-launch-disabled-"));
  try {
    const { config, db, codex, processor, enqueuedIssues } = createHarness(baseDir);
    config.projects[0]!.triggerEvents = ["statusChanged"];
    installPatchRelayApp(db);

    const event = db.webhookEvents.insertWebhookEvent({
      webhookId: "delivery-agent-prompt-disabled-no-run",
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
            body: "Please start this now.",
          },
          agentSession: {
            id: "session-2",
            issue: {
              id: "issue_1",
              identifier: "USE-25",
              title: "Build app server orchestration",
              team: { key: "USE" },
              delegate: { id: "patchrelay-app", name: "PatchRelay" },
              state: { name: "Start" },
            },
          },
        },
      }),
      signatureValid: true,
      dedupeStatus: "accepted",
    });

    await processor.processWebhookEvent(event.id);

    assert.equal(codex.steeredTurns.length, 0);
    assert.equal(db.obligations.listPendingObligations({ kind: "deliver_turn_input" }).length, 0);
    assert.equal(listInputObligations(db).length, 0);
    assert.equal(db.issueControl.getIssueControl("usertold", "issue_1")?.desiredStage, undefined);
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
    const claim = createActiveStageRun(db, config, { threadId: "thread-1", turnId: "turn-1" });

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
    assert.equal(db.obligations.listPendingObligations({ runLeaseId: claim.stageRun.id }).length, 0);
    assert.equal(listInputObligations(db, claim.stageRun.id).length, 0);
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

test("webhook processor reports queued follow-up instructions when active delivery fails", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-webhook-processor-agent-prompt-queued-"));
  try {
    const { config, db, linear, codex, processor } = createHarness(baseDir);
    installPatchRelayApp(db);
    const claim = createActiveStageRun(db, config, {
      branchName: "use/USE-25-build-app-server-orchestration",
      worktreePath: path.join(baseDir, "worktrees", "USE-25"),
      workflowFile: path.join(baseDir, "DEVELOPMENT_WORKFLOW.md"),
      promptText: "Implement it",
      threadId: "thread-1",
      turnId: "turn-1",
    });
    codex.steerError = new Error("codex temporarily unavailable");

    const event = db.webhookEvents.insertWebhookEvent({
      webhookId: "delivery-agent-prompt-queued",
      receivedAt: new Date().toISOString(),
      eventType: "AgentSessionEvent.prompted",
      issueId: "issue_1",
      headersJson: "{}",
      payloadJson: JSON.stringify({
        action: "prompted",
        type: "AgentSessionEvent",
        createdAt: "2026-03-08T12:00:00.000Z",
        webhookTimestamp: 1000,
        data: {
          agentActivity: {
            body: "Please update the tests.",
          },
          agentSession: {
            id: "session-queued",
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
    const queuedActivity = linear.agentActivities.find(
      (activity) => activity.agentSessionId === "session-queued" && activity.content.type === "thought",
    );
    assert.ok(queuedActivity);
    assert.match(String(queuedActivity.content.body), /follow-up instructions|queued/i);
    assert.doesNotMatch(String(queuedActivity.content.body), /routed your follow-up instructions/i);
    const obligations = db.obligations.listPendingObligations({ runLeaseId: claim.stageRun.id, kind: "deliver_turn_input" });
    assert.equal(obligations.length, 1);
    assert.equal(obligations[0]?.status, "pending");
    const stored = listInputObligations(db, claim.stageRun.id);
    assert.equal(stored.length, 1);
    assert.equal(stored[0]?.last_error, "codex temporarily unavailable");
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("webhook processor publishes delivered agent prompt observations to the operator feed", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-webhook-processor-agent-feed-"));
  try {
    const { config, db, codex, processor, feed } = createHarness(baseDir);
    installPatchRelayApp(db);
    createActiveStageRun(db, config, {
      threadId: "thread-1",
      turnId: "turn-1",
    });

    const event = db.webhookEvents.insertWebhookEvent({
      webhookId: "delivery-agent-prompt-feed",
      receivedAt: new Date().toISOString(),
      eventType: "AgentSessionEvent.prompted",
      issueId: "issue_1",
      headersJson: "{}",
      payloadJson: JSON.stringify({
        action: "prompted",
        type: "AgentSessionEvent",
        createdAt: "2026-03-08T12:00:00.000Z",
        webhookTimestamp: 1000,
        data: {
          agentActivity: {
            body: "Please tighten the tests.",
          },
          agentSession: {
            id: "session-feed",
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

    const deliveryEvent = feed.list({ issueKey: "USE-25" }).find((entry) => entry.kind === "agent" && entry.status === "delivered");
    assert.ok(deliveryEvent);
    assert.match(deliveryEvent.summary, /Delivered follow-up prompt/);
    assert.equal(deliveryEvent.stage, "development");
    assert.equal(codex.steeredTurns.length, 1);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("webhook processor publishes failed comment delivery observations to the operator feed", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-webhook-processor-comment-feed-"));
  try {
    const { config, db, codex, processor, feed } = createHarness(baseDir);
    installPatchRelayApp(db);
    createActiveStageRun(db, config, {
      threadId: "thread-1",
      turnId: "turn-1",
    });
    codex.steerError = new Error("comment delivery timed out");

    const event = db.webhookEvents.insertWebhookEvent({
      webhookId: "delivery-comment-feed",
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
          id: "comment-feed",
          body: "Please also refresh the docs.",
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

    const deliveryEvent = feed.list({ issueKey: "USE-25" }).find((entry) => entry.kind === "comment" && entry.status === "delivery_failed");
    assert.ok(deliveryEvent);
    assert.match(deliveryEvent.summary, /Could not deliver follow-up comment/);
    assert.match(deliveryEvent.detail ?? "", /Alex/);
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
