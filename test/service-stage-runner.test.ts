import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import pino from "pino";
import { PatchRelayDatabase } from "../src/db.ts";
import { ServiceStageRunner } from "../src/service-stage-runner.ts";
import type { AppConfig, CodexThreadSummary, LinearClient, LinearIssueSnapshot } from "../src/types.ts";

const WORKFLOW_STATES = [
  { id: "start", name: "Start" },
  { id: "implementing", name: "Implementing" },
  { id: "review", name: "Review" },
  { id: "human-needed", name: "Human Needed" },
];

function createWorkflows(baseDir: string) {
  return [
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
    {
      id: "deploy",
      whenState: "Deploy",
      activeState: "Deploying",
      workflowFile: path.join(baseDir, "DEPLOY_WORKFLOW.md"),
      fallbackState: "Human Needed",
    },
    {
      id: "cleanup",
      whenState: "Cleanup",
      activeState: "Cleaning Up",
      workflowFile: path.join(baseDir, "CLEANUP_WORKFLOW.md"),
      fallbackState: "Human Needed",
    },
  ];
}

class FakeCodexClient {
  readonly startedThreads: Array<{ cwd: string }> = [];
  readonly forkedThreads: Array<{ parentThreadId: string; cwd?: string }> = [];
  readonly startedTurns: Array<{ threadId: string; cwd: string; input: string }> = [];
  readonly steeredTurns: Array<{ threadId: string; turnId: string; input: string }> = [];
  startTurnError?: Error;
  private nextThreadNumber = 1;
  private nextTurnNumber = 1;

  async startThread(params: { cwd: string }): Promise<CodexThreadSummary> {
    this.startedThreads.push(params);
    return {
      id: `thread-${this.nextThreadNumber++}`,
      preview: "PatchRelay stage",
      cwd: params.cwd,
      status: "idle",
      turns: [],
    };
  }

  async forkThread(parentThreadId: string, cwd?: string): Promise<CodexThreadSummary> {
    this.forkedThreads.push({ parentThreadId, cwd });
    return {
      id: `thread-${this.nextThreadNumber++}`,
      preview: "PatchRelay stage",
      cwd: cwd ?? process.cwd(),
      status: "idle",
      turns: [],
    };
  }

  async startTurn(params: { threadId: string; cwd: string; input: string }): Promise<{ threadId: string; turnId: string; status: string }> {
    if (this.startTurnError) {
      throw this.startTurnError;
    }
    this.startedTurns.push(params);
    return {
      threadId: params.threadId,
      turnId: `turn-${this.nextTurnNumber++}`,
      status: "inProgress",
    };
  }

  async steerTurn(params: { threadId: string; turnId: string; input: string }): Promise<void> {
    this.steeredTurns.push(params);
  }
}

class FakeLinearClient implements LinearClient {
  readonly issues = new Map<string, LinearIssueSnapshot>();
  readonly stateTransitions: Array<{ issueId: string; stateName: string }> = [];
  readonly labelUpdates: Array<{ issueId: string; addNames: string[]; removeNames: string[] }> = [];
  readonly comments = new Map<string, { id: string; issueId: string; body: string }>();
  readonly agentActivities: Array<{ agentSessionId: string; content: Record<string, unknown>; ephemeral?: boolean }> = [];
  private nextCommentNumber = 1;

  async getIssue(issueId: string): Promise<LinearIssueSnapshot> {
    const issue = this.issues.get(issueId);
    assert.ok(issue);
    return issue;
  }

  async setIssueState(issueId: string, stateName: string): Promise<LinearIssueSnapshot> {
    const issue = await this.getIssue(issueId);
    const state = issue.workflowStates.find((entry) => entry.name === stateName);
    assert.ok(state);
    const nextIssue = {
      ...issue,
      stateId: state.id,
      stateName: state.name,
    };
    this.issues.set(issueId, nextIssue);
    this.stateTransitions.push({ issueId, stateName });
    return nextIssue;
  }

  async updateIssueLabels(params: { issueId: string; addNames?: string[]; removeNames?: string[] }): Promise<LinearIssueSnapshot> {
    this.labelUpdates.push({
      issueId: params.issueId,
      addNames: params.addNames ?? [],
      removeNames: params.removeNames ?? [],
    });
    return await this.getIssue(params.issueId);
  }

