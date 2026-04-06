import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { PatchRelayDatabase } from "../src/db.ts";
import { SqliteConnection } from "../src/db/shared.ts";
import { runPatchRelayMigrations } from "../src/db/migrations.ts";

test("migrations create issue_sessions and upgrade legacy issue schema", () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-session-migration-"));
  try {
    const dbPath = path.join(baseDir, "legacy.sqlite");
    const connection = new SqliteConnection(dbPath);
    connection.exec(`
      CREATE TABLE issues (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL,
        linear_issue_id TEXT NOT NULL,
        issue_key TEXT,
        title TEXT,
        url TEXT,
        current_linear_state TEXT,
        current_linear_state_type TEXT,
        factory_state TEXT NOT NULL DEFAULT 'delegated',
        pending_run_type TEXT,
        pending_run_context_json TEXT,
        branch_name TEXT,
        branch_owner TEXT NOT NULL DEFAULT 'patchrelay',
        branch_ownership_changed_at TEXT,
        worktree_path TEXT,
        thread_id TEXT,
        active_run_id INTEGER,
        agent_session_id TEXT,
        pr_number INTEGER,
        pr_url TEXT,
        pr_state TEXT,
        pr_review_state TEXT,
        pr_check_status TEXT,
        ci_repair_attempts INTEGER NOT NULL DEFAULT 0,
        queue_repair_attempts INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        UNIQUE(project_id, linear_issue_id)
      );
    `);

    runPatchRelayMigrations(connection);

    const issueColumns = connection.prepare("PRAGMA table_info(issues)").all() as Array<Record<string, unknown>>;
    assert.ok(issueColumns.some((column) => column.name === "pr_head_sha"));
    assert.ok(issueColumns.some((column) => column.name === "pr_author_login"));
    assert.ok(!issueColumns.some((column) => column.name === "queue_label_applied"));
    assert.ok(!issueColumns.some((column) => column.name === "pending_merge_prep"));
    assert.ok(!issueColumns.some((column) => column.name === "merge_prep_attempts"));

    const sessionColumns = connection.prepare("PRAGMA table_info(issue_sessions)").all() as Array<Record<string, unknown>>;
    assert.ok(sessionColumns.some((column) => column.name === "session_state"));
    assert.ok(sessionColumns.some((column) => column.name === "lease_id"));
    assert.ok(sessionColumns.some((column) => column.name === "thread_generation"));
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("issue upserts and run completion dual-write into issue_sessions", () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-session-dual-write-"));
  try {
    const db = new PatchRelayDatabase(path.join(baseDir, "patchrelay.sqlite"), true);
    db.runMigrations();

    const issue = db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-1",
      issueKey: "USE-1",
      title: "Implement sessions",
      factoryState: "delegated",
      pendingRunType: "implementation",
      branchName: "use/USE-1-implement-sessions",
      worktreePath: "/tmp/use-1",
      threadId: "thread-1",
    });
    const queuedSession = db.getIssueSession("usertold", "issue-1");
    assert.equal(queuedSession?.sessionState, "idle");
    assert.equal(queuedSession?.waitingReason, "Ready to run implementation");
    assert.equal(queuedSession?.threadGeneration, 1);

    const run = db.createRun({
      issueId: issue.id,
      projectId: "usertold",
      linearIssueId: "issue-1",
      runType: "implementation",
      promptText: "Ship it",
    });
    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-1",
      activeRunId: run.id,
      pendingRunType: null,
      factoryState: "implementing",
    });
    const runningSession = db.getIssueSession("usertold", "issue-1");
    assert.equal(runningSession?.sessionState, "running");
    assert.equal(runningSession?.activeRunId, run.id);

    db.finishRun(run.id, {
      status: "completed",
      summaryJson: JSON.stringify({ latestAssistantMessage: "Implementation finished cleanly." }),
    });
    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-1",
      activeRunId: null,
      factoryState: "awaiting_queue",
      prNumber: 10,
      prHeadSha: "sha-1",
      prAuthorLogin: "patchrelay[bot]",
    });
    const completedSession = db.getIssueSession("usertold", "issue-1");
    assert.equal(completedSession?.sessionState, "idle");
    assert.equal(completedSession?.summaryText, "Implementation finished cleanly.");
    assert.equal(completedSession?.lastRunType, "implementation");
    assert.equal(completedSession?.prAuthorLogin, "patchrelay[bot]");
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("issue session keeps the last published summary when a later stale repair fails", () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-session-summary-fallback-"));
  try {
    const db = new PatchRelayDatabase(path.join(baseDir, "patchrelay.sqlite"), true);
    db.runMigrations();

    const issue = db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-summary",
      issueKey: "USE-SUMMARY",
      factoryState: "delegated",
      pendingRunType: "implementation",
      branchName: "use/USE-SUMMARY",
    });

    const implementationRun = db.createRun({
      issueId: issue.id,
      projectId: "usertold",
      linearIssueId: "issue-summary",
      runType: "implementation",
      promptText: "Ship it",
    });
    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-summary",
      activeRunId: implementationRun.id,
      pendingRunType: null,
      factoryState: "implementing",
    });
    db.finishRun(implementationRun.id, {
      status: "completed",
      summaryJson: JSON.stringify({ latestAssistantMessage: "Published PR #42 with the seeded word-pack library." }),
    });
    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-summary",
      activeRunId: null,
      factoryState: "pr_open",
      prNumber: 42,
      prHeadSha: "sha-42",
      prAuthorLogin: "patchrelay[bot]",
    });

    const staleRepair = db.createRun({
      issueId: issue.id,
      projectId: "usertold",
      linearIssueId: "issue-summary",
      runType: "queue_repair",
      promptText: "Repair queue incident",
    });
    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-summary",
      activeRunId: staleRepair.id,
      factoryState: "repairing_queue",
    });
    db.finishRun(staleRepair.id, {
      status: "failed",
      failureReason: "Codex turn was interrupted",
    });
    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-summary",
      activeRunId: null,
      factoryState: "pr_open",
      prCheckStatus: "success",
      prReviewState: null,
    });

    const session = db.getIssueSession("usertold", "issue-summary");
    assert.equal(session?.summaryText, "Published PR #42 with the seeded word-pack library.");
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("issue session leases can be acquired, renewed, and reclaimed after expiry", () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-session-lease-"));
  try {
    const db = new PatchRelayDatabase(path.join(baseDir, "patchrelay.sqlite"), true);
    db.runMigrations();
    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-lease",
      issueKey: "USE-LEASE",
      factoryState: "delegated",
    });

    assert.equal(
      db.acquireIssueSessionLease({
        projectId: "usertold",
        linearIssueId: "issue-lease",
        leaseId: "lease-1",
        workerId: "worker-a",
        leasedUntil: "2026-04-05T10:05:00.000Z",
        now: "2026-04-05T10:00:00.000Z",
      }),
      true,
    );
    assert.equal(
      db.acquireIssueSessionLease({
        projectId: "usertold",
        linearIssueId: "issue-lease",
        leaseId: "lease-2",
        workerId: "worker-b",
        leasedUntil: "2026-04-05T10:06:00.000Z",
        now: "2026-04-05T10:01:00.000Z",
      }),
      false,
    );
    assert.equal(
      db.renewIssueSessionLease({
        projectId: "usertold",
        linearIssueId: "issue-lease",
        leaseId: "lease-1",
        leasedUntil: "2026-04-05T10:07:00.000Z",
        now: "2026-04-05T10:02:00.000Z",
      }),
      true,
    );
    assert.equal(
      db.acquireIssueSessionLease({
        projectId: "usertold",
        linearIssueId: "issue-lease",
        leaseId: "lease-3",
        workerId: "worker-c",
        leasedUntil: "2026-04-05T10:11:00.000Z",
        now: "2026-04-05T10:08:00.000Z",
      }),
      true,
    );
    const session = db.getIssueSession("usertold", "issue-lease");
    assert.equal(session?.leaseId, "lease-3");
    assert.equal(session?.workerId, "worker-c");
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("lease-guarded writes reject stale issue-session leases", () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-session-lease-guards-"));
  try {
    const db = new PatchRelayDatabase(path.join(baseDir, "patchrelay.sqlite"), true);
    db.runMigrations();
    const issue = db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-lease-guards",
      issueKey: "USE-LEASE-GUARDS",
      factoryState: "delegated",
      branchName: "use/USE-LEASE-GUARDS",
    });

    const run = db.createRun({
      issueId: issue.id,
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      runType: "implementation",
      promptText: "Ship it",
    });

    assert.equal(
      db.acquireIssueSessionLease({
        projectId: issue.projectId,
        linearIssueId: issue.linearIssueId,
        leaseId: "lease-1",
        workerId: "worker-a",
        leasedUntil: "2030-04-05T10:05:00.000Z",
        now: "2030-04-05T10:00:00.000Z",
      }),
      true,
    );
    assert.equal(
      db.acquireIssueSessionLease({
        projectId: issue.projectId,
        linearIssueId: issue.linearIssueId,
        leaseId: "lease-2",
        workerId: "worker-b",
        leasedUntil: "2030-04-05T10:10:00.000Z",
        now: "2030-04-05T10:06:00.000Z",
      }),
      true,
    );

    const staleIssueWrite = db.upsertIssueWithLease(
      { projectId: issue.projectId, linearIssueId: issue.linearIssueId, leaseId: "lease-1" },
      {
        projectId: issue.projectId,
        linearIssueId: issue.linearIssueId,
        factoryState: "implementing",
      },
    );
    assert.equal(staleIssueWrite, undefined);
    assert.equal(db.getIssue(issue.projectId, issue.linearIssueId)?.factoryState, "delegated");

    const staleRunFinish = db.finishRunWithLease(
      { projectId: issue.projectId, linearIssueId: issue.linearIssueId, leaseId: "lease-1" },
      run.id,
      { status: "failed", failureReason: "stale worker" },
    );
    assert.equal(staleRunFinish, false);
    assert.equal(db.getRun(run.id)?.status, "queued");

    const freshIssueWrite = db.upsertIssueWithLease(
      { projectId: issue.projectId, linearIssueId: issue.linearIssueId, leaseId: "lease-2" },
      {
        projectId: issue.projectId,
        linearIssueId: issue.linearIssueId,
        factoryState: "implementing",
        activeRunId: run.id,
      },
    );
    assert.equal(freshIssueWrite?.factoryState, "implementing");

    const freshRunFinish = db.finishRunWithLease(
      { projectId: issue.projectId, linearIssueId: issue.linearIssueId, leaseId: "lease-2" },
      run.id,
      { status: "completed", summaryJson: JSON.stringify({ latestAssistantMessage: "Done" }) },
    );
    assert.equal(freshRunFinish, true);
    assert.equal(db.getRun(run.id)?.status, "completed");
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("startup lease cleanup expires only stale issue-session leases", () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-session-expire-leases-"));
  try {
    const db = new PatchRelayDatabase(path.join(baseDir, "patchrelay.sqlite"), true);
    db.runMigrations();
    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-stale-lease",
      issueKey: "USE-LEASE-EXPIRE",
      factoryState: "delegated",
    });

    assert.equal(
      db.acquireIssueSessionLease({
        projectId: "usertold",
        linearIssueId: "issue-stale-lease",
        leaseId: "lease-stale",
        workerId: "worker-a",
        leasedUntil: "2030-04-05T10:00:00.000Z",
        now: "2030-04-05T09:00:00.000Z",
      }),
      true,
    );

    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-fresh-lease",
      issueKey: "USE-LEASE-FRESH",
      factoryState: "delegated",
    });
    assert.equal(
      db.acquireIssueSessionLease({
        projectId: "usertold",
        linearIssueId: "issue-fresh-lease",
        leaseId: "lease-fresh",
        workerId: "worker-b",
        leasedUntil: "2030-04-05T12:00:00.000Z",
        now: "2030-04-05T09:00:00.000Z",
      }),
      true,
    );

    db.releaseExpiredIssueSessionLeases("2030-04-05T10:30:00.000Z");

    assert.equal(db.getIssueSession("usertold", "issue-stale-lease")?.leaseId, undefined);
    assert.equal(db.getIssueSession("usertold", "issue-fresh-lease")?.leaseId, "lease-fresh");
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("issue session wake derives follow-up mode and thread reuse from queued events", () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-session-events-"));
  try {
    const db = new PatchRelayDatabase(path.join(baseDir, "patchrelay.sqlite"), true);
    db.runMigrations();
    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-followup",
      issueKey: "USE-14",
      factoryState: "pr_open",
      prNumber: 14,
      threadId: "thread-followup",
      prReviewState: "approved",
    });
    db.appendIssueSessionEvent({
      projectId: "usertold",
      linearIssueId: "issue-followup",
      eventType: "followup_prompt",
      eventJson: JSON.stringify({ text: "Please split the parser into smaller functions.", author: "alice" }),
    });
    db.appendIssueSessionEvent({
      projectId: "usertold",
      linearIssueId: "issue-followup",
      eventType: "followup_comment",
      eventJson: JSON.stringify({ body: "And keep the API stable.", author: "bob" }),
    });

    const wake = db.peekIssueSessionWake("usertold", "issue-followup");
    assert.equal(wake?.runType, "implementation");
    assert.equal(wake?.resumeThread, true);
    assert.equal(wake?.wakeReason, "followup_prompt");
    assert.equal(Array.isArray(wake?.context.followUps), true);
    assert.equal(wake?.context.followUpMode, true);
    assert.equal(wake?.eventIds.length, 2);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("followup_comment alone reuses the main thread for the next turn", () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-session-comment-followup-"));
  try {
    const db = new PatchRelayDatabase(path.join(baseDir, "patchrelay.sqlite"), true);
    db.runMigrations();
    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-comment-followup",
      issueKey: "USE-16",
      factoryState: "pr_open",
      prNumber: 16,
      threadId: "thread-comment-followup",
      prReviewState: "approved",
    });
    db.appendIssueSessionEvent({
      projectId: "usertold",
      linearIssueId: "issue-comment-followup",
      eventType: "followup_comment",
      eventJson: JSON.stringify({ body: "Please keep the current copy.", author: "alice" }),
    });

    const wake = db.peekIssueSessionWake("usertold", "issue-comment-followup");
    assert.equal(wake?.runType, "implementation");
    assert.equal(wake?.resumeThread, true);
    assert.equal(wake?.wakeReason, "followup_comment");
    assert.equal(wake?.context.followUpMode, true);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("terminal session events suppress queued follow-up wakeups", () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-session-terminal-events-"));
  try {
    const db = new PatchRelayDatabase(path.join(baseDir, "patchrelay.sqlite"), true);
    db.runMigrations();
    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-terminal",
      issueKey: "USE-15",
      factoryState: "pr_open",
      prNumber: 15,
      threadId: "thread-terminal",
    });
    db.appendIssueSessionEvent({
      projectId: "usertold",
      linearIssueId: "issue-terminal",
      eventType: "followup_comment",
      eventJson: JSON.stringify({ body: "Please adjust the copy." }),
    });
    db.appendIssueSessionEvent({
      projectId: "usertold",
      linearIssueId: "issue-terminal",
      eventType: "pr_merged",
      dedupeKey: "pr_merged:15",
    });

    const wake = db.peekIssueSessionWake("usertold", "issue-terminal");
    assert.equal(wake, undefined);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("updateRunThread does not resurrect a run that already ended", () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-session-ended-run-"));
  try {
    const db = new PatchRelayDatabase(path.join(baseDir, "patchrelay.sqlite"), true);
    db.runMigrations();
    const issue = db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-ended-run",
      issueKey: "USE-15",
      factoryState: "delegated",
      pendingRunType: "implementation",
    });
    const run = db.createRun({
      issueId: issue.id,
      projectId: "usertold",
      linearIssueId: "issue-ended-run",
      runType: "implementation",
    });
    db.finishRun(run.id, { status: "failed", failureReason: "zombie" });

    db.updateRunThread(run.id, {
      threadId: "thread-after-end",
      turnId: "turn-after-end",
    });

    const finished = db.getRun(run.id);
    assert.equal(finished?.status, "failed");
    assert.equal(finished?.threadId, undefined);
    assert.equal(finished?.turnId, undefined);
    assert.equal(finished?.failureReason, "zombie");
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});
