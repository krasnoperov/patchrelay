import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import test from "node:test";
import { assertIssuePhase } from "./assert-issue-phase.ts";
import { PatchRelayDatabase } from "../src/db.ts";
import { RunOrchestrator } from "../src/run-orchestrator.ts";
import type { CodexTurnSummary } from "../src/codex-types.ts";
import type { RunRecord } from "../src/db-types.ts";
import type { AppConfig } from "../src/types.ts";
import { peekRunnableWorkflowTaskRunType } from "../src/pending-workflow-task.ts";

// The real production string from the LSR-837 incident.
const USAGE_LIMIT_MESSAGE =
  "You've hit your usage limit. Upgrade to Pro (https://openai.com/chatgpt/pricing) or try again at 3:23 AM.";

const FAILED_TURN_PREFIX = "Codex reported the turn completed in a failed state";

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
        id: "usertold",
        repoPath: path.join(baseDir, "repo"),
        worktreeRoot: path.join(baseDir, "worktrees"),
        issueKeyPrefixes: ["USE"],
        linearTeamIds: ["USE"],
        allowLabels: [],
        triggerEvents: ["statusChanged"],
        branchPrefix: "use",
        github: {
          repoFullName: "owner/repo",
        },
      },
    ],
    secretSources: {},
  };
}

function createHarness(baseDir: string, latestTurn: CodexTurnSummary, threadId: string) {
  const config = createConfig(baseDir);
  const db = new PatchRelayDatabase(config.database.path, config.database.wal);
  db.runMigrations();
  const enqueueCalls: Array<{ projectId: string; issueId: string }> = [];
  const orchestrator = new RunOrchestrator(
    config,
    db,
    {
      startThread: async () => ({ threadId }),
      steerTurn: async () => undefined,
      readThread: async () => ({
        id: threadId,
        preview: "",
        cwd: "/tmp/work",
        status: "idle",
        turns: [latestTurn],
      }),
    } as never,
    { forProject: async () => undefined } as never,
    (projectId, issueId) => {
      enqueueCalls.push({ projectId, issueId });
    },
    pino({ enabled: false }),
  );
  return { db, orchestrator, enqueueCalls };
}

function createActiveRun(
  db: PatchRelayDatabase,
  params: {
    linearIssueId: string;
    runType: RunRecord["runType"];
    threadId: string;
    turnId: string;
  },
): RunRecord {
  const issue = db.getIssue("usertold", params.linearIssueId)!;
  const run = db.runs.createRun({
    issueId: issue.id,
    projectId: issue.projectId,
    linearIssueId: issue.linearIssueId,
    runType: params.runType,
    promptText: `Repair ${issue.issueKey}`,
  });
  db.runs.updateRunThread(run.id, { threadId: params.threadId, turnId: params.turnId });
  db.upsertIssue({
    projectId: issue.projectId,
    linearIssueId: issue.linearIssueId,
    activeRunId: run.id,
  });
  return db.runs.getRunById(run.id)!;
}

async function reconcileRun(orchestrator: RunOrchestrator, run: RunRecord): Promise<void> {
  await (orchestrator as unknown as { reconcileRun: (target: RunRecord) => Promise<void> }).reconcileRun(run);
}

