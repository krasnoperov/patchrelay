import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import pino from "pino";
import { PatchRelayDatabase } from "../src/db.js";
import { buildLaunchPlan } from "../src/launcher.js";
import { PatchRelayService } from "../src/service.js";
import type { AppConfig, PersistedIssueRecord, ProjectConfig, WorkflowKind } from "../src/types.js";

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
      zmxBin: "zmx",
      gitBin: "git",
      launch: {
        shell: "codex",
        args: ["exec", "{prompt}"],
      },
    },
    projects: [
      {
        id: "patchrelay",
        repoPath: baseDir,
        worktreeRoot: path.join(baseDir, "worktrees"),
        workflowFiles: {
          implementation: path.join(baseDir, "implementation.md"),
          review: path.join(baseDir, "review.md"),
          deploy: path.join(baseDir, "deploy.md"),
        },
        workflowStatuses: {
          implementation: "Start",
          review: "Review",
          deploy: "Deploy",
        },
        linearTeamIds: ["ENG"],
        allowLabels: [],
        triggerEvents: ["statusChanged"],
        branchPrefix: "patchrelay",
      },
    ],
  };
}

function createLogger() {
  return pino({ enabled: false });
}

function issueToMetadata(issue: PersistedIssueRecord) {
  return {
    id: issue.linearIssueId,
    ...(issue.linearIssueKey ? { identifier: issue.linearIssueKey } : {}),
    ...(issue.title ? { title: issue.title } : {}),
    ...(issue.issueUrl ? { url: issue.issueUrl } : {}),
    labelNames: [],
  };
}

