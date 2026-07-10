import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import test from "node:test";
import { PatchRelayDatabase } from "../src/db.ts";
import { deriveIssueExecutionStateFromRecords } from "../src/issue-execution-state.ts";
import { ISSUE_SESSION_LEASE_MS } from "../src/issue-session-lease-service.ts";
import { RunOrchestrator } from "../src/run-orchestrator.ts";
import { RunTaskPlanner } from "../src/run-task-planner.ts";
import { MemoryPatchRelayTelemetry } from "../src/telemetry.ts";
import { reconcileWorkflowTasksForIssue } from "../src/workflow-task-reconciler.ts";
import type { AppConfig, CodexThreadSummary } from "../src/types.ts";

// Crash-injection suite (core simplification plan, "Ordering, risk,
// verification"): simulate "the process was killed between two writes of a
// multi-step path, then restarted". The crash is simulated by performing only
// the FIRST write(s) of the sequence against a real SQLite file and closing
// the connection; the restart is simulated by opening a FRESH
// PatchRelayDatabase over the same file and constructing fresh service
// objects (D4 made the DB lease row the only lease truth, so this is
// faithful). Each scenario then runs exactly ONE pass of the production
// recovery entry point (`RunOrchestrator.reconcileActiveRuns`, which chains
// run reconciliation → dangling-slot settlement → queue health → idle
// reconciliation) and asserts the state converged:
//   - no dangling activeRunId pointing at a terminal run,
//   - no stranded lease blocking runnable work,
//   - the run record is terminal or properly resumed,
//   - deriveIssueExecutionState never reports `inconsistent`.

const PROJECT = "usertold";

const DEAD_WORKER_ID = "patchrelay:dead-worker";

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
        id: PROJECT,
        repoPath: path.join(baseDir, "repo"),
        worktreeRoot: path.join(baseDir, "worktrees"),
        issueKeyPrefixes: ["USE"],
        linearTeamIds: ["USE"],
        allowLabels: [],
        reviewChecks: [],
        gateChecks: ["verify"],
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

function openDb(config: AppConfig): PatchRelayDatabase {
  const db = new PatchRelayDatabase(config.database.path, config.database.wal);
  db.runMigrations();
  return db;
}

// "The crash": run only the seed writes, then drop the connection. Anything
// the dead process would have done after these writes simply never happens.
function seedCrashedProcessState(config: AppConfig, seed: (db: PatchRelayDatabase) => void): void {
  const db = openDb(config);
  try {
    seed(db);
  } finally {
    db.close();
  }
}

// "The restart": fresh connection over the same file, fresh service objects.
function startRestartedService(
  config: AppConfig,
  options?: {
    readThread?: (threadId: string) => Promise<CodexThreadSummary>;
  },
) {
  const telemetry = new MemoryPatchRelayTelemetry();
  const db = new PatchRelayDatabase(config.database.path, config.database.wal, telemetry);
  db.runMigrations();
  const enqueueCalls: Array<{ projectId: string; issueId: string }> = [];
  const orchestrator = new RunOrchestrator(
    config,
    db,
    {
      startThreadForIssueTriage: async () => ({ id: "triage-thread", cwd: "/tmp/triage", preview: "", status: "idle", turns: [] }),
      startThread: async () => ({ threadId: "thread-fresh" }),
      steerTurn: async () => undefined,
      readThread: options?.readThread ?? (async () => ({ id: "thread-fresh", turns: [] })),
    } as never,
    { forProject: async () => undefined } as never,
    (projectId, issueId) => {
      enqueueCalls.push({ projectId, issueId });
    },
    pino({ enabled: false }),
    undefined,
    undefined,
    undefined,
    telemetry,
  );
  return { db, orchestrator, enqueueCalls, telemetry };
}

