import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import test from "node:test";
import { assertIssuePhase } from "./assert-issue-phase.ts";
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
        id: "proj",
        repoPath: path.join(baseDir, "repo"),
        worktreeRoot: path.join(baseDir, "worktrees"),
        issueKeyPrefixes: ["PRJ"],
        linearTeamIds: ["PRJ"],
        allowLabels: [],
        triggerEvents: ["statusChanged"],
        branchPrefix: "prj",
        github: {
          repoFullName: "owner/repo",
        },
      },
    ],
    secretSources: {},
  };
}

/** Create an orchestrator with a fake gh binary on PATH. */
function createTestHarness(baseDir: string, ghScript: string) {
  const config = createConfig(baseDir);
  const db = new PatchRelayDatabase(config.database.path, config.database.wal);
  db.runMigrations();
  const enqueueCalls: Array<{ projectId: string; issueId: string }> = [];

  // Fake gh binary
  const fakeBin = path.join(baseDir, "bin");
  mkdirSync(fakeBin, { recursive: true });
  const ghPath = path.join(fakeBin, "gh");
  writeFileSync(ghPath, `#!/usr/bin/env bash\n${ghScript}`, "utf8");
  chmodSync(ghPath, 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${fakeBin}:${oldPath ?? ""}`;

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

  const reconcileQueueHealth = () =>
    (orchestrator as unknown as { queueHealthMonitor: { reconcile: () => Promise<void> } }).queueHealthMonitor.reconcile();

  return { config, db, enqueueCalls, orchestrator, reconcileQueueHealth, oldPath };
}

/** Insert an issue in awaiting_queue with updatedAt old enough to pass the grace period. */
function insertQueuedIssue(db: PatchRelayDatabase, overrides?: Record<string, unknown>) {
  const oldDate = new Date(Date.now() - 300_000).toISOString(); // 5 min ago
  db.upsertIssue({
    projectId: "proj",
    linearIssueId: "issue-1",
    issueKey: "PRJ-1",
    branchName: "feat-queued",
    prNumber: 42,
    prState: "open",
    prReviewState: "approved",
    prCheckStatus: "success",
    workflowOutcome: undefined,
    ...overrides,
  });
  // Force updatedAt back to bypass grace period
  db["connection"]
    .prepare("UPDATE issues SET updated_at = ? WHERE linear_issue_id = ?")
    .run(oldDate, (overrides as { linearIssueId?: string })?.linearIssueId ?? "issue-1");
}

// ─── Grace period ─────────────────────────────────────────────────

test("reconcileQueueHealth skips issues within the grace period", { concurrency: false }, async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "qhm-grace-"));
  let oldPath: string | undefined;
  try {
    const harness = createTestHarness(baseDir, 'echo "should not be called"; exit 1');
    oldPath = harness.oldPath;
    // Insert with current updatedAt (within grace period)
    harness.db.upsertIssue({
      projectId: "proj",
      linearIssueId: "issue-1",
      issueKey: "PRJ-1",
      branchName: "feat-queued",
      prNumber: 42,
      prState: "open",
      prReviewState: "approved",
      workflowOutcome: undefined,
    });

    await harness.reconcileQueueHealth();

    const issue = harness.db.getIssue("proj", "issue-1");
    assertIssuePhase(issue, "awaiting_queue");
  } finally {
    process.env.PATH = oldPath;
    rmSync(baseDir, { recursive: true, force: true });
  }
});

// ─── MERGED detection ─────────────────────────────────────────────

test("reconcileQueueHealth advances MERGED PR to done", { concurrency: false }, async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "qhm-merged-"));
  let oldPath: string | undefined;
  try {
    const ghScript = `
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  printf '{"state":"MERGED","mergeable":"","mergeStateStatus":"","headRefOid":"abc123","labels":[]}'
  exit 0
fi
exit 1`;
    const harness = createTestHarness(baseDir, ghScript);
    oldPath = harness.oldPath;
    insertQueuedIssue(harness.db);

    await harness.reconcileQueueHealth();

    const issue = harness.db.getIssue("proj", "issue-1");
    assertIssuePhase(issue, "done");
  } finally {
    process.env.PATH = oldPath;
    rmSync(baseDir, { recursive: true, force: true });
  }
});

// ─── CLOSED PR — skip ─────────────────────────────────────────────

test("reconcileQueueHealth skips closed PRs", { concurrency: false }, async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "qhm-closed-"));
  let oldPath: string | undefined;
  try {
    const ghScript = `
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  printf '{"state":"CLOSED","mergeable":"","mergeStateStatus":"","headRefOid":"abc123","labels":[]}'
  exit 0
fi
exit 1`;
    const harness = createTestHarness(baseDir, ghScript);
    oldPath = harness.oldPath;
    insertQueuedIssue(harness.db);

    await harness.reconcileQueueHealth();

    const issue = harness.db.getIssue("proj", "issue-1");
    assertIssuePhase(issue, "awaiting_queue");
  } finally {
    process.env.PATH = oldPath;
    rmSync(baseDir, { recursive: true, force: true });
  }
});

// ─── DIRTY downstream-waiting PR → queue_repair ───────────────────

test("reconcileQueueHealth dispatches queue_repair for DIRTY downstream-waiting PR", { concurrency: false }, async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "qhm-dirty-"));
  let oldPath: string | undefined;
  try {
    const ghScript = `
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  printf '{"state":"OPEN","mergeable":"CONFLICTING","mergeStateStatus":"DIRTY","headRefOid":"deadbeef"}'
  exit 0
fi
exit 1`;
    const harness = createTestHarness(baseDir, ghScript);
    oldPath = harness.oldPath;
    insertQueuedIssue(harness.db);

    await harness.reconcileQueueHealth();

    const issue = harness.db.getIssue("proj", "issue-1");
    assertIssuePhase(issue, "repairing_queue");
    const workflowTask = harness.db.issueSessions.peekPendingSessionInputPlanForDiagnostics("proj", "issue-1");
    assert.equal(workflowTask?.runType, "queue_repair");
    const ctx = workflowTask?.context ?? {};
    assert.equal(ctx.source, "queue_health_monitor");
    assert.equal(ctx.failureReason, "preemptive_conflict");
    assert.equal(ctx.failureHeadSha, "deadbeef");
    assert.deepEqual(harness.enqueueCalls, [{ projectId: "proj", issueId: "issue-1" }]);
  } finally {
    process.env.PATH = oldPath;
    rmSync(baseDir, { recursive: true, force: true });
  }
});

// ─── DIRTY without label → queue_repair for downstream upkeep ─────

test("reconcileQueueHealth dispatches queue_repair for DIRTY PR without label metadata", { concurrency: false }, async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "qhm-dirty-no-label-"));
  let oldPath: string | undefined;
  try {
    const ghScript = `
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  printf '{"state":"OPEN","mergeable":"CONFLICTING","mergeStateStatus":"DIRTY","headRefOid":"deadbeef"}'
  exit 0
fi
exit 1`;
    const harness = createTestHarness(baseDir, ghScript);
    oldPath = harness.oldPath;
    insertQueuedIssue(harness.db);

    await harness.reconcileQueueHealth();

    const issue = harness.db.getIssue("proj", "issue-1");
    assertIssuePhase(issue, "repairing_queue");
    assert.equal(harness.db.issueSessions.peekPendingSessionInputPlanForDiagnostics("proj", "issue-1")?.runType, "queue_repair");
    assert.deepEqual(harness.enqueueCalls, [{ projectId: "proj", issueId: "issue-1" }]);
  } finally {
    process.env.PATH = oldPath;
    rmSync(baseDir, { recursive: true, force: true });
  }
});

// ─── CLEAN — no action ───────────────────────────────────────────

test("reconcileQueueHealth takes no action for CLEAN PR", { concurrency: false }, async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "qhm-clean-"));
  let oldPath: string | undefined;
  try {
    const ghScript = `
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  printf '{"state":"OPEN","mergeable":"MERGEABLE","mergeStateStatus":"CLEAN","headRefOid":"abc123","labels":[{"name":"queue"}]}'
  exit 0
fi
exit 1`;
    const harness = createTestHarness(baseDir, ghScript);
    oldPath = harness.oldPath;
    insertQueuedIssue(harness.db);

    await harness.reconcileQueueHealth();

    const issue = harness.db.getIssue("proj", "issue-1");
    assertIssuePhase(issue, "awaiting_queue");
  } finally {
    process.env.PATH = oldPath;
    rmSync(baseDir, { recursive: true, force: true });
  }
});

// ─── Stale queue eviction — same head needs explicit new SHA ─────

test("reconcileQueueHealth dispatches fresh-head queue_repair for stale queue eviction check", { concurrency: false }, async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "qhm-stale-eviction-"));
  let oldPath: string | undefined;
  try {
    const ghScript = `
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  printf '{"state":"OPEN","mergeable":"MERGEABLE","mergeStateStatus":"UNSTABLE","headRefOid":"evictedhead"}'
  exit 0
fi
if [ "$1" = "api" ]; then
  printf 'merge-steward/queue\n'
  exit 0
fi
exit 1`;
    const harness = createTestHarness(baseDir, ghScript);
    oldPath = harness.oldPath;
    insertQueuedIssue(harness.db, {
      lastAttemptedFailureHeadSha: "evictedhead",
      lastAttemptedFailureSignature: "same_head_queue_eviction:evictedhead",
    });

    await harness.reconcileQueueHealth();

    const issue = harness.db.getIssue("proj", "issue-1");
    assertIssuePhase(issue, "repairing_queue");
    const workflowTask = harness.db.issueSessions.peekPendingSessionInputPlanForDiagnostics("proj", "issue-1");
    assert.equal(workflowTask?.runType, "queue_repair");
    assert.equal(workflowTask?.context.failureReason, "queue_eviction_missed");
    assert.equal(workflowTask?.context.failureSignature, "same_head_queue_eviction:evictedhead");
    assert.equal(workflowTask?.context.requiresFreshHead, true);
    assert.match(String(workflowTask?.context.promptContext), /will not re-admit the same evicted head SHA/);
    assert.deepEqual(harness.enqueueCalls, [{ projectId: "proj", issueId: "issue-1" }]);
  } finally {
    process.env.PATH = oldPath;
    rmSync(baseDir, { recursive: true, force: true });
  }
});

// ─── Deduplication — same headRefOid ──────────────────────────────

test("reconcileQueueHealth deduplicates on same headRefOid", { concurrency: false }, async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "qhm-dedup-"));
  let oldPath: string | undefined;
  try {
    const ghScript = `
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  printf '{"state":"OPEN","mergeable":"CONFLICTING","mergeStateStatus":"DIRTY","headRefOid":"deadbeef","labels":[{"name":"queue"}]}'
  exit 0
fi
exit 1`;
    const harness = createTestHarness(baseDir, ghScript);
    oldPath = harness.oldPath;
    insertQueuedIssue(harness.db);

    // First call — dispatches repair
    await harness.reconcileQueueHealth();
    const after1 = harness.db.getIssue("proj", "issue-1");
    assertIssuePhase(after1, "repairing_queue");
    assert.equal(harness.db.issueSessions.peekPendingSessionInputPlanForDiagnostics("proj", "issue-1")?.runType, "queue_repair");

    // Reset state to awaiting_queue to simulate the issue coming back
    // (e.g. repair completed but conflict remains with same head)
    harness.db.upsertIssue({
      projectId: "proj",
      linearIssueId: "issue-1",
      workflowOutcome: undefined,
      activeRunId: null,
    });
    harness.db.issueSessions.consumeIssueSessionEvents("proj", "issue-1", harness.db.issueSessions.listIssueSessionEvents("proj", "issue-1", { pendingOnly: true }).map((event) => event.id), 999);
    const oldDate = new Date(Date.now() - 300_000).toISOString();
    harness.db["connection"]
      .prepare("UPDATE issues SET updated_at = ? WHERE linear_issue_id = ?")
      .run(oldDate, "issue-1");

    harness.enqueueCalls.length = 0;

    // Second call — should be deduplicated (same headRefOid)
    await harness.reconcileQueueHealth();
    const after2 = harness.db.getIssue("proj", "issue-1");
    assertIssuePhase(after2, "repairing_queue");
    assert.deepEqual(harness.enqueueCalls, []);
  } finally {
    process.env.PATH = oldPath;
    rmSync(baseDir, { recursive: true, force: true });
  }
});

// ─── IN_REVIEW_STUCK — approved + red CI > 30 min ────────────────

test("listApprovedRedCiIssues returns approved+red issues with no run", () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "qhm-stuck-list-"));
  try {
    const harness = createTestHarness(baseDir, "exit 0");
    process.env.PATH = harness.oldPath;
    // Approved + red gate, In Review (pr_open), no active run.
    harness.db.upsertIssue({
      projectId: "proj",
      linearIssueId: "issue-1",
      issueKey: "PRJ-1",
      branchName: "feat-stuck",
      prNumber: 100,
      prState: "open",
      prReviewState: "approved",
      prCheckStatus: "failure",
      workflowOutcome: undefined,
    });
    // Same shape with an active repair run → excluded.
    const repairingIssue = harness.db.upsertIssue({
      projectId: "proj",
      linearIssueId: "issue-2",
      issueKey: "PRJ-2",
      branchName: "feat-repairing",
      prNumber: 101,
      prState: "open",
      prReviewState: "approved",
      prCheckStatus: "failure",
      workflowOutcome: undefined,
    });
    const repairRun = harness.db.runs.createRun({
      issueId: repairingIssue.id,
      projectId: "proj",
      linearIssueId: repairingIssue.linearIssueId,
      runType: "ci_repair",
    });
    harness.db.upsertIssue({
      projectId: "proj",
      linearIssueId: repairingIssue.linearIssueId,
      activeRunId: repairRun.id,
    });
    // Not approved → excluded.
    harness.db.upsertIssue({
      projectId: "proj",
      linearIssueId: "issue-3",
      issueKey: "PRJ-3",
      branchName: "feat-unreviewed",
      prNumber: 102,
      prState: "open",
      prReviewState: "review_requested",
      prCheckStatus: "failure",
      workflowOutcome: undefined,
    });

    const stuck = harness.db.issues.listApprovedRedCiIssues();
    const keys = stuck.map((i) => i.issueKey);
    assert.deepEqual(keys, ["PRJ-1"]);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

// ─── Probe failure — no state transition ─────────────────────────

test("reconcileQueueHealth does not transition state on probe failure", { concurrency: false }, async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "qhm-probe-fail-"));
  let oldPath: string | undefined;
  try {
    const harness = createTestHarness(baseDir, 'exit 1');
    oldPath = harness.oldPath;
    insertQueuedIssue(harness.db);

    await harness.reconcileQueueHealth();

    const issue = harness.db.getIssue("proj", "issue-1");
    assertIssuePhase(issue, "awaiting_queue");
  } finally {
    process.env.PATH = oldPath;
    rmSync(baseDir, { recursive: true, force: true });
  }
});
