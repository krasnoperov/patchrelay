import assert from "node:assert/strict";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import pino from "pino";
import { PatchRelayDatabase } from "../src/db.js";
import { PatchRelayService } from "../src/service.js";
import type { AppConfig, CodexThreadSummary, LinearWebhookPayload, ProjectConfig } from "../src/types.js";

class FakeCodexClient extends EventEmitter {
  readonly startedThreads: string[] = [];
  readonly forkedFrom: string[] = [];
  readonly turns: Array<{ threadId: string; input: string }> = [];
  readonly threads = new Map<string, CodexThreadSummary>();
  private nextThreadNumber = 1;
  private nextTurnNumber = 1;

  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  async startThread(params: { cwd: string }): Promise<CodexThreadSummary> {
    const thread = this.makeThread(`thread-${this.nextThreadNumber++}`, params.cwd);
    this.startedThreads.push(thread.id);
    this.threads.set(thread.id, thread);
    return thread;
  }

  async forkThread(threadId: string, cwd?: string): Promise<CodexThreadSummary> {
    const thread = this.makeThread(`thread-${this.nextThreadNumber++}`, cwd ?? `/tmp/${threadId}`);
    this.forkedFrom.push(threadId);
    this.threads.set(thread.id, thread);
    return thread;
  }

  async startTurn(params: { threadId: string; input: string }): Promise<{ threadId: string; turnId: string; status: string }> {
    this.turns.push({ threadId: params.threadId, input: params.input });
    return {
      threadId: params.threadId,
      turnId: `turn-${this.nextTurnNumber++}`,
      status: "inProgress",
    };
  }

  async readThread(threadId: string): Promise<CodexThreadSummary> {
    return this.threads.get(threadId)!;
  }

  async listThreads(): Promise<CodexThreadSummary[]> {
    return [...this.threads.values()];
  }

  removeThread(threadId: string): void {
    this.threads.delete(threadId);
  }

  completeThread(threadId: string, items: CodexThreadSummary["turns"][number]["items"]): void {
    const thread = this.threads.get(threadId);
    assert.ok(thread);
    thread.turns = [
      {
        id: "turn-final",
        status: "completed",
        items,
      },
    ];
    this.emit("notification", {
      method: "turn/completed",
      params: {
        threadId,
        turn: {
          id: "turn-final",
          status: "completed",
        },
      },
    });
  }

  private makeThread(id: string, cwd: string): CodexThreadSummary {
    return {
      id,
      preview: "PatchRelay stage",
      cwd,
      status: "idle",
      turns: [],
    };
  }
}

function createConfig(baseDir: string): AppConfig {
  return {
    server: {
      bind: "127.0.0.1",
      port: 8787,
      healthPath: "/health",
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
    },
    runner: {
      gitBin: "git",
      codex: {
        bin: "codex",
        args: ["app-server"],
        approvalPolicy: "never",
        sandboxMode: "danger-full-access",
        persistExtendedHistory: true,
        serviceName: "patchrelay-test",
      },
    },
    projects: [
      {
        id: "usertold",
        repoPath: path.join(baseDir, "repo"),
        worktreeRoot: path.join(baseDir, "worktrees"),
        workflowFiles: {
          development: path.join(baseDir, "DEVELOPMENT_WORKFLOW.md"),
          review: path.join(baseDir, "REVIEW_WORKFLOW.md"),
          deploy: path.join(baseDir, "DEPLOY_WORKFLOW.md"),
          cleanup: path.join(baseDir, "CLEANUP_WORKFLOW.md"),
        },
        workflowStatuses: {
          development: "Start",
          review: "Review",
          deploy: "Deploy",
          cleanup: "Cleanup",
          humanNeeded: "Human Needed",
          done: "Done",
        },
        issueKeyPrefixes: ["USE"],
        linearTeamIds: ["USE"],
        allowLabels: [],
        triggerEvents: ["statusChanged"],
        branchPrefix: "use",
      },
    ],
  };
}

