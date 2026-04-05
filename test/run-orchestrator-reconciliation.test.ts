import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import test from "node:test";
import { PatchRelayDatabase } from "../src/db.ts";
import { RunOrchestrator } from "../src/run-orchestrator.ts";
import type { AppConfig } from "../src/types.ts";

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

function createOrchestrator(baseDir: string) {
  const config = createConfig(baseDir);
  const db = new PatchRelayDatabase(config.database.path, config.database.wal);
  db.runMigrations();
  const enqueueCalls: Array<{ projectId: string; issueId: string }> = [];
  const orchestrator = new RunOrchestrator(
    config,
    db,
    {
      startThread: async () => ({ threadId: "thread-1" }),
      steerTurn: async () => undefined,
      readThread: async () => ({ id: "thread-1", turns: [] }),
    } as never,
    { forProject: async () => undefined } as never,
    (projectId, issueId) => {
      enqueueCalls.push({ projectId, issueId });
    },
    pino({ enabled: false }),
  );
  return { config, db, enqueueCalls, orchestrator };
}

test("reconcileIdleIssues advances approved idle issues to awaiting_queue", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-reconcile-approved-"));
  try {
    const { db, orchestrator } = createOrchestrator(baseDir);
    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-10",
      issueKey: "USE-10",
      branchName: "feat-approved",
      prNumber: 10,
      prState: "open",
      prReviewState: "approved",
      prCheckStatus: "success",
      factoryState: "pr_open",
    });

    await (orchestrator as unknown as { idleReconciler: { reconcile: () => Promise<void> } }).idleReconciler.reconcile();

    const issue = db.getIssue("usertold", "issue-10");
    assert.equal(issue?.factoryState, "awaiting_queue");
    assert.equal(issue?.branchOwner, "merge_steward");
    assert.equal(issue?.pendingRunType, undefined);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("reconcileIdleIssues marks merged idle issues done without enqueueing", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-reconcile-merged-"));
  try {
    const { db, orchestrator } = createOrchestrator(baseDir);
    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-11",
      issueKey: "USE-11",
      branchName: "feat-merged",
      prNumber: 11,
      prState: "merged",
      factoryState: "pr_open",
    });

    await (orchestrator as unknown as { idleReconciler: { reconcile: () => Promise<void> } }).idleReconciler.reconcile();

    const issue = db.getIssue("usertold", "issue-11");
    assert.equal(issue?.factoryState, "done");
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("reconcileIdleIssues currently routes failed idle issues to ci_repair", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-reconcile-failed-"));
  try {
    const { db, enqueueCalls, orchestrator } = createOrchestrator(baseDir);
    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-12",
      issueKey: "USE-12",
      branchName: "feat-failed",
      prNumber: 12,
      prState: "open",
      prCheckStatus: "failed",
      factoryState: "pr_open",
    });

    await (orchestrator as unknown as { idleReconciler: { reconcile: () => Promise<void> } }).idleReconciler.reconcile();

    const issue = db.getIssue("usertold", "issue-12");
    assert.equal(issue?.factoryState, "repairing_ci");
    assert.equal(issue?.branchOwner, "patchrelay");
    assert.equal(issue?.pendingRunType, "ci_repair");
    assert.deepEqual(enqueueCalls, [{ projectId: "usertold", issueId: "issue-12" }]);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("reconcileIdleIssues preserves stored steward incident context for queue repairs", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-reconcile-queue-incident-"));
  try {
    const { db, enqueueCalls, orchestrator } = createOrchestrator(baseDir);
    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-13",
      issueKey: "USE-13",
      branchName: "feat-queue-failed",
      prNumber: 13,
      prState: "open",
      prCheckStatus: "failed",
      factoryState: "awaiting_queue",
      lastGitHubFailureSource: "queue_eviction",
      lastGitHubFailureCheckName: "merge-steward/queue",
      lastGitHubFailureCheckUrl: "https://github.com/owner/repo/actions/runs/13",
      lastQueueIncidentJson: JSON.stringify({
        failureReason: "queue_eviction",
        checkName: "merge-steward/queue",
        checkUrl: "https://github.com/owner/repo/actions/runs/13",
        incidentId: "incident-13",
        incidentUrl: "https://queue.example.com/queue/incidents/incident-13",
        incidentTitle: "Queue eviction: CI failure (branch-specific)",
        incidentSummary: "PR #13 was evicted from the merge queue.",
        incidentContext: {
          version: 1,
          failureClass: "branch_local",
          baseSha: "base-13",
          prHeadSha: "head-13",
          queuePosition: 2,
          baseBranch: "main",
          branch: "feat-queue-failed",
          retryHistory: [{ at: "2026-03-31T00:00:00.000Z", baseSha: "base-12", outcome: "ci_failed_retry" }],
        },
      }),
    });

    await (orchestrator as unknown as { idleReconciler: { reconcile: () => Promise<void> } }).idleReconciler.reconcile();

    const issue = db.getIssue("usertold", "issue-13");
    assert.equal(issue?.factoryState, "repairing_queue");
    assert.equal(issue?.branchOwner, "patchrelay");
    assert.equal(issue?.pendingRunType, "queue_repair");
    assert.deepEqual(JSON.parse(issue?.pendingRunContextJson ?? "{}"), {
      failureReason: "queue_eviction",
      checkName: "merge-steward/queue",
      checkUrl: "https://github.com/owner/repo/actions/runs/13",
      incidentId: "incident-13",
      incidentUrl: "https://queue.example.com/queue/incidents/incident-13",
      incidentTitle: "Queue eviction: CI failure (branch-specific)",
      incidentSummary: "PR #13 was evicted from the merge queue.",
      incidentContext: {
        version: 1,
        failureClass: "branch_local",
        baseSha: "base-13",
        prHeadSha: "head-13",
        queuePosition: 2,
        baseBranch: "main",
        branch: "feat-queue-failed",
        retryHistory: [{ at: "2026-03-31T00:00:00.000Z", baseSha: "base-12", outcome: "ci_failed_retry" }],
      },
    });
    assert.deepEqual(enqueueCalls, [{ projectId: "usertold", issueId: "issue-13" }]);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("reconcileRun recovers interrupted implementation runs to pr_open when a PR already exists", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-reconcile-interrupted-pr-open-"));
  try {
    const config = createConfig(baseDir);
    const db = new PatchRelayDatabase(config.database.path, config.database.wal);
    db.runMigrations();
    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-14",
      issueKey: "USE-14",
      branchName: "feat-interrupted",
      prNumber: 14,
      prState: "open",
      prCheckStatus: "success",
      factoryState: "implementing",
    });
    const issue = db.getIssue("usertold", "issue-14");
    assert.ok(issue);
    const run = db.createRun({
      issueId: issue.id,
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      runType: "implementation",
      promptText: "Implement USE-14",
    });
    db.updateRunThread(run.id, { threadId: "thread-14", turnId: "turn-14" });
    db.upsertIssue({
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      activeRunId: run.id,
      factoryState: "implementing",
    });

    const orchestrator = new RunOrchestrator(
      config,
      db,
      {
        startThread: async () => ({ threadId: "thread-14" }),
        steerTurn: async () => undefined,
        readThread: async () => ({
          id: "thread-14",
          turns: [{ id: "turn-14", status: "interrupted" }],
        }),
      } as never,
      { forProject: async () => undefined } as never,
      () => undefined,
      pino({ enabled: false }),
    );

    await (orchestrator as unknown as { reconcileRun: (run: ReturnType<typeof db.createRun>) => Promise<void> }).reconcileRun(
      db.getRun(run.id)!,
    );

    const updatedIssue = db.getIssue("usertold", "issue-14");
    const updatedRun = db.getRun(run.id);
    assert.equal(updatedIssue?.factoryState, "pr_open");
    assert.equal(updatedIssue?.activeRunId, undefined);
    assert.equal(updatedRun?.status, "failed");
    assert.equal(updatedRun?.failureReason, "Codex turn was interrupted");
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("reconcileRun tolerates pending thread materialization and recovers on the next pass", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-reconcile-materializing-"));
  try {
    const config = createConfig(baseDir);
    const db = new PatchRelayDatabase(config.database.path, config.database.wal);
    db.runMigrations();
    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-14b",
      issueKey: "USE-14B",
      branchName: "feat-materializing",
      prNumber: 141,
      prState: "open",
      prCheckStatus: "success",
      factoryState: "implementing",
    });
    const issue = db.getIssue("usertold", "issue-14b");
    assert.ok(issue);
    const run = db.createRun({
      issueId: issue.id,
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      runType: "implementation",
      promptText: "Implement USE-14B",
    });
    db.updateRunThread(run.id, { threadId: "thread-14b", turnId: "turn-14b" });
    db.upsertIssue({
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      activeRunId: run.id,
      factoryState: "implementing",
    });

    let includeTurnsReadAttempts = 0;
    const materializationError = new Error(JSON.stringify({
      code: -32600,
      message: "thread thread-14b is not materialized yet; includeTurns is unavailable before first user message",
    }));
    const orchestrator = new RunOrchestrator(
      config,
      db,
      {
        startThread: async () => ({ threadId: "thread-14b" }),
        steerTurn: async () => undefined,
        readThread: async (_threadId: string, includeTurns = true) => {
          if (!includeTurns) {
            return { id: "thread-14b", status: "notLoaded", turns: [] };
          }
          includeTurnsReadAttempts += 1;
          if (includeTurnsReadAttempts <= 3) {
            throw materializationError;
          }
          return {
            id: "thread-14b",
            status: "notLoaded",
            turns: [{ id: "turn-14b", status: "interrupted", items: [] }],
          };
        },
      } as never,
      { forProject: async () => undefined } as never,
      () => undefined,
      pino({ enabled: false }),
    );

    await (orchestrator as unknown as { reconcileRun: (run: ReturnType<typeof db.createRun>) => Promise<void> }).reconcileRun(
      db.getRun(run.id)!,
    );

    const afterPendingPass = db.getIssue("usertold", "issue-14b");
    assert.equal(afterPendingPass?.factoryState, "implementing");
    assert.equal(afterPendingPass?.activeRunId, run.id);
    assert.equal(db.getRun(run.id)?.status, "running");

    await (orchestrator as unknown as { reconcileRun: (run: ReturnType<typeof db.createRun>) => Promise<void> }).reconcileRun(
      db.getRun(run.id)!,
    );

    const updatedIssue = db.getIssue("usertold", "issue-14b");
    const updatedRun = db.getRun(run.id);
    assert.equal(updatedIssue?.factoryState, "pr_open");
    assert.equal(updatedIssue?.activeRunId, undefined);
    assert.equal(updatedRun?.status, "failed");
    assert.equal(updatedRun?.failureReason, "Codex turn was interrupted");
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("turn completed notification defers completion while the thread is still materializing", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-turn-completed-materializing-"));
  try {
    const config = createConfig(baseDir);
    const db = new PatchRelayDatabase(config.database.path, config.database.wal);
    db.runMigrations();
    const issueRecord = db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-14c",
      issueKey: "USE-14C",
      branchName: "feat-materializing-notification",
      factoryState: "implementing",
    });
    const run = db.createRun({
      issueId: issueRecord.id,
      projectId: issueRecord.projectId,
      linearIssueId: issueRecord.linearIssueId,
      runType: "implementation",
      promptText: "Implement USE-14C",
    });
    db.updateRunThread(run.id, { threadId: "thread-14c", turnId: "turn-14c" });
    db.upsertIssue({
      projectId: issueRecord.projectId,
      linearIssueId: issueRecord.linearIssueId,
      activeRunId: run.id,
      threadId: "thread-14c",
      factoryState: "implementing",
    });

    const materializationError = new Error(JSON.stringify({
      code: -32600,
      message: "thread thread-14c is not materialized yet; includeTurns is unavailable before first user message",
    }));
    let includeTurnsAttempts = 0;
    const orchestrator = new RunOrchestrator(
      config,
      db,
      {
        startThread: async () => ({ threadId: "thread-14c" }),
        steerTurn: async () => undefined,
        readThread: async (_threadId: string, includeTurns = true) => {
          if (!includeTurns) {
            return { id: "thread-14c", status: "notLoaded", turns: [] };
          }
          includeTurnsAttempts += 1;
          if (includeTurnsAttempts <= 3) {
            throw materializationError;
          }
          return {
            id: "thread-14c",
            status: "notLoaded",
            turns: [{ id: "turn-14c", status: "completed", items: [] }],
          };
        },
      } as never,
      { forProject: async () => undefined } as never,
      () => undefined,
      pino({ enabled: false }),
    );

    await orchestrator.handleCodexNotification({
      method: "turn/completed",
      params: {
        threadId: "thread-14c",
        turn: { id: "turn-14c", status: "completed" },
      },
    } as never);

    const deferredIssue = db.getIssue("usertold", "issue-14c");
    const deferredRun = db.getRun(run.id);
    assert.equal(deferredIssue?.factoryState, "implementing");
    assert.equal(deferredIssue?.activeRunId, run.id);
    assert.equal(deferredRun?.status, "running");

    await (orchestrator as unknown as { reconcileRun: (run: ReturnType<typeof db.createRun>) => Promise<void> }).reconcileRun(
      db.getRun(run.id)!,
    );

    const completedIssue = db.getIssue("usertold", "issue-14c");
    const completedRun = db.getRun(run.id);
    assert.equal(completedIssue?.activeRunId, undefined);
    assert.equal(completedRun?.status, "completed");
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("reconcileRun keeps interrupted ci_repair runs in repairing_ci when the PR is still failing", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-reconcile-interrupted-ci-"));
  try {
    const config = createConfig(baseDir);
    const db = new PatchRelayDatabase(config.database.path, config.database.wal);
    db.runMigrations();
    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-15",
      issueKey: "USE-15",
      branchName: "feat-interrupted-ci",
      prNumber: 15,
      prState: "open",
      prCheckStatus: "failed",
      lastGitHubFailureSource: "branch_ci",
      factoryState: "repairing_ci",
      ciRepairAttempts: 1,
    });
    const issue = db.getIssue("usertold", "issue-15");
    assert.ok(issue);
    const run = db.createRun({
      issueId: issue.id,
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      runType: "ci_repair",
    });
    db.updateRunThread(run.id, { threadId: "thread-15", turnId: "turn-15" });
    db.upsertIssue({
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      activeRunId: run.id,
    });

    const orchestrator = new RunOrchestrator(
      config,
      db,
      {
        startThread: async () => ({ threadId: "thread-15" }),
        steerTurn: async () => undefined,
        readThread: async () => ({ id: "thread-15", turns: [{ id: "turn-15", status: "interrupted" }] }),
      } as never,
      { forProject: async () => undefined } as never,
      () => undefined,
      pino({ enabled: false }),
    );

    await (orchestrator as unknown as { reconcileRun: (run: { id: number }) => Promise<void> }).reconcileRun(db.getRun(run.id)!);

    const updatedIssue = db.getIssue("usertold", "issue-15");
    const updatedRun = db.getRun(run.id);
    assert.equal(updatedIssue?.factoryState, "repairing_ci");
    assert.equal(updatedIssue?.activeRunId, undefined);
    assert.equal(updatedIssue?.ciRepairAttempts, 0);
    assert.equal(updatedRun?.status, "failed");
    assert.equal(updatedRun?.failureReason, "Codex turn was interrupted");
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("completed ci_repair does not succeed when PR head never advanced", { concurrency: false }, async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-reconcile-head-verify-"));
  const oldPath = process.env.PATH;
  try {
    const fakeBin = path.join(baseDir, "bin");
    const ghPath = path.join(fakeBin, "gh");
    mkdirSync(fakeBin, { recursive: true });
    writeFileSync(ghPath, `#!/usr/bin/env bash
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  printf '{"headRefOid":"same-head-sha","state":"OPEN"}'
  exit 0
fi
exit 1
`, "utf8");
    chmodSync(ghPath, 0o755);
    process.env.PATH = `${fakeBin}:${oldPath ?? ""}`;

    const config = createConfig(baseDir);
    const db = new PatchRelayDatabase(config.database.path, config.database.wal);
    db.runMigrations();
    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-16",
      issueKey: "USE-16",
      branchName: "feat-no-advance",
      prNumber: 16,
      prState: "open",
      prCheckStatus: "failed",
      lastGitHubFailureSource: "branch_ci",
      lastGitHubFailureHeadSha: "same-head-sha",
      lastGitHubFailureSignature: "branch_ci::same-head-sha::Checks::Run tests",
      factoryState: "repairing_ci",
    });
    const issue = db.getIssue("usertold", "issue-16");
    assert.ok(issue);
    const run = db.createRun({
      issueId: issue.id,
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      runType: "ci_repair",
    });
    db.updateRunThread(run.id, { threadId: "thread-16", turnId: "turn-16" });
    db.upsertIssue({
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      activeRunId: run.id,
    });

    const orchestrator = new RunOrchestrator(
      config,
      db,
      {
        startThread: async () => ({ threadId: "thread-16" }),
        steerTurn: async () => undefined,
        readThread: async () => ({ id: "thread-16", turns: [{ id: "turn-16", status: "completed", items: [] }] }),
      } as never,
      { forProject: async () => undefined } as never,
      () => undefined,
      pino({ enabled: false }),
    );

    await (orchestrator as unknown as { reconcileRun: (run: { id: number }) => Promise<void> }).reconcileRun(db.getRun(run.id)!);

    const updatedIssue = db.getIssue("usertold", "issue-16");
    const updatedRun = db.getRun(run.id);
    assert.equal(updatedIssue?.factoryState, "repairing_ci");
    assert.equal(updatedIssue?.activeRunId, undefined);
    assert.equal(updatedRun?.status, "failed");
    assert.match(updatedRun?.failureReason ?? "", /still on failing head/);
  } finally {
    process.env.PATH = oldPath;
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("reconcileIdleIssues does not re-request queue handoff for issues already awaiting_queue", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-reconcile-awaiting-queue-"));
  try {
    const { db, orchestrator } = createOrchestrator(baseDir);
    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-15",
      issueKey: "USE-15",
      branchName: "feat-awaiting-queue",
      prNumber: 15,
      prState: "open",
      prReviewState: "approved",
      prCheckStatus: "success",
      factoryState: "awaiting_queue",
    });
    db.setBranchOwner("usertold", "issue-15", "patchrelay");

    let queueRequests = 0;
    (orchestrator as unknown as { requestMergeQueueAdmission: () => void }).requestMergeQueueAdmission = () => {
      queueRequests += 1;
    };

    await (orchestrator as unknown as { idleReconciler: { reconcile: () => Promise<void> } }).idleReconciler.reconcile();

    const issue = db.getIssue("usertold", "issue-15");
    assert.equal(issue?.factoryState, "awaiting_queue");
    assert.equal(issue?.branchOwner, "merge_steward");
    assert.equal(queueRequests, 0);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});