function installFakeGh(baseDir: string, responses: { prView?: unknown; apiStdout?: string }): () => void {
  const fakeBin = path.join(baseDir, "bin");
  const ghPath = path.join(fakeBin, "gh");
  mkdirSync(fakeBin, { recursive: true });
  const prViewJson = JSON.stringify(JSON.stringify(responses.prView ?? {}));
  writeFileSync(ghPath, `#!/usr/bin/env bash
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  printf '%s' ${prViewJson}
  exit 0
fi
if [ "$1" = "api" ]; then
  printf '%s' ${JSON.stringify(responses.apiStdout ?? "")}
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

/**
 * A foreign lease whose holder died: the TTL has NOT expired (so naive
 * "wait for expiry" recovery would stall for minutes), but the inferred
 * last heartbeat (`leasedUntil - ISSUE_SESSION_LEASE_MS`) is 3 minutes old —
 * past the 2x-heartbeat staleness threshold that D4's
 * `reclaimForeignRecoveryLeaseIfSafe` uses.
 */
function seedStaleForeignLease(db: PatchRelayDatabase, linearIssueId: string): void {
  const acquired = db.issueSessions.acquireIssueSessionLease({
    projectId: PROJECT,
    linearIssueId,
    leaseId: `dead-lease-${linearIssueId}`,
    workerId: DEAD_WORKER_ID,
    leasedUntil: new Date(Date.now() + ISSUE_SESSION_LEASE_MS - 3 * 60_000).toISOString(),
  });
  assert.equal(acquired, true, "fixture: dead worker's lease must be seeded");
}

function seedExpiredForeignLease(db: PatchRelayDatabase, linearIssueId: string): void {
  const acquired = db.issueSessions.acquireIssueSessionLease({
    projectId: PROJECT,
    linearIssueId,
    leaseId: `dead-lease-${linearIssueId}`,
    workerId: DEAD_WORKER_ID,
    leasedUntil: new Date(Date.now() + 1_000).toISOString(),
  });
  assert.equal(acquired, true, "fixture: dead worker's lease must be seeded");
  // Backdate the expiry instead of sleeping past it.
  db.unsafeRawConnectionForTests()
    .prepare("UPDATE issue_session_leases SET leased_until = ? WHERE project_id = ? AND linear_issue_id = ?")
    .run(new Date(Date.now() - 60_000).toISOString(), PROJECT, linearIssueId);
}

function assertConvergedIssue(db: PatchRelayDatabase, linearIssueId: string): void {
  const issue = db.getIssue(PROJECT, linearIssueId);
  assert.ok(issue, "issue row must exist after recovery");
  const activeRun = issue.activeRunId !== undefined ? db.runs.getRunById(issue.activeRunId) : undefined;
  const state = deriveIssueExecutionStateFromRecords(issue, { activeRun });
  assert.notEqual(
    state.kind,
    "inconsistent",
    `recovered issue must not be in an inconsistent execution state: ${JSON.stringify(state)}`,
  );
}

test("crash before settlement: interrupted ci_repair run settles, budget is refunded, repair re-routes in one pass", { concurrency: false }, async () => {
  // Multi-step path: launch consumed one ci_repair budget unit and recorded
  // the attempted-failure provenance; the Codex turn was then interrupted by
  // the crash, and settleRun never ran. The dead worker still holds an
  // unexpired (but heartbeat-stale) lease.
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-crash-interrupted-"));
  const restoreGh = installFakeGh(baseDir, {
    prView: {
      headRefOid: "sha-red",
      state: "OPEN",
      reviewDecision: "REVIEW_REQUIRED",
      mergeable: "MERGEABLE",
      mergeStateStatus: "BLOCKED",
      statusCheckRollup: [{ __typename: "CheckRun", name: "verify", status: "COMPLETED", conclusion: "FAILURE" }],
    },
  });
  const config = createConfig(baseDir);
  try {
    seedCrashedProcessState(config, (db) => {
      const issue = db.upsertIssue({
        projectId: PROJECT,
        linearIssueId: "issue-interrupted",
        issueKey: "USE-CR1",
        branchName: "feat-interrupted",
        prNumber: 41,
        prState: "open",
        prHeadSha: "sha-red",
        prAuthorLogin: "patchrelay[bot]",
        prCheckStatus: "failure",
        factoryState: "repairing_ci",
        delegatedToPatchRelay: true,
        ciRepairAttempts: 1,
        lastGitHubFailureSource: "branch_ci",
        lastGitHubFailureHeadSha: "sha-red",
        lastGitHubFailureSignature: "branch_ci::sha-red::verify",
        lastGitHubFailureCheckName: "verify",
        lastAttemptedFailureHeadSha: "sha-red",
        lastAttemptedFailureSignature: "branch_ci::sha-red::verify",
        lastAttemptedFailureAt: new Date().toISOString(),
      });
      const run = db.runs.createRun({
        issueId: issue.id,
        projectId: PROJECT,
        linearIssueId: issue.linearIssueId,
        runType: "ci_repair",
        sourceHeadSha: "sha-red",
      });
      db.upsertIssue({ projectId: PROJECT, linearIssueId: issue.linearIssueId, activeRunId: run.id });
      db.runs.updateRunThread(run.id, { threadId: "thread-ci", turnId: "turn-ci" });
      seedStaleForeignLease(db, issue.linearIssueId);
    });

    const { db, orchestrator, telemetry } = startRestartedService(config, {
      readThread: async () => ({
        id: "thread-ci",
        turns: [{ id: "turn-ci", status: "interrupted", items: [] }],
      }) as never,
    });
    try {
      await orchestrator.reconcileActiveRuns();

      const issue = db.getIssue(PROJECT, "issue-interrupted");
      const run = db.runs.getLatestRunForIssue(PROJECT, "issue-interrupted");
      assert.equal(run?.status, "failed", "interrupted run must be settled as failed");
      assert.equal(run?.failureReason, "Codex turn was interrupted");
      assert.equal(issue?.activeRunId, undefined, "the slot must be cleared");
      // Budget accounting: the interrupted attempt did no work, so the unit
      // consumed at launch is refunded and the attempted-failure provenance
      // is cleared so the same failure can be retried.
      assert.equal(issue?.ciRepairAttempts, 0);
      assert.equal(issue?.lastAttemptedFailureSignature, undefined);
      assert.equal(issue?.lastAttemptedFailureHeadSha, undefined);
      // The same idle pass routes the still-red failure again.
      assert.equal(issue?.factoryState, "repairing_ci");
      assert.equal(new RunTaskPlanner(db).resolveRunTask(db.getIssue(PROJECT, "issue-interrupted")!)?.runType, "ci_repair");
      // D4: the dead worker's heartbeat-stale lease was reclaimed without
      // waiting for TTL expiry, and is not left held after recovery.
      assert.equal(telemetry.list("lease.reclaimed").length, 1);
      const session = db.issueSessions.getIssueSession(PROJECT, "issue-interrupted");
      assert.notEqual(session?.workerId, DEAD_WORKER_ID, "the dead worker must not hold the lease anymore");
      assertConvergedIssue(db, "issue-interrupted");
    } finally {
      db.close();
    }
  } finally {
    restoreGh();
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("launch race: slot claimed but no thread persisted - restart settles the zombie and re-enqueues in one pass", async () => {
  // Multi-step path: claimRun wrote the run row and pointed activeRunId at
  // it; the crash landed before startThread persisted a threadId. The run
  // can never produce a notification, so without recovery the issue would
  // hold its slot forever.
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-crash-launch-race-"));
  const config = createConfig(baseDir);
  try {
    seedCrashedProcessState(config, (db) => {
      const issue = db.upsertIssue({
        projectId: PROJECT,
        linearIssueId: "issue-launch-race",
        issueKey: "USE-CR2",
        branchName: "feat-launch-race",
        factoryState: "delegated",
        delegatedToPatchRelay: true,
      });
      const run = db.runs.createRun({
        issueId: issue.id,
        projectId: PROJECT,
        linearIssueId: issue.linearIssueId,
        runType: "implementation",
      });
      db.upsertIssue({ projectId: PROJECT, linearIssueId: issue.linearIssueId, activeRunId: run.id });
      seedExpiredForeignLease(db, issue.linearIssueId);
    });

    const { db, orchestrator, enqueueCalls } = startRestartedService(config);
    try {
      await orchestrator.reconcileActiveRuns();

      const issue = db.getIssue(PROJECT, "issue-launch-race");
      const run = db.runs.getLatestRunForIssue(PROJECT, "issue-launch-race");
      assert.equal(run?.status, "failed");
      assert.match(run?.failureReason ?? "", /Zombie: never started/);
      assert.equal(issue?.activeRunId, undefined, "the claimed slot must be released");
      // The zombie budget was consumed and a recovery workflowTask was dispatched.
      assert.equal(issue?.zombieRecoveryAttempts, 1);
      assert.ok(issue?.lastZombieRecoveryAt, "the recovery timestamp arms the backoff");
      assert.equal(new RunTaskPlanner(db).resolveRunTask(db.getIssue(PROJECT, "issue-launch-race")!)?.runType, "implementation");
      assert.ok(
        enqueueCalls.some((call) => call.issueId === "issue-launch-race"),
        "the recovered issue must be handed back to the work queue in the same pass",
      );
      assertConvergedIssue(db, "issue-launch-race");
    } finally {
      db.close();
    }
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("thread persisted but gone after restart: stale foreign lease is reclaimed and the run settles in one pass", async () => {
  // Multi-step path: the thread id was persisted, but the Codex side lost
  // the thread across the crash (readThread fails). The dead worker's lease
  // is heartbeat-stale yet unexpired — pre-D4 this scenario waited out the
  // full lease TTL before any recovery could run.
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-crash-stale-thread-"));
  const config = createConfig(baseDir);
  try {
    seedCrashedProcessState(config, (db) => {
      const issue = db.upsertIssue({
        projectId: PROJECT,
        linearIssueId: "issue-stale-thread",
        issueKey: "USE-CR3",
        branchName: "feat-stale-thread",
        factoryState: "implementing",
        delegatedToPatchRelay: true,
      });
      const run = db.runs.createRun({
        issueId: issue.id,
        projectId: PROJECT,
        linearIssueId: issue.linearIssueId,
        runType: "implementation",
      });
      db.upsertIssue({ projectId: PROJECT, linearIssueId: issue.linearIssueId, activeRunId: run.id });
      db.runs.updateRunThread(run.id, { threadId: "thread-lost", turnId: "turn-lost" });
      seedStaleForeignLease(db, issue.linearIssueId);
    });

    const { db, orchestrator, telemetry } = startRestartedService(config, {
      readThread: async () => {
        throw new Error("thread not found after restart");
      },
    });
    try {
      await orchestrator.reconcileActiveRuns();

      assert.equal(telemetry.list("lease.reclaimed").length, 1, "the heartbeat-stale foreign lease must be reclaimed (D4)");
      const issue = db.getIssue(PROJECT, "issue-stale-thread");
      const run = db.runs.getLatestRunForIssue(PROJECT, "issue-stale-thread");
      assert.equal(run?.status, "failed");
      assert.equal(run?.failureReason, "Stale thread after restart");
      assert.equal(issue?.activeRunId, undefined);
      assert.equal(issue?.zombieRecoveryAttempts, 1);
      assert.equal(new RunTaskPlanner(db).resolveRunTask(db.getIssue(PROJECT, "issue-stale-thread")!)?.runType, "implementation");
      const session = db.issueSessions.getIssueSession(PROJECT, "issue-stale-thread");
      assert.notEqual(session?.workerId, DEAD_WORKER_ID);
      assertConvergedIssue(db, "issue-stale-thread");
    } finally {
      db.close();
    }
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("workflowTask appended but dispatch lost: restart dispatches exactly once with no duplicate workflowTask", { concurrency: false }, async () => {
  // Multi-step path: the session event (workflowTask) was appended durably, but the
  // crash took the in-memory work queue before enqueueIssue ran. The workflowTask
  // must survive the restart and be dispatched exactly once by the next
  // reconciliation pass — not duplicated, not dropped.
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-crash-lost-dispatch-"));
  const restoreGh = installFakeGh(baseDir, {
    prView: {
      headRefOid: "sha-workflowTask",
      state: "OPEN",
      reviewDecision: "CHANGES_REQUESTED",
      mergeable: "MERGEABLE",
      mergeStateStatus: "BLOCKED",
      statusCheckRollup: [{ __typename: "CheckRun", name: "verify", status: "COMPLETED", conclusion: "SUCCESS" }],
    },
  });
  const config = createConfig(baseDir);
  try {
    seedCrashedProcessState(config, (db) => {
      const issue = db.upsertIssue({
        projectId: PROJECT,
        linearIssueId: "issue-lost-dispatch",
        issueKey: "USE-CR4",
        branchName: "feat-lost-dispatch",
        prNumber: 200,
        prState: "open",
        prHeadSha: "sha-workflowTask",
        prAuthorLogin: "patchrelay[bot]",
        prReviewState: "changes_requested",
        prCheckStatus: "success",
        factoryState: "changes_requested",
        delegatedToPatchRelay: true,
      });
      db.issueSessions.appendIssueSessionEventRespectingActiveLease(PROJECT, issue.linearIssueId, {
        projectId: PROJECT,
        linearIssueId: issue.linearIssueId,
        eventType: "review_changes_requested",
        eventJson: JSON.stringify({ reviewerName: "review-quill[bot]" }),
        dedupeKey: "review_changes_requested::sha-workflowTask::review-quill[bot]",
      });
      // CRASH here: enqueueIssue never ran in the dead process.
    });

    const { db, orchestrator, enqueueCalls } = startRestartedService(config);
    try {
      await orchestrator.reconcileActiveRuns();

      const dispatches = enqueueCalls.filter((call) => call.issueId === "issue-lost-dispatch");
      assert.equal(dispatches.length, 1, "the surviving workflowTask must be dispatched exactly once per pass");
      assert.equal(new RunTaskPlanner(db).resolveRunTask(db.getIssue(PROJECT, "issue-lost-dispatch")!)?.runType, "review_fix");
      const events = db.issueSessions.listIssueSessionEvents(PROJECT, "issue-lost-dispatch");
      assert.equal(events.length, 1, "re-derivation must not append a duplicate workflowTask event");
      assert.equal(db.getIssue(PROJECT, "issue-lost-dispatch")?.factoryState, "changes_requested");
      assert.equal(db.runs.listRunsForIssue(PROJECT, "issue-lost-dispatch").length, 0, "no duplicate run may be created by the dispatch itself");
      assertConvergedIssue(db, "issue-lost-dispatch");
    } finally {
      db.close();
    }
  } finally {
    restoreGh();
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("finalizer seam: run already terminal but slot not cleared - settle and route in one pass", { concurrency: false }, async () => {
  // Multi-step path: settleRun itself is one transaction (plan B1), so the
  // remaining crash seam is a run row that reached a terminal status through
  // another writer (notification handler, supersedure observer) while the
  // crash prevented the slot-clearing settle from ever running. This is the
  // USE-364 / PR #566 freeze shape; recovery is settleDanglingActiveRuns +
  // idle routing in the SAME pass.
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-crash-dangling-slot-"));
  const restoreGh = installFakeGh(baseDir, {
    prView: {
      headRefOid: "sha-ok",
      state: "OPEN",
      reviewDecision: "APPROVED",
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
      statusCheckRollup: [{ __typename: "CheckRun", name: "verify", status: "COMPLETED", conclusion: "SUCCESS" }],
    },
  });
  const config = createConfig(baseDir);
  try {
    seedCrashedProcessState(config, (db) => {
      const issue = db.upsertIssue({
        projectId: PROJECT,
        linearIssueId: "issue-dangling",
        issueKey: "USE-CR5",
        branchName: "feat-dangling",
        prNumber: 77,
        prState: "open",
        prHeadSha: "sha-ok",
        prAuthorLogin: "patchrelay[bot]",
        prReviewState: "approved",
        prCheckStatus: "success",
        factoryState: "pr_open",
        delegatedToPatchRelay: true,
      });
      const run = db.runs.createRun({
        issueId: issue.id,
        projectId: PROJECT,
        linearIssueId: issue.linearIssueId,
        runType: "review_fix",
      });
      db.upsertIssue({ projectId: PROJECT, linearIssueId: issue.linearIssueId, activeRunId: run.id });
      db.runs.updateRunThread(run.id, { threadId: "thread-done", turnId: "turn-done" });
      db.runs.finishRun(run.id, { status: "completed", threadId: "thread-done" });
      // CRASH here: the run row is terminal but activeRunId still points at it.
    });

    const { db, orchestrator } = startRestartedService(config);
    try {
      // Before recovery the row IS observably inconsistent — that is the bug
      // shape this scenario injects.
      const before = db.getIssue(PROJECT, "issue-dangling");
      assert.ok(before?.activeRunId !== undefined);
      assert.equal(
        deriveIssueExecutionStateFromRecords(before, {
          activeRun: db.runs.getRunById(before.activeRunId ?? -1),
        }).kind,
        "inconsistent",
      );

      await orchestrator.reconcileActiveRuns();

      const issue = db.getIssue(PROJECT, "issue-dangling");
      assert.equal(issue?.activeRunId, undefined, "the dangling slot must be cleared");
      assert.equal(db.runs.getLatestRunForIssue(PROJECT, "issue-dangling")?.status, "completed", "the terminal run record is untouched");
      // The same pass routes the freed issue from GitHub truth.
      assert.equal(issue?.factoryState, "awaiting_queue");
      assertConvergedIssue(db, "issue-dangling");
    } finally {
      db.close();
    }
  } finally {
    restoreGh();
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("stranded expired lease on runnable work: restart with a different worker dispatches and can acquire in one pass", async () => {
  // Multi-step path: the dead worker appended a workflowTask and held the session
  // lease when it died; the lease TTL has since expired. The restart (a
  // different workerId) must treat the leftover lease row as no obstacle:
  // the workflowTask is dispatched by the first pass and the lease is acquirable
  // immediately. The actual Codex launch cannot be exercised offline (it
  // needs a live app-server and a git worktree), so this scenario asserts
  // the DB-state convergence that gates the launch: runnable workflowTask + free
  // lease + dispatch.
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-crash-stranded-lease-"));
  const config = createConfig(baseDir);
  try {
    seedCrashedProcessState(config, (db) => {
      const issue = db.upsertIssue({
        projectId: PROJECT,
        linearIssueId: "issue-stranded-lease",
        issueKey: "USE-CR6",
        branchName: "feat-stranded-lease",
        factoryState: "delegated",
        delegatedToPatchRelay: true,
      });
      db.issueSessions.appendIssueSessionEventRespectingActiveLease(PROJECT, issue.linearIssueId, {
        projectId: PROJECT,
        linearIssueId: issue.linearIssueId,
        eventType: "delegated",
        dedupeKey: `delegated:${issue.linearIssueId}`,
      });
      reconcileWorkflowTasksForIssue(db, issue);
      seedExpiredForeignLease(db, issue.linearIssueId);
    });

    const { db, orchestrator, enqueueCalls } = startRestartedService(config);
    try {
      await orchestrator.reconcileActiveRuns();

      const dispatches = enqueueCalls.filter((call) => call.issueId === "issue-stranded-lease");
      assert.equal(dispatches.length, 1, "the runnable workflowTask must be dispatched despite the leftover lease row");
      assert.equal(new RunTaskPlanner(db).resolveRunTask(db.getIssue(PROJECT, "issue-stranded-lease")!)?.runType, "implementation");

      // The launch path's first gate is lease acquisition: a different
      // worker must win it over the expired foreign lease in one call.
      const leaseId = orchestrator.leaseService.acquire(PROJECT, "issue-stranded-lease");
      assert.ok(leaseId, "the expired foreign lease must not block a new worker's acquire");
      const session = db.issueSessions.getIssueSession(PROJECT, "issue-stranded-lease");
      assert.equal(session?.workerId, orchestrator.leaseService.workerId);
      orchestrator.leaseService.release(PROJECT, "issue-stranded-lease");
      assertConvergedIssue(db, "issue-stranded-lease");
    } finally {
      db.close();
    }
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});