test("capacity-failed ci_repair refunds the attempt, holds the repair state, and re-enqueues the workflowTask", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-capacity-ci-"));
  try {
    const failedTurn: CodexTurnSummary = {
      id: "turn-cap-1",
      status: "failed",
      error: { message: USAGE_LIMIT_MESSAGE },
      items: [],
    };
    const { db, orchestrator } = createHarness(baseDir, failedTurn, "thread-cap-1");
    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-cap-1",
      issueKey: "USE-201",
      branchName: "feat-cap-1",
      prNumber: 201,
      prState: "open",
      prCheckStatus: "failed",
      lastGitHubFailureSource: "branch_ci",
      lastGitHubFailureHeadSha: "sha-201",
      lastGitHubFailureSignature: "branch_ci::sha-201::ci",
      lastAttemptedFailureHeadSha: "sha-201",
      lastAttemptedFailureSignature: "branch_ci::sha-201::ci",
      lastAttemptedFailureAt: "2026-06-10T00:00:00.000Z",
      workflowOutcome: undefined,
      // The launch already incremented this from 1 to 2; the capacity
      // deferral must refund it so the outage consumes no budget.
      ciRepairAttempts: 2,
      delegatedToPatchRelay: true,
    });
    const run = createActiveRun(db, {
      linearIssueId: "issue-cap-1",
      runType: "ci_repair",
      threadId: "thread-cap-1",
      turnId: "turn-cap-1",
    });

    await reconcileRun(orchestrator, run);

    const updatedIssue = db.getIssue("usertold", "issue-cap-1")!;
    const updatedRun = db.runs.getRunById(run.id)!;
    assert.equal(updatedRun.status, "failed");
    assert.equal(updatedRun.failureReason, `${FAILED_TURN_PREFIX}: ${USAGE_LIMIT_MESSAGE}`);
    assert.equal(updatedIssue.ciRepairAttempts, 1);
    assertIssuePhase(updatedIssue, "repairing_ci");
    assert.notEqual(updatedIssue.workflowOutcome, "failed");
    assert.notEqual(updatedIssue.workflowOutcome, "escalated");
    assert.equal(updatedIssue.activeRunId, undefined);
    assert.equal(updatedIssue.zombieRecoveryAttempts, 0);
    assert.equal(updatedIssue.lastAttemptedFailureSignature, undefined);
    assert.ok(updatedIssue.capacityBackoffUntil);
    assert.ok(Date.parse(updatedIssue.capacityBackoffUntil!) > Date.now());
    assert.equal(db.issueSessions.peekPendingSessionInputPlanForDiagnostics("usertold", "issue-cap-1")?.runType, "ci_repair");
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("capacity-failed implementation materializes and dispatches a runnable workflow task", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-capacity-implementation-"));
  try {
    const failedTurn: CodexTurnSummary = {
      id: "turn-cap-impl",
      status: "failed",
      error: { message: USAGE_LIMIT_MESSAGE },
      items: [],
    };
    const { db, orchestrator, enqueueCalls } = createHarness(baseDir, failedTurn, "thread-cap-impl");
    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-cap-impl",
      issueKey: "USE-205",
      branchName: "feat-cap-impl",
      workflowOutcome: undefined,
      delegatedToPatchRelay: true,
    });
    const run = createActiveRun(db, {
      linearIssueId: "issue-cap-impl",
      runType: "implementation",
      threadId: "thread-cap-impl",
      turnId: "turn-cap-impl",
    });

    await reconcileRun(orchestrator, run);

    const updatedIssue = db.getIssue("usertold", "issue-cap-impl")!;
    assertIssuePhase(updatedIssue, "delegated");
    assert.equal(updatedIssue.activeRunId, undefined);
    assert.ok(updatedIssue.capacityBackoffUntil);
    assert.equal(peekRunnableWorkflowTaskRunType(db, "usertold", "issue-cap-impl"), "implementation");
    assert.deepEqual(enqueueCalls, [{ projectId: "usertold", issueId: "issue-cap-impl" }]);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("capacity-failed queue_repair refunds the attempt, holds the repair state, and re-enqueues the workflowTask", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-capacity-queue-"));
  try {
    const failedTurn: CodexTurnSummary = {
      id: "turn-cap-2",
      status: "failed",
      error: { message: "Rate limit exceeded" },
      items: [],
    };
    const { db, orchestrator } = createHarness(baseDir, failedTurn, "thread-cap-2");
    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-cap-2",
      issueKey: "USE-202",
      branchName: "feat-cap-2",
      prNumber: 202,
      prState: "open",
      prCheckStatus: "failed",
      lastGitHubFailureSource: "queue_eviction",
      lastGitHubFailureHeadSha: "sha-202",
      lastGitHubFailureSignature: "queue_eviction::sha-202::queue",
      lastAttemptedFailureHeadSha: "sha-202",
      lastAttemptedFailureSignature: "queue_eviction::sha-202::queue",
      lastAttemptedFailureAt: "2026-06-10T00:00:00.000Z",
      workflowOutcome: undefined,
      queueRepairAttempts: 3,
      delegatedToPatchRelay: true,
    });
    const run = createActiveRun(db, {
      linearIssueId: "issue-cap-2",
      runType: "queue_repair",
      threadId: "thread-cap-2",
      turnId: "turn-cap-2",
    });

    await reconcileRun(orchestrator, run);

    const updatedIssue = db.getIssue("usertold", "issue-cap-2")!;
    const updatedRun = db.runs.getRunById(run.id)!;
    assert.equal(updatedRun.status, "failed");
    assert.equal(updatedRun.failureReason, `${FAILED_TURN_PREFIX}: Rate limit exceeded`);
    assert.equal(updatedIssue.queueRepairAttempts, 2);
    assertIssuePhase(updatedIssue, "repairing_queue");
    assert.equal(updatedIssue.activeRunId, undefined);
    assert.equal(updatedIssue.lastAttemptedFailureSignature, undefined);
    assert.ok(updatedIssue.capacityBackoffUntil);
    assert.ok(Date.parse(updatedIssue.capacityBackoffUntil!) > Date.now());
    assert.equal(db.issueSessions.peekPendingSessionInputPlanForDiagnostics("usertold", "issue-cap-2")?.runType, "queue_repair");
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("non-capacity failed turns still consume the budget and fail the issue exactly as before", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-capacity-regression-"));
  try {
    const { db, orchestrator } = createHarness(
      baseDir,
      { id: "turn-reg-1", status: "completed", items: [] },
      "thread-reg-1",
    );
    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-reg-1",
      issueKey: "USE-203",
      branchName: "feat-reg-1",
      prNumber: 203,
      prState: "open",
      prCheckStatus: "failed",
      workflowOutcome: undefined,
      ciRepairAttempts: 2,
      delegatedToPatchRelay: true,
    });
    const run = createActiveRun(db, {
      linearIssueId: "issue-reg-1",
      runType: "ci_repair",
      threadId: "thread-reg-1",
      turnId: "turn-reg-1",
    });

    // Drive the live notification path: the lease is held from launch in
    // production, so hold it here the same way.
    assert.ok(orchestrator.leaseService.acquire("usertold", "issue-reg-1"));
    await orchestrator.handleCodexNotification({
      method: "turn/completed",
      params: {
        threadId: "thread-reg-1",
        turn: {
          id: "turn-reg-1",
          status: "failed",
          error: { message: "TypeError: cannot read properties of undefined" },
        },
      },
    });

    const updatedIssue = db.getIssue("usertold", "issue-reg-1")!;
    const updatedRun = db.runs.getRunById(run.id)!;
    assert.equal(updatedRun.status, "failed");
    assert.equal(
      updatedRun.failureReason,
      `${FAILED_TURN_PREFIX}: TypeError: cannot read properties of undefined`,
    );
    // The attempt consumed at launch stays consumed and the issue escalates
    // to its terminal failure state, exactly as before.
    assert.equal(updatedIssue.ciRepairAttempts, 2);
    assertIssuePhase(updatedIssue, "failed");
    assert.equal(updatedIssue.activeRunId, undefined);
    assert.equal(updatedIssue.capacityBackoffUntil, undefined);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("capacity-failed turn via the notification path defers with the parsed retry time", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-capacity-notification-"));
  try {
    const { db, orchestrator } = createHarness(
      baseDir,
      { id: "turn-cap-3", status: "completed", items: [] },
      "thread-cap-3",
    );
    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-cap-3",
      issueKey: "USE-204",
      branchName: "feat-cap-3",
      prNumber: 204,
      prState: "open",
      prCheckStatus: "failed",
      lastGitHubFailureSource: "branch_ci",
      workflowOutcome: undefined,
      ciRepairAttempts: 1,
      delegatedToPatchRelay: true,
    });
    const run = createActiveRun(db, {
      linearIssueId: "issue-cap-3",
      runType: "ci_repair",
      threadId: "thread-cap-3",
      turnId: "turn-cap-3",
    });

    assert.ok(orchestrator.leaseService.acquire("usertold", "issue-cap-3"));
    await orchestrator.handleCodexNotification({
      method: "turn/completed",
      params: {
        threadId: "thread-cap-3",
        turn: {
          id: "turn-cap-3",
          status: "failed",
          error: { message: USAGE_LIMIT_MESSAGE },
        },
      },
    });

    const updatedIssue = db.getIssue("usertold", "issue-cap-3")!;
    const updatedRun = db.runs.getRunById(run.id)!;
    assert.equal(updatedRun.status, "failed");
    assert.equal(updatedRun.failureReason, `${FAILED_TURN_PREFIX}: ${USAGE_LIMIT_MESSAGE}`);
    assert.equal(updatedIssue.ciRepairAttempts, 0);
    assertIssuePhase(updatedIssue, "repairing_ci");
    assert.equal(updatedIssue.activeRunId, undefined);
    assert.ok(updatedIssue.capacityBackoffUntil);
    // "3:23 AM" parses to an absolute next occurrence (plus jitter), so the
    // backoff lands within the next day rather than the fixed fallback.
    assert.ok(Date.parse(updatedIssue.capacityBackoffUntil!) > Date.now());
    assert.ok(Date.parse(updatedIssue.capacityBackoffUntil!) < Date.now() + 25 * 60 * 60 * 1000);
    assert.equal(db.issueSessions.peekPendingSessionInputPlanForDiagnostics("usertold", "issue-cap-3")?.runType, "ci_repair");
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});
