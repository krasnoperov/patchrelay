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
    factoryState: "awaiting_queue",
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
      factoryState: "awaiting_queue",
    });

    await harness.reconcileQueueHealth();

    const issue = harness.db.getIssue("proj", "issue-1");
    assert.equal(issue?.factoryState, "awaiting_queue");
    assert.equal(issue?.pendingRunType, undefined);
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
    assert.equal(issue?.factoryState, "done");
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
    assert.equal(issue?.factoryState, "awaiting_queue");
    assert.equal(issue?.pendingRunType, undefined);
  } finally {
    process.env.PATH = oldPath;
    rmSync(baseDir, { recursive: true, force: true });
  }
});

// ─── DIRTY + label → queue_repair ─────────────────────────────────

test("reconcileQueueHealth dispatches queue_repair for DIRTY PR with queue label", { concurrency: false }, async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "qhm-dirty-"));
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

    await harness.reconcileQueueHealth();

    const issue = harness.db.getIssue("proj", "issue-1");
    assert.equal(issue?.factoryState, "repairing_queue");
    assert.equal(issue?.pendingRunType, "queue_repair");
    assert.equal(issue?.branchOwner, "patchrelay");
    const ctx = JSON.parse(issue?.pendingRunContextJson ?? "{}");
    assert.equal(ctx.source, "queue_health_monitor");
    assert.equal(ctx.failureReason, "preemptive_conflict");
    assert.equal(ctx.failureHeadSha, "deadbeef");
    assert.deepEqual(harness.enqueueCalls, [{ projectId: "proj", issueId: "issue-1" }]);
  } finally {
    process.env.PATH = oldPath;
    rmSync(baseDir, { recursive: true, force: true });
  }
});

// ─── DIRTY without label → skip ──────────────────────────────────

test("reconcileQueueHealth skips DIRTY PR without queue label", { concurrency: false }, async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "qhm-dirty-no-label-"));
  let oldPath: string | undefined;
  try {
    const ghScript = `
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  printf '{"state":"OPEN","mergeable":"CONFLICTING","mergeStateStatus":"DIRTY","headRefOid":"deadbeef","labels":[]}'
  exit 0
fi
exit 1`;
    const harness = createTestHarness(baseDir, ghScript);
    oldPath = harness.oldPath;
    insertQueuedIssue(harness.db);

    await harness.reconcileQueueHealth();

    const issue = harness.db.getIssue("proj", "issue-1");
    assert.equal(issue?.factoryState, "awaiting_queue");
    assert.equal(issue?.pendingRunType, undefined);
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
    assert.equal(issue?.factoryState, "awaiting_queue");
    assert.equal(issue?.pendingRunType, undefined);
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
    assert.equal(after1?.factoryState, "repairing_queue");
    assert.equal(after1?.pendingRunType, "queue_repair");

    // Reset state to awaiting_queue to simulate the issue coming back
    // (e.g. repair completed but conflict remains with same head)
    harness.db.upsertIssue({
      projectId: "proj",
      linearIssueId: "issue-1",
      factoryState: "awaiting_queue",
      pendingRunType: null,
      pendingRunContextJson: null,
      activeRunId: null,
    });
    const oldDate = new Date(Date.now() - 300_000).toISOString();
    harness.db["connection"]
      .prepare("UPDATE issues SET updated_at = ? WHERE linear_issue_id = ?")
      .run(oldDate, "issue-1");

    harness.enqueueCalls.length = 0;

    // Second call — should be deduplicated (same headRefOid)
    await harness.reconcileQueueHealth();
    const after2 = harness.db.getIssue("proj", "issue-1");
    assert.equal(after2?.factoryState, "awaiting_queue");
    assert.equal(after2?.pendingRunType, undefined);
    assert.deepEqual(harness.enqueueCalls, []);
  } finally {
    process.env.PATH = oldPath;
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
    assert.equal(issue?.factoryState, "awaiting_queue");
    assert.equal(issue?.pendingRunType, undefined);
  } finally {
    process.env.PATH = oldPath;
    rmSync(baseDir, { recursive: true, force: true });
  }
});