function setupRepo(baseDir: string, config: AppConfig): void {
  const repoPath = config.projects[0].repoPath;
  execFileSync("git", ["init", repoPath], { stdio: "ignore" });
  execFileSync("git", ["-C", repoPath, "config", "user.email", "patchrelay@example.com"], { stdio: "ignore" });
  execFileSync("git", ["-C", repoPath, "config", "user.name", "PatchRelay"], { stdio: "ignore" });
  writeFileSync(path.join(repoPath, "README.md"), "# test\n", "utf8");
  execFileSync("git", ["-C", repoPath, "add", "."], { stdio: "ignore" });
  execFileSync("git", ["-C", repoPath, "commit", "-m", "initial"], { stdio: "ignore" });

  writeFileSync(config.projects[0].workflowFiles.development, "Implement carefully.\n", "utf8");
  writeFileSync(config.projects[0].workflowFiles.review, "Review carefully.\n", "utf8");
  writeFileSync(config.projects[0].workflowFiles.deploy, "Deploy carefully.\n", "utf8");
  writeFileSync(config.projects[0].workflowFiles.cleanup, "Clean up carefully.\n", "utf8");
}

function createService(baseDir: string) {
  const config = createConfig(baseDir);
  setupRepo(baseDir, config);
  const db = new PatchRelayDatabase(config.database.path, true);
  db.runMigrations();
  const codex = new FakeCodexClient();
  const service = new PatchRelayService(config, db, codex as never, pino({ enabled: false }));
  return { config, db, codex, service, project: config.projects[0] as ProjectConfig };
}

