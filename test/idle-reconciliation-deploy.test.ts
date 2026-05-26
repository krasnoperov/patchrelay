import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import test from "node:test";
import { PatchRelayDatabase } from "../src/db.ts";
import { IdleIssueReconciler } from "../src/idle-reconciliation.ts";
import { WakeDispatcher } from "../src/wake-dispatcher.ts";
import type { AppConfig } from "../src/config-types.ts";
import type { DeployOutcome } from "../src/post-merge-deploy.ts";
import type { IssueRecord } from "../src/db-types.ts";

function createDb() {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-deploy-reconcile-"));
  const db = new PatchRelayDatabase(path.join(baseDir, "patchrelay.sqlite"), true);
  db.runMigrations();
  return { baseDir, db };
}

function makeConfig(deployWorkflowName?: string): AppConfig {
  return {
    projects: [{
      id: "usertold",
      repoPath: "/tmp/usertold",
      reviewChecks: [],
      gateChecks: [],
      github: {
        repoFullName: "krasnoperov/usertold",
        baseBranch: "main",
        ...(deployWorkflowName ? { deployWorkflowName } : {}),
      },
    }],
  } as unknown as AppConfig;
}

function build(
  db: PatchRelayDatabase,
  config: AppConfig,
  outcome: DeployOutcome,
  syncIssue?: (issue: IssueRecord) => void | Promise<void>,
) {
  const logger = pino({ enabled: false });
  const wake = new WakeDispatcher(db, () => undefined, () => undefined, logger);
  const reconciler = new IdleIssueReconciler(db, config, wake, logger, undefined, async () => outcome, syncIssue);
  return reconciler;
}

function mergedIssue(db: PatchRelayDatabase, overrides: Record<string, unknown> = {}) {
  return db.upsertIssue({
    projectId: "usertold",
    linearIssueId: "issue-1",
    issueKey: "USE-1",
    delegatedToPatchRelay: true,
    factoryState: "awaiting_queue",
    prNumber: 42,
    prState: "merged",
    prReviewState: "approved",
    ...overrides,
  });
}

test("a merged PR with a deploy workflow enters the deploying watch state", async () => {
  const { baseDir, db } = createDb();
  try {
    mergedIssue(db);
    await build(db, makeConfig("Deploy"), "pending").reconcile();
    const issue = db.getIssue("usertold", "issue-1")!;
    assert.equal(issue.factoryState, "deploying");
    assert.ok(issue.deployStartedAt, "deployStartedAt is stamped");
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("idle reconciliation syncs the updated issue to Linear after a state advance", async () => {
  const { baseDir, db } = createDb();
  try {
    const issue = db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-1",
      issueKey: "USE-1",
      delegatedToPatchRelay: true,
      factoryState: "pr_open",
      prNumber: 42,
      prReviewState: "approved",
    });
    const synced: IssueRecord[] = [];
    build(db, makeConfig(), "pending", (syncedIssue) => {
      synced.push(syncedIssue);
    }).advanceIdleIssue(issue, "awaiting_queue", { clearFailureProvenance: true });

    assert.equal(synced.length, 1);
    assert.equal(synced[0]!.factoryState, "awaiting_queue");
    assert.equal(synced[0]!.linearIssueId, "issue-1");
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("a merged PR with no deploy workflow goes straight to done", async () => {
  const { baseDir, db } = createDb();
  try {
    mergedIssue(db);
    await build(db, makeConfig(), "pending").reconcile();
    assert.equal(db.getIssue("usertold", "issue-1")!.factoryState, "done");
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("a deploying issue advances to done when the deploy succeeds", async () => {
  const { baseDir, db } = createDb();
  try {
    mergedIssue(db, { factoryState: "deploying", deployStartedAt: new Date().toISOString() });
    await build(db, makeConfig("Deploy"), "succeeded").reconcile();
    const issue = db.getIssue("usertold", "issue-1")!;
    assert.equal(issue.factoryState, "done");
    assert.equal(issue.deployStartedAt, undefined, "deployStartedAt cleared");
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("a deploying issue escalates when the deploy fails", async () => {
  const { baseDir, db } = createDb();
  try {
    mergedIssue(db, { factoryState: "deploying", deployStartedAt: new Date().toISOString() });
    await build(db, makeConfig("Deploy"), "failed").reconcile();
    assert.equal(db.getIssue("usertold", "issue-1")!.factoryState, "escalated");
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("a deploying issue stays deploying while the deploy is still pending", async () => {
  const { baseDir, db } = createDb();
  try {
    mergedIssue(db, { factoryState: "deploying", deployStartedAt: new Date().toISOString() });
    await build(db, makeConfig("Deploy"), "pending").reconcile();
    assert.equal(db.getIssue("usertold", "issue-1")!.factoryState, "deploying");
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("a deploying issue times out to done when no deploy is observed", async () => {
  const { baseDir, db } = createDb();
  try {
    // Stamped 30 minutes ago — past the 20-minute watch timeout.
    const old = new Date(Date.now() - 30 * 60_000).toISOString();
    mergedIssue(db, { factoryState: "deploying", deployStartedAt: old });
    await build(db, makeConfig("Deploy"), "pending").reconcile();
    assert.equal(db.getIssue("usertold", "issue-1")!.factoryState, "done");
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});
