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

    await (orchestrator as unknown as { reconcileIdleIssues: () => Promise<void> }).reconcileIdleIssues();

    const issue = db.getIssue("usertold", "issue-10");
    assert.equal(issue?.factoryState, "awaiting_queue");
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

    await (orchestrator as unknown as { reconcileIdleIssues: () => Promise<void> }).reconcileIdleIssues();

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

    await (orchestrator as unknown as { reconcileIdleIssues: () => Promise<void> }).reconcileIdleIssues();

    const issue = db.getIssue("usertold", "issue-12");
    assert.equal(issue?.factoryState, "repairing_ci");
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

    await (orchestrator as unknown as { reconcileIdleIssues: () => Promise<void> }).reconcileIdleIssues();

    const issue = db.getIssue("usertold", "issue-13");
    assert.equal(issue?.factoryState, "repairing_queue");
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

    let queueRequests = 0;
    (orchestrator as unknown as { requestMergeQueueAdmission: () => void }).requestMergeQueueAdmission = () => {
      queueRequests += 1;
    };

    await (orchestrator as unknown as { reconcileIdleIssues: () => Promise<void> }).reconcileIdleIssues();

    const issue = db.getIssue("usertold", "issue-15");
    assert.equal(issue?.factoryState, "awaiting_queue");
    assert.equal(queueRequests, 0);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});