async function flushQueues(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitFor(assertion: () => void, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

test("service keeps one workspace and forks later stages from the prior thread", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-service-"));
  try {
    const { db, codex, service } = createService(baseDir);
    await service.start();

    const startEvent = db.insertWebhookEvent({
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

    await service.processWebhookEvent(startEvent.id);
    await waitFor(() => {
      assert.equal(codex.startedThreads.length, 1);
      assert.equal(codex.turns.length, 1);
    });

    const issueAfterStart = db.getTrackedIssue("usertold", "issue_1");
    assert.ok(issueAfterStart?.activeStageRunId);
    const startStageRun = db.getStageRun(issueAfterStart.activeStageRunId);
    assert.equal(startStageRun?.stage, "development");
    assert.ok(startStageRun?.threadId);

    db.recordDesiredStage({
      projectId: "usertold",
      linearIssueId: "issue_1",
      issueKey: "USE-25",
      title: "Build app server orchestration",
      issueUrl: "https://linear.app/example/issue/USE-25",
      currentLinearState: "Review",
      desiredStage: "review",
      desiredWebhookId: "delivery-review",
      lastWebhookAt: new Date().toISOString(),
    });

    codex.completeThread(startStageRun!.threadId!, [
      {
        type: "agentMessage",
        id: "assistant-1",
        text: "Implemented the feature and left the tree ready for review.",
      },
      {
        type: "commandExecution",
        id: "cmd-1",
        command: "npm test",
        cwd: "/tmp/worktree",
        status: "completed",
        exitCode: 0,
        durationMs: 1234,
      },
      {
        type: "fileChange",
        id: "file-1",
        status: "completed",
        changes: [{ path: "src/service.ts", kind: "update" }],
      },
    ]);
    await waitFor(() => {
      assert.deepEqual(codex.forkedFrom, [startStageRun!.threadId!]);
      assert.equal(codex.turns.length, 2);
    });

    const latestIssue = db.getTrackedIssue("usertold", "issue_1");
    const workspace = db.getActiveWorkspaceForIssue("usertold", "issue_1");
    assert.ok(workspace);
    assert.equal(workspace?.lastThreadId, startStageRun?.threadId);
    assert.ok(latestIssue?.activeStageRunId);

    const reviewStageRun = db.getStageRun(latestIssue.activeStageRunId!);
    assert.equal(reviewStageRun?.stage, "review");
    assert.equal(reviewStageRun?.parentThreadId, startStageRun?.threadId);

    service.stop();
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("service builds a read-only report from completed thread history", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-report-"));
  try {
    const { db, codex, service } = createService(baseDir);
    await service.start();

    db.recordDesiredStage({
      projectId: "usertold",
      linearIssueId: "issue_2",
      issueKey: "USE-26",
      title: "Observe agent work",
      issueUrl: "https://linear.app/example/issue/USE-26",
      currentLinearState: "Start",
      desiredStage: "development",
      desiredWebhookId: "delivery-start",
      lastWebhookAt: new Date().toISOString(),
    });

    await service.processIssue({ projectId: "usertold", issueId: "issue_2" });
    await flushQueues();

    const issue = db.getTrackedIssue("usertold", "issue_2");
    const stageRun = db.getStageRun(issue!.activeStageRunId!);
    codex.completeThread(stageRun!.threadId!, [
      {
        type: "agentMessage",
        id: "assistant-1",
        text: "I updated the service and verified the changes.",
      },
      {
        type: "plan",
        id: "plan-1",
        text: "1. Update service. 2. Add tests.",
      },
      {
        type: "commandExecution",
        id: "cmd-1",
        command: "npm test",
        cwd: "/tmp/worktree",
        status: "completed",
        exitCode: 0,
        durationMs: 2345,
      },
      {
        type: "fileChange",
        id: "file-1",
        status: "completed",
        changes: [{ path: "src/http.ts", kind: "update" }],
      },
      {
        type: "dynamicToolCall",
        id: "tool-1",
        tool: "apply_patch",
        status: "completed",
        durationMs: 345,
      },
    ]);
    await flushQueues();

    const report = await service.getIssueReport("USE-26");
    assert.ok(report);
    assert.equal(report?.stages.length, 1);
    assert.equal(report?.stages[0].report?.assistantMessages[0], "I updated the service and verified the changes.");
    assert.equal(report?.stages[0].report?.commands[0].command, "npm test");
    assert.equal(report?.stages[0].report?.toolCalls[0].name, "apply_patch");
    const overview = await service.getIssueOverview("USE-26");
    assert.equal(overview?.latestStageRun?.status, "completed");

    service.stop();
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("service exposes raw stored events and live active status", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-live-"));
  try {
    const { db, codex, service } = createService(baseDir);
    await service.start();

    db.recordDesiredStage({
      projectId: "usertold",
      linearIssueId: "issue_3",
      issueKey: "USE-27",
      title: "Inspect live status",
      issueUrl: "https://linear.app/example/issue/USE-27",
      currentLinearState: "Start",
      desiredStage: "development",
      desiredWebhookId: "delivery-start",
      lastWebhookAt: new Date().toISOString(),
    });

    await service.processIssue({ projectId: "usertold", issueId: "issue_3" });
    await flushQueues();

    const issue = db.getTrackedIssue("usertold", "issue_3");
    const stageRun = db.getStageRun(issue!.activeStageRunId!);
    db.saveThreadEvent({
      stageRunId: stageRun!.id,
      threadId: stageRun!.threadId!,
      turnId: stageRun!.turnId,
      method: "turn/started",
      eventJson: JSON.stringify({ threadId: stageRun!.threadId, turnId: stageRun!.turnId }),
    });

    codex.threads.set(stageRun!.threadId!, {
      ...codex.threads.get(stageRun!.threadId!)!,
      status: "running",
      turns: [
        {
          id: stageRun!.turnId!,
          status: "inProgress",
          items: [{ type: "agentMessage", id: "assistant-1", text: "Working through the task." }],
        },
      ],
    });

    const live = await service.getActiveStageStatus("USE-27");
    assert.equal(live?.liveThread.latestTurnStatus, "inProgress");
    assert.equal(live?.liveThread.latestAgentMessage, "Working through the task.");

    const events = await service.getStageEvents("USE-27", stageRun!.id);
    assert.equal(events?.events[0].method, "turn/started");
    assert.equal(events?.events[0].parsedEvent?.threadId, stageRun!.threadId);

    service.stop();
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("service startup reconciles finished and missing active threads", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-reconcile-"));
  try {
    const config = createConfig(baseDir);
    setupRepo(baseDir, config);
    const db = new PatchRelayDatabase(config.database.path, true);
    db.runMigrations();
    const codex = new FakeCodexClient();

    db.upsertTrackedIssue({
      projectId: "usertold",
      linearIssueId: "issue_4",
      issueKey: "USE-28",
      title: "Recover finished stage",
      currentLinearState: "Start",
      desiredStage: "development",
      desiredWebhookId: "delivery-start",
      lifecycleStatus: "running",
      lastWebhookAt: new Date().toISOString(),
    });
    const claim = db.claimStageRun({
      projectId: "usertold",
      linearIssueId: "issue_4",
      stage: "development",
      triggerWebhookId: "delivery-start",
      branchName: "use/USE-28-recover-finished-stage",
      worktreePath: path.join(baseDir, "worktrees", "USE-28"),
      workflowFile: config.projects[0].workflowFiles.development,
      promptText: "Recover this stage",
    });
    assert.ok(claim);
    db.updateStageRunThread({ stageRunId: claim!.stageRun.id, threadId: "thread-finished", turnId: "turn-1" });
    codex.threads.set("thread-finished", {
      id: "thread-finished",
      preview: "Recovered",
      cwd: claim!.workspace.worktreePath,
      status: "idle",
      turns: [{ id: "turn-1", status: "completed", items: [{ type: "agentMessage", id: "a1", text: "Recovered." }] }],
    });

    db.upsertTrackedIssue({
      projectId: "usertold",
      linearIssueId: "issue_5",
      issueKey: "USE-29",
      title: "Recover missing stage",
      currentLinearState: "Start",
      desiredStage: "development",
      desiredWebhookId: "delivery-start-missing",
      lifecycleStatus: "running",
      lastWebhookAt: new Date().toISOString(),
    });
    const missingClaim = db.claimStageRun({
      projectId: "usertold",
      linearIssueId: "issue_5",
      stage: "development",
      triggerWebhookId: "delivery-start-missing",
      branchName: "use/USE-29-recover-missing-stage",
      worktreePath: path.join(baseDir, "worktrees", "USE-29"),
      workflowFile: config.projects[0].workflowFiles.development,
      promptText: "Recover missing stage",
    });
    assert.ok(missingClaim);
    db.updateStageRunThread({ stageRunId: missingClaim!.stageRun.id, threadId: "thread-missing", turnId: "turn-2" });
    codex.removeThread("thread-missing");

    const service = new PatchRelayService(config, db, codex as never, pino({ enabled: false }));
    await service.start();
    await flushQueues();

    const finishedStage = db.getStageRun(claim!.stageRun.id);
    const missingStage = db.getStageRun(missingClaim!.stageRun.id);
    assert.equal(finishedStage?.status, "completed");
    assert.equal(missingStage?.status, "failed");

    service.stop();
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("service ignores webhook events when project routing is ambiguous", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-ambiguous-"));
  try {
    const config = createConfig(baseDir);
    setupRepo(baseDir, config);
    config.projects.push({
      ...config.projects[0]!,
      id: "usertold-copy",
      repoPath: path.join(baseDir, "repo-copy"),
      worktreeRoot: path.join(baseDir, "worktrees-copy"),
      workflowFiles: {
        development: path.join(baseDir, "COPY_DEVELOPMENT_WORKFLOW.md"),
        review: path.join(baseDir, "COPY_REVIEW_WORKFLOW.md"),
        deploy: path.join(baseDir, "COPY_DEPLOY_WORKFLOW.md"),
        cleanup: path.join(baseDir, "COPY_CLEANUP_WORKFLOW.md"),
      },
    });
    setupRepo(baseDir, { ...config, projects: [config.projects[1]!] });

    writeFileSync(config.projects[1]!.workflowFiles.development, "Implement carefully.\n", "utf8");
    writeFileSync(config.projects[1]!.workflowFiles.review, "Review carefully.\n", "utf8");
    writeFileSync(config.projects[1]!.workflowFiles.deploy, "Deploy carefully.\n", "utf8");
    writeFileSync(config.projects[1]!.workflowFiles.cleanup, "Clean up carefully.\n", "utf8");

    const db = new PatchRelayDatabase(config.database.path, true);
    db.runMigrations();
    const codex = new FakeCodexClient();
    const service = new PatchRelayService(config, db, codex as never, pino({ enabled: false }));
    await service.start();

    const event = db.insertWebhookEvent({
      webhookId: "delivery-ambiguous",
      receivedAt: new Date().toISOString(),
      eventType: "Issue.update",
      issueId: "issue_ambiguous",
      headersJson: "{}",
      payloadJson: JSON.stringify({
        action: "update",
        type: "Issue",
        createdAt: "2026-03-08T12:00:00.000Z",
        webhookTimestamp: 1000,
        updatedFrom: { stateId: "todo" },
        data: {
          id: "issue_ambiguous",
          identifier: "USE-30",
          title: "Ambiguous routing",
          team: { key: "USE" },
          state: { name: "Start" },
        },
      }),
      signatureValid: true,
      dedupeStatus: "accepted",
    });

    await service.processWebhookEvent(event.id);
    await flushQueues();

    assert.equal(db.getTrackedIssueByKey("USE-30"), undefined);
    assert.equal(codex.startedThreads.length, 0);
    assert.equal(db.getWebhookEvent(event.id)?.processingStatus, "processed");

    service.stop();
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("service acceptWebhook rejects invalid signatures, dedupes deliveries, and archives accepted payloads", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-accept-webhook-"));
  try {
    const { config, db, codex, service } = createService(baseDir);
    config.logging.webhookArchiveDir = path.join(baseDir, "webhook-archive");

    const payload: LinearWebhookPayload = {
      action: "update",
      type: "Issue",
      createdAt: "2026-03-08T12:00:00.000Z",
      webhookTimestamp: Date.now(),
      updatedFrom: {
        stateId: "state_start",
      },
      data: {
        id: "issue_sig",
        identifier: "USE-55",
        title: "Deploy with wrangler",
        team: {
          key: "USE",
        },
        state: {
          name: "Start",
        },
      },
    };

    const rawBody = Buffer.from(JSON.stringify(payload), "utf8");
    const validSignature = crypto.createHmac("sha256", config.linear.webhookSecret).update(rawBody).digest("hex");

    const invalid = await service.acceptWebhook({
      webhookId: "delivery-invalid",
      headers: {
        "linear-signature": "deadbeef",
      },
      rawBody,
    });
    assert.equal(invalid.status, 401);
    assert.equal(invalid.body.reason, "invalid_signature");

    const accepted = await service.acceptWebhook({
      webhookId: "delivery-valid",
      headers: {
        "linear-signature": validSignature,
      },
      rawBody,
    });
    assert.equal(accepted.status, 200);
    assert.equal(accepted.body.accepted, true);

    const duplicate = await service.acceptWebhook({
      webhookId: "delivery-valid",
      headers: {
        "linear-signature": validSignature,
      },
      rawBody,
    });
    assert.equal(duplicate.status, 200);
    assert.equal(duplicate.body.duplicate, true);

    await waitFor(() => {
      const stored = db.getTrackedIssueByKey("USE-55");
      assert.ok(stored);
      assert.equal(codex.startedThreads.length, 1);
      assert.ok(stored.activeStageRunId);
    });

    const archiveDir = config.logging.webhookArchiveDir!;
    const expectedArchive = path.join(archiveDir, new Date().toISOString().slice(0, 10));
    assert.equal(existsSync(archiveDir), true);
    assert.equal(existsSync(expectedArchive), true);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});