  async upsertIssueComment(params: { issueId: string; commentId?: string; body: string }): Promise<{ id: string; body: string }> {
    const id = params.commentId ?? `comment-${this.nextCommentNumber++}`;
    this.comments.set(id, { id, issueId: params.issueId, body: params.body });
    return { id, body: params.body };
  }

  async createAgentActivity(params: { agentSessionId: string; content: Record<string, unknown>; ephemeral?: boolean }): Promise<{ id: string }> {
    this.agentActivities.push(params);
    return { id: `activity-${this.agentActivities.length}` };
  }

  async getActorProfile() {
    return {};
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
        persistExtendedHistory: false,
        serviceName: "patchrelay-test",
      },
    },
    projects: [
      {
        id: "usertold",
        repoPath: path.join(baseDir, "repo"),
        worktreeRoot: path.join(baseDir, "worktrees"),
        workflows: createWorkflows(baseDir),
        workflowLabels: {
          working: "llm-working",
          awaitingHandoff: "llm-awaiting-handoff",
        },
        issueKeyPrefixes: ["USE"],
        linearTeamIds: ["USE"],
        allowLabels: [],
        trustedActors: { ids: [], names: [], emails: [], emailDomains: [] },
        triggerEvents: ["statusChanged", "commentCreated", "commentUpdated", "agentPrompted"],
        branchPrefix: "use",
      },
    ],
  };
}

function setupRepo(config: AppConfig): void {
  const repoPath = config.projects[0]!.repoPath;
  mkdirSync(repoPath, { recursive: true });
  execFileSync("git", ["init", repoPath], { stdio: "ignore" });
  execFileSync("git", ["-C", repoPath, "config", "user.email", "patchrelay@example.com"], { stdio: "ignore" });
  execFileSync("git", ["-C", repoPath, "config", "user.name", "PatchRelay"], { stdio: "ignore" });
  writeFileSync(path.join(repoPath, "README.md"), "# test\n", "utf8");
  execFileSync("git", ["-C", repoPath, "add", "."], { stdio: "ignore" });
  execFileSync("git", ["-C", repoPath, "-c", "commit.gpgsign=false", "commit", "-m", "initial"], { stdio: "ignore" });

  for (const workflow of config.projects[0]!.workflows) {
    writeFileSync(workflow.workflowFile, `${workflow.id} carefully.\n`, "utf8");
  }
}

function createHarness(baseDir: string) {
  const config = createConfig(baseDir);
  setupRepo(config);
  const db = new PatchRelayDatabase(config.database.path, true);
  db.runMigrations();
  const codex = new FakeCodexClient();
  const linear = new FakeLinearClient();
  linear.issues.set("issue-1", {
    id: "issue-1",
    identifier: "USE-25",
    title: "Build app server orchestration",
    url: "https://linear.app/example/issue/USE-25",
    stateId: "start",
    stateName: "Start",
    teamId: "USE",
    teamKey: "USE",
    workflowStates: WORKFLOW_STATES,
    labelIds: [],
    labels: [],
    teamLabels: [
      { id: "label-working", name: "llm-working" },
      { id: "label-awaiting", name: "llm-awaiting-handoff" },
    ],
  });
  const runner = new ServiceStageRunner(
    config,
    db as never,
    codex as never,
    {
      async forProject(projectId: string) {
        return projectId === "usertold" ? linear : undefined;
      },
    },
    pino({ enabled: false }),
  );
  return { config, db, codex, linear, runner };
}