async function flushQueues(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

class FakeLaunchRunner {
  private completionHandler?: (params: {
    projectId: string;
    linearIssueId: string;
    runId: number;
    sessionId: number;
    exitCode: number;
  }) => Promise<void> | void;
  readonly launches: Array<{ issueId: string; stage: WorkflowKind; triggerWebhookId: string }> = [];

  constructor(
    private readonly config: AppConfig,
    private readonly db: PatchRelayDatabase,
  ) {}

  setRunCompletionHandler(
    handler: (params: { projectId: string; linearIssueId: string; runId: number; sessionId: number; exitCode: number }) => Promise<void> | void,
  ): void {
    this.completionHandler = handler;
  }

  async launch(params: {
    project: ProjectConfig;
    issue: PersistedIssueRecord;
    workflowKind: WorkflowKind;
    triggerWebhookId: string;
  }) {
    const plan = buildLaunchPlan(this.config, params.project, issueToMetadata(params.issue), params.workflowKind);
    const claim = this.db.claimIssueLaunch({
      projectId: params.project.id,
      linearIssueId: params.issue.linearIssueId,
      stage: params.workflowKind,
      triggerWebhookId: params.triggerWebhookId,
      branchName: plan.branchName,
      worktreePath: plan.worktreePath,
      leaseOwner: "test",
      leaseDurationMs: 60_000,
    });
    if (!claim) {
      return undefined;
    }

    this.launches.push({
      issueId: params.issue.linearIssueId,
      stage: params.workflowKind,
      triggerWebhookId: params.triggerWebhookId,
    });
    return plan;
  }

  async getSessionState() {
    return { kind: "missing" } as const;
  }

  resumeSessionMonitoring(): void {}

  async completeIssue(projectId: string, linearIssueId: string, exitCode = 0): Promise<void> {
    const issue = this.db.getIssue(projectId, linearIssueId);
    assert.ok(issue?.activeRunId, "issue should have an active run before completion");
    this.db.clearActiveRun({
      projectId,
      linearIssueId,
      runId: issue.activeRunId,
      nextState: exitCode === 0 ? "completed" : "failed",
    });
    await this.completionHandler?.({
      projectId,
      linearIssueId,
      runId: issue.activeRunId,
      sessionId: 0,
      exitCode,
    });
  }
}

test("service defers newer stage webhooks until the active run completes", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-service-"));
  try {
    const config = createConfig(baseDir);
    const db = new PatchRelayDatabase(config.database.path, true);
    db.runMigrations();
    const launcher = new FakeLaunchRunner(config, db);
    const service = new PatchRelayService(config, db, launcher as never, createLogger());

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
          identifier: "ENG-1",
          title: "Fix stage handoff",
          url: "https://linear.app/example/issue/ENG-1",
          team: { key: "ENG" },
          state: { name: "Start" },
        },
      }),
      signatureValid: true,
      dedupeStatus: "accepted",
    });

    await service.processWebhookEvent(startEvent.id);
    await flushQueues();

    const reviewEvent = db.insertWebhookEvent({
      webhookId: "delivery-review",
      receivedAt: new Date().toISOString(),
      eventType: "Issue.update",
      issueId: "issue_1",
      headersJson: "{}",
      payloadJson: JSON.stringify({
        action: "update",
        type: "Issue",
        createdAt: "2026-03-08T12:01:00.000Z",
        webhookTimestamp: 2000,
        updatedFrom: { stateId: "implementing" },
        data: {
          id: "issue_1",
          identifier: "ENG-1",
          title: "Fix stage handoff",
          url: "https://linear.app/example/issue/ENG-1",
          team: { key: "ENG" },
          state: { name: "Review" },
        },
      }),
      signatureValid: true,
      dedupeStatus: "accepted",
    });

    await service.processWebhookEvent(reviewEvent.id);
    await flushQueues();

    let issue = db.getIssue("patchrelay", "issue_1");
    assert.equal(launcher.launches.map((entry) => entry.stage).join(","), "implementation");
    assert.equal(issue?.desiredStage, "review");

    await launcher.completeIssue("patchrelay", "issue_1");
    await flushQueues();

    issue = db.getIssue("patchrelay", "issue_1");
    assert.equal(launcher.launches.map((entry) => entry.stage).join(","), "implementation,review");
    assert.equal(issue?.desiredStage, undefined);
    service.stop();
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("service startup reconciles stale active runs and launches pending desired work", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-reconcile-"));
  try {
    const config = createConfig(baseDir);
    const db = new PatchRelayDatabase(config.database.path, true);
    db.runMigrations();

    db.upsertIssue({
      projectId: "patchrelay",
      linearIssueId: "issue_2",
      linearIssueKey: "ENG-2",
      title: "Recover stale run",
      issueUrl: "https://linear.app/example/issue/ENG-2",
      currentState: "received",
      lastWebhookAt: new Date().toISOString(),
    });

    const issue = db.recordDesiredStage({
      projectId: "patchrelay",
      linearIssueId: "issue_2",
      currentState: "received",
      linearIssueKey: "ENG-2",
      title: "Recover stale run",
      issueUrl: "https://linear.app/example/issue/ENG-2",
      desiredStage: "implementation",
      desiredStateName: "Start",
      desiredWebhookId: "delivery-start",
      desiredWebhookTimestamp: 1000,
      lastWebhookAt: new Date().toISOString(),
    });

    const project = config.projects[0];
    const plan = buildLaunchPlan(config, project, issueToMetadata(issue), "implementation");
    const claim = db.claimIssueLaunch({
      projectId: "patchrelay",
      linearIssueId: "issue_2",
      stage: "implementation",
      triggerWebhookId: "delivery-start",
      branchName: plan.branchName,
      worktreePath: plan.worktreePath,
      leaseOwner: "old-worker",
      leaseDurationMs: 60_000,
    });
    assert.ok(claim);
    const sessionId = db.createSession({
      projectId: "patchrelay",
      linearIssueId: "issue_2",
      runId: claim.runId,
      stage: "implementation",
      zmxSessionName: plan.sessionName,
      branchName: plan.branchName,
      worktreePath: plan.worktreePath,
    });
    db.updateRunSessionId(claim.runId, sessionId);
    db.recordDesiredStage({
      projectId: "patchrelay",
      linearIssueId: "issue_2",
      currentState: "running",
      linearIssueKey: "ENG-2",
      title: "Recover stale run",
      issueUrl: "https://linear.app/example/issue/ENG-2",
      desiredStage: "review",
      desiredStateName: "Review",
      desiredWebhookId: "delivery-review",
      desiredWebhookTimestamp: 2000,
      lastWebhookAt: new Date().toISOString(),
    });

    const launcher = new FakeLaunchRunner(config, db);
    const service = new PatchRelayService(config, db, launcher as never, createLogger());
    await service.start();
    await flushQueues();

    const reconciled = db.getIssue("patchrelay", "issue_2");
    assert.equal(launcher.launches.map((entry) => entry.stage).join(","), "review");
    assert.equal(reconciled?.activeStage, "review");
    service.stop();
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("buildLaunchPlan uses distinct session names for different runs of the same issue and stage", () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-session-name-"));
  try {
    const config = createConfig(baseDir);
    const project = config.projects[0];
    const issue = {
      id: "issue_3",
      identifier: "ENG-3",
      title: "Unique session names",
      url: "https://linear.app/example/issue/ENG-3",
      labelNames: [],
    };

    const first = buildLaunchPlan(config, project, issue, "review", "101");
    const second = buildLaunchPlan(config, project, issue, "review", "102");

    assert.notEqual(first.sessionName, second.sessionName);
    assert.match(first.sessionName, /-101$/);
    assert.match(second.sessionName, /-102$/);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});
