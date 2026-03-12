import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import pino from "pino";
import { PatchRelayDatabase } from "../src/db.ts";
import { PatchRelayService } from "../src/service.ts";
import type { AppConfig, CodexThreadSummary, LinearClient, LinearIssueSnapshot } from "../src/types.ts";

const WORKFLOW_STATES = [
  { id: "start", name: "Start" },
  { id: "implementing", name: "Implementing" },
  { id: "human-needed", name: "Human Needed" },
];

function createWorkflows(baseDir: string) {
  return [
    {
      id: "development",
      whenState: "Start",
      activeState: "Implementing",
      workflowFile: path.join(baseDir, "DEVELOPMENT_WORKFLOW.md"),
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

function getWorkflowFile(config: AppConfig, workflowId: string): string {
  const workflow = config.projects[0]?.workflows.find((entry) => entry.id === workflowId);
  assert.ok(workflow);
  return workflow.workflowFile;
}

class FakeCodexClient extends EventEmitter {
  readonly startedThreads: string[] = [];

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async readThread(_threadId: string): Promise<CodexThreadSummary> {
    throw new Error("readThread should not be called in this test");
  }
  async startThread(params: { cwd: string }): Promise<CodexThreadSummary> {
    this.startedThreads.push(params.cwd);
    return {
      id: "thread-1",
      preview: "PatchRelay stage",
      cwd: params.cwd,
      status: "idle",
      turns: [],
    };
  }
  async forkThread(_threadId: string, cwd?: string): Promise<CodexThreadSummary> {
    return await this.startThread({ cwd: cwd ?? process.cwd() });
  }
  async startTurn(params: { threadId: string }): Promise<{ threadId: string; turnId: string; status: string }> {
    return {
      threadId: params.threadId,
      turnId: "turn-1",
      status: "inProgress",
    };
  }
  async steerTurn(): Promise<void> {}
}

class FakeLinearClient implements LinearClient {
  readonly issues = new Map<string, LinearIssueSnapshot>();
  readonly comments = new Map<string, { id: string; body: string }>();
  private nextCommentNumber = 1;

  async getIssue(issueId: string): Promise<LinearIssueSnapshot> {
    const existing = this.issues.get(issueId);
    if (existing) {
      return existing;
    }

    const issue: LinearIssueSnapshot = {
      id: issueId,
      stateId: "start",
      stateName: "Start",
      workflowStates: WORKFLOW_STATES,
      labelIds: [],
      labels: [],
      teamLabels: [],
    };
    this.issues.set(issueId, issue);
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
    return nextIssue;
  }

  async upsertIssueComment(params: { issueId: string; commentId?: string; body: string }): Promise<{ id: string; body: string }> {
    const id = params.commentId ?? `comment-${this.nextCommentNumber++}`;
    this.comments.set(id, { id, body: params.body });
    return { id, body: params.body };
  }

  async createAgentActivity(): Promise<{ id: string }> {
    return { id: "agent-activity-1" };
  }

  async updateIssueLabels(params: { issueId: string }): Promise<LinearIssueSnapshot> {
    return await this.getIssue(params.issueId);
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
        issueKeyPrefixes: ["USE"],
        linearTeamIds: ["USE"],
        allowLabels: [],
        triggerEvents: ["statusChanged"],
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

  writeFileSync(getWorkflowFile(config, "development"), "Implement carefully.\n", "utf8");
  writeFileSync(getWorkflowFile(config, "review"), "Review carefully.\n", "utf8");
  writeFileSync(getWorkflowFile(config, "deploy"), "Deploy carefully.\n", "utf8");
  writeFileSync(getWorkflowFile(config, "cleanup"), "Clean up carefully.\n", "utf8");
}

function createService(baseDir: string) {
  const config = createConfig(baseDir);
  setupRepo(config);
  const db = new PatchRelayDatabase(config.database.path, true);
  db.runMigrations();
  const codex = new FakeCodexClient();
  const linear = new FakeLinearClient();
  linear.issues.set("issue_1", {
    id: "issue_1",
    identifier: "USE-90",
    stateId: "start",
    stateName: "Start",
    workflowStates: WORKFLOW_STATES,
    labelIds: [],
    labels: [],
    teamLabels: [],
  });
  const service = new PatchRelayService(config, db, codex as never, linear, pino({ enabled: false }));
  return { config, db, codex, linear, service };
}

function queueIssue(db: PatchRelayDatabase): void {
  const issue = db.issueWorkflows.recordDesiredStage({
    projectId: "usertold",
    linearIssueId: "issue_1",
    issueKey: "USE-90",
    title: "Validate worktree reuse",
    issueUrl: "https://linear.app/example/issue/USE-90",
    currentLinearState: "Start",
    desiredStage: "development",
    desiredWebhookId: "delivery-start",
    lastWebhookAt: new Date().toISOString(),
  });
  const receipt = db.eventReceipts.insertEventReceipt({
    source: "linear-webhook",
    externalId: "delivery-start",
    eventType: "legacy-test-event",
    receivedAt: new Date().toISOString(),
    acceptanceStatus: "accepted",
    projectId: "usertold",
    linearIssueId: "issue_1",
  });
  db.issueControl.upsertIssueControl({
    projectId: "usertold",
    linearIssueId: "issue_1",
    desiredStage: "development",
    desiredReceiptId: receipt.id,
    lifecycleStatus: issue.lifecycleStatus,
  });
}

test("service rejects symlinked preexisting worktree paths", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-worktree-symlink-"));
  try {
    const { config, db, codex, linear, service } = createService(baseDir);
    await service.start();
    queueIssue(db);

    mkdirSync(config.projects[0]!.worktreeRoot, { recursive: true });
    const symlinkTarget = path.join(baseDir, "escape");
    mkdirSync(symlinkTarget, { recursive: true });
    symlinkSync(symlinkTarget, path.join(config.projects[0]!.worktreeRoot, "USE-90"));

    await assert.rejects(
      () => service.processIssue({ projectId: "usertold", issueId: "issue_1" }),
      /Refusing to reuse symlinked worktree path/,
    );

    assert.equal(codex.startedThreads.length, 0);
    assert.equal(db.issueWorkflows.getTrackedIssue("usertold", "issue_1")?.lifecycleStatus, "failed");
    assert.equal(linear.issues.get("issue_1")?.stateName, "Human Needed");
    assert.match(
      [...linear.comments.values()].at(-1)?.body ?? "",
      /Refusing to reuse symlinked worktree path/,
    );

    service.stop();
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("service rejects preexisting directories that are not registered git worktrees", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-worktree-dir-"));
  try {
    const { config, db, codex, linear, service } = createService(baseDir);
    await service.start();
    queueIssue(db);

    const existingPath = path.join(config.projects[0]!.worktreeRoot, "USE-90");
    mkdirSync(existingPath, { recursive: true });

    await assert.rejects(
      () => service.processIssue({ projectId: "usertold", issueId: "issue_1" }),
      /Refusing to reuse unregistered worktree path/,
    );

    assert.equal(codex.startedThreads.length, 0);
    assert.equal(db.issueWorkflows.getTrackedIssue("usertold", "issue_1")?.lifecycleStatus, "failed");
    assert.equal(linear.issues.get("issue_1")?.stateName, "Human Needed");
    assert.match(
      [...linear.comments.values()].at(-1)?.body ?? "",
      /Refusing to reuse unregistered worktree path/,
    );

    service.stop();
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});