function queueDesiredStage(db: PatchRelayDatabase, options?: { createLegacyMirror?: boolean; pendingLaunchInput?: string }) {
  if (options?.createLegacyMirror) {
    db.issueWorkflows.recordDesiredStage({
      projectId: "usertold",
      linearIssueId: "issue-1",
      issueKey: "USE-25",
      title: "Build app server orchestration",
      issueUrl: "https://linear.app/example/issue/USE-25",
      currentLinearState: "Start",
      desiredStage: "development",
      desiredWebhookId: "delivery-start",
      lastWebhookAt: "2026-03-12T10:00:00.000Z",
    });
    if (options.pendingLaunchInput) {
      db.issueWorkflows.setIssuePendingLaunchInput("usertold", "issue-1", options.pendingLaunchInput);
    }
  }

  const receipt = db.eventReceipts.insertEventReceipt({
    source: "linear-webhook",
    externalId: "delivery-start",
    eventType: "Issue.update",
    receivedAt: "2026-03-12T10:00:00.000Z",
    acceptanceStatus: "accepted",
    projectId: "usertold",
    linearIssueId: "issue-1",
  });
  db.issueControl.upsertIssueControl({
    projectId: "usertold",
    linearIssueId: "issue-1",
    desiredStage: "development",
    desiredReceiptId: receipt.id,
    lifecycleStatus: "queued",
  });
}

test("stage runner launches a queued ledger intent and records active lease ownership", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-stage-runner-"));
  try {
    const { config, db, codex, linear, runner } = createHarness(baseDir);
    queueDesiredStage(db);

    await runner.run({ projectId: "usertold", issueId: "issue-1" });

    assert.equal(codex.startedThreads.length, 1);
    assert.equal(codex.startedTurns.length, 1);

    const issue = db.issueWorkflows.getTrackedIssue("usertold", "issue-1");
    assert.ok(issue);
    assert.equal(issue.issueKey, "USE-25");
    assert.equal(issue.currentLinearState, "Implementing");
    assert.equal(issue.lifecycleStatus, "running");
    assert.ok(issue.activeStageRunId);

    const issueControl = db.issueControl.getIssueControl("usertold", "issue-1");
    assert.ok(issueControl?.activeRunLeaseId);
    assert.equal(issueControl?.desiredStage, undefined);
    assert.equal(issueControl?.lifecycleStatus, "running");

    const runLease = db.runLeases.getRunLease(issueControl!.activeRunLeaseId!);
    assert.ok(runLease);
    assert.equal(runLease.stage, "development");
    assert.equal(runLease.status, "running");
    assert.equal(runLease.threadId, "thread-1");
    assert.equal(runLease.turnId, "turn-1");

    const workspaceOwnership = issueControl?.activeWorkspaceOwnershipId
      ? db.workspaceOwnership.getWorkspaceOwnership(issueControl.activeWorkspaceOwnershipId)
      : undefined;
    assert.ok(workspaceOwnership);
    assert.equal(workspaceOwnership?.status, "active");
    assert.equal(workspaceOwnership?.currentRunLeaseId, runLease?.id);
    assert.match(workspaceOwnership?.worktreePath ?? "", new RegExp(`${config.projects[0]!.worktreeRoot}.+USE-25`));

    assert.deepEqual(linear.stateTransitions, [{ issueId: "issue-1", stateName: "Implementing" }]);
    assert.deepEqual(linear.labelUpdates, [
      {
        issueId: "issue-1",
        addNames: ["llm-working"],
        removeNames: ["llm-awaiting-handoff"],
      },
    ]);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("stage runner persists and delivers pending launch input through the obligation path", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-stage-runner-pending-input-"));
  try {
    const { db, codex, runner } = createHarness(baseDir);
    queueDesiredStage(db, {
      createLegacyMirror: true,
      pendingLaunchInput: "Please start by checking the deployment logs.",
    });

    await runner.run({ projectId: "usertold", issueId: "issue-1" });

    assert.equal(codex.steeredTurns.length, 1);
    assert.match(codex.steeredTurns[0]!.input, /deployment logs/);

    const issueControl = db.issueControl.getIssueControl("usertold", "issue-1");
    assert.ok(issueControl?.activeRunLeaseId);
    const obligation = db.obligations.getObligationByDedupeKey({
      runLeaseId: issueControl.activeRunLeaseId!,
      kind: "deliver_turn_input",
      dedupeKey: `linear-agent-launch:${db.issueWorkflows.getTrackedIssue("usertold", "issue-1")!.activeStageRunId!}`,
    });
    assert.ok(obligation);
    assert.equal(obligation.status, "completed");

    const payload = JSON.parse(obligation.payloadJson) as { queuedInputId?: number; body?: string; stageRunId?: number };
    assert.equal(payload.body, "Please start by checking the deployment logs.");
    assert.equal(typeof payload.queuedInputId, "number");
    assert.equal(typeof payload.stageRunId, "number");

    const pendingMirrorRows = db.stageEvents.listPendingTurnInputs(payload.stageRunId!);
    assert.equal(pendingMirrorRows.length, 0);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("stage runner marks the run failed when turn startup errors after thread creation", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-stage-runner-start-turn-failure-"));
  try {
    const { db, codex, linear, runner } = createHarness(baseDir);
    queueDesiredStage(db, { createLegacyMirror: true });
    codex.startTurnError = new Error("turn start failed");

    await assert.rejects(
      () => runner.run({ projectId: "usertold", issueId: "issue-1" }),
      /turn start failed/,
    );

    const issue = db.issueWorkflows.getTrackedIssue("usertold", "issue-1");
    assert.equal(issue?.lifecycleStatus, "failed");
    assert.equal(issue?.activeStageRunId, undefined);

    const latestStageRun = db.issueWorkflows.getLatestStageRunForIssue("usertold", "issue-1");
    assert.equal(latestStageRun?.status, "failed");
    assert.equal(latestStageRun?.threadId, "thread-1");

    const issueControl = db.issueControl.getIssueControl("usertold", "issue-1");
    assert.equal(issueControl?.activeRunLeaseId, undefined);
    assert.equal(issueControl?.lifecycleStatus, "failed");
    const workspaceOwnership = issueControl?.activeWorkspaceOwnershipId
      ? db.workspaceOwnership.getWorkspaceOwnership(issueControl.activeWorkspaceOwnershipId)
      : undefined;
    assert.equal(workspaceOwnership?.status, "paused");

    const failedLease = [...db.runLeases.listActiveRunLeases(), db.runLeases.getRunLease(1)].find(Boolean);
    assert.equal(failedLease?.status, "failed");
    assert.equal(failedLease?.threadId, "thread-1");
    assert.equal(failedLease?.failureReason, "turn start failed");

    assert.equal(linear.issues.get("issue-1")?.stateName, "Human Needed");
    assert.match([...linear.comments.values()].at(-1)?.body ?? "", /turn start failed/);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("stage runner no-ops when ledger ownership already has an active run lease", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-stage-runner-active-lease-"));
  try {
    const { db, codex, runner } = createHarness(baseDir);
    queueDesiredStage(db, { createLegacyMirror: true });
    const issueControl = db.issueControl.upsertIssueControl({
      projectId: "usertold",
      linearIssueId: "issue-1",
      desiredStage: "development",
      desiredReceiptId: db.eventReceipts.getEventReceiptBySourceExternalId("linear-webhook", "delivery-start")!.id,
      lifecycleStatus: "running",
    });
    const workspace = db.workspaceOwnership.upsertWorkspaceOwnership({
      projectId: "usertold",
      linearIssueId: "issue-1",
      branchName: "use/USE-25-build-app-server-orchestration",
      worktreePath: path.join(baseDir, "worktrees", "USE-25"),
      status: "active",
    });
    const runLease = db.runLeases.createRunLease({
      issueControlId: issueControl.id,
      projectId: "usertold",
      linearIssueId: "issue-1",
      workspaceOwnershipId: workspace.id,
      stage: "development",
      status: "running",
    });
    db.issueControl.upsertIssueControl({
      projectId: "usertold",
      linearIssueId: "issue-1",
      desiredStage: "development",
      desiredReceiptId: db.eventReceipts.getEventReceiptBySourceExternalId("linear-webhook", "delivery-start")!.id,
      activeWorkspaceOwnershipId: workspace.id,
      activeRunLeaseId: runLease.id,
      lifecycleStatus: "running",
    });

    await runner.run({ projectId: "usertold", issueId: "issue-1" });

    assert.equal(codex.startedThreads.length, 0);
    assert.equal(codex.startedTurns.length, 0);
    assert.equal(db.issueWorkflows.listStageRunsForIssue("usertold", "issue-1").length, 0);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});
