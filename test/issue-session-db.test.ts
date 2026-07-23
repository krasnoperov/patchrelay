import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { PatchRelayDatabase } from "../src/db.ts";
import { SqliteConnection } from "../src/db/shared.ts";
import { runPatchRelayMigrations } from "../src/db/migrations.ts";
import { deriveReactiveWorkflowIntent } from "../src/reactive-workflow-intent.ts";
import { buildRequestedChangesWorkflowIdentity } from "../src/reactive-workflow-keys.ts";

test("migrations create issue_sessions and upgrade legacy issue schema", () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-session-migration-"));
  try {
    const dbPath = path.join(baseDir, "legacy.sqlite");
    const connection = new SqliteConnection(dbPath);
    const legacyRunColumn = ["pending", "run", "type"].join("_");
    const legacyContextColumn = ["pending", "run", "context", "json"].join("_");
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
        workflow_outcome TEXT,
        ${legacyRunColumn} TEXT,
        ${legacyContextColumn} TEXT,
        branch_name TEXT,
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
    assert.ok(issueColumns.some((column) => column.name === "parent_linear_issue_id"));
    assert.ok(issueColumns.some((column) => column.name === "parent_issue_key"));
    assert.ok(issueColumns.some((column) => column.name === "orchestration_settle_until"));
    assert.ok(!issueColumns.some((column) => column.name === "queue_label_applied"));
    assert.ok(!issueColumns.some((column) => column.name === "pending_merge_prep"));
    assert.ok(!issueColumns.some((column) => column.name === "merge_prep_attempts"));
    assert.ok(!issueColumns.some((column) => column.name === "branch_owner"));
    assert.ok(!issueColumns.some((column) => column.name === "branch_ownership_changed_at"));
    assert.ok(!issueColumns.some((column) => column.name === legacyRunColumn));
    assert.ok(!issueColumns.some((column) => column.name === legacyContextColumn));

    const sessionColumns = connection.prepare("PRAGMA table_info(issue_sessions)").all() as Array<Record<string, unknown>>;
    assert.ok(!sessionColumns.some((column) => column.name === "session_state"));
    assert.ok(!sessionColumns.some((column) => column.name === "waiting_reason"));
    for (const retiredColumn of [
      "active_thread_id",
      "thread_generation",
      "lease_id",
      "worker_id",
      "leased_until",
      "last_wake_reason",
    ]) {
      assert.ok(!sessionColumns.some((column) => column.name === retiredColumn));
    }
    const leaseColumns = connection.prepare("PRAGMA table_info(issue_session_leases)").all() as Array<Record<string, unknown>>;
    assert.ok(leaseColumns.some((column) => column.name === "lease_id"));
    const threadColumns = connection.prepare("PRAGMA table_info(issue_session_threads)").all() as Array<Record<string, unknown>>;
    assert.ok(threadColumns.some((column) => column.name === "thread_generation"));
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("migrations delete PatchRelay's retired Codex transcript copies", () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-run-history-migration-"));
  try {
    const connection = new SqliteConnection(path.join(baseDir, "legacy.sqlite"));
    runPatchRelayMigrations(connection);
    connection.exec("ALTER TABLE runs ADD COLUMN report_json TEXT");
    connection.exec("CREATE TABLE run_thread_events (id INTEGER PRIMARY KEY, event_json TEXT NOT NULL)");

    runPatchRelayMigrations(connection);

    const runColumns = connection.prepare("PRAGMA table_info(runs)").all() as Array<Record<string, unknown>>;
    assert.ok(!runColumns.some((column) => column.name === "report_json"));
    assert.ok(runColumns.some((column) => column.name === "last_codex_activity_at"));
    const retiredTable = connection.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'run_thread_events'").get();
    assert.equal(retiredTable, undefined);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("migrations drop retired session lifecycle columns without losing operational metadata", () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-session-lifecycle-migration-"));
  try {
    const connection = new SqliteConnection(path.join(baseDir, "legacy.sqlite"));
    runPatchRelayMigrations(connection);
    connection.exec("ALTER TABLE issue_sessions ADD COLUMN session_state TEXT NOT NULL DEFAULT 'idle'");
    connection.exec("ALTER TABLE issue_sessions ADD COLUMN waiting_reason TEXT");
    connection.exec("ALTER TABLE issue_sessions ADD COLUMN last_wake_reason TEXT");
    connection.exec("ALTER TABLE issue_sessions ADD COLUMN active_thread_id TEXT");
    connection.exec("ALTER TABLE issue_sessions ADD COLUMN thread_generation INTEGER NOT NULL DEFAULT 0");
    connection.exec("ALTER TABLE issue_sessions ADD COLUMN lease_id TEXT");
    connection.exec("ALTER TABLE issue_sessions ADD COLUMN worker_id TEXT");
    connection.exec("ALTER TABLE issue_sessions ADD COLUMN leased_until TEXT");
    connection.prepare(`
      INSERT INTO issue_sessions (
        project_id, linear_issue_id, issue_key, repo_id, summary_text,
        created_at, display_updated_at, updated_at, session_state, waiting_reason,
        last_wake_reason, active_thread_id, thread_generation,
        lease_id, worker_id, leased_until
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "usertold",
      "issue-1",
      "USE-1",
      "usertold",
      "Compact operator summary",
      "2026-07-23T00:00:00.000Z",
      "2026-07-23T00:00:00.000Z",
      "2026-07-23T00:00:00.000Z",
      "waiting_input",
      "Stale compatibility text",
      "run:review_fix",
      "thread-legacy",
      4,
      "lease-legacy",
      "worker-legacy",
      "2026-07-23T01:00:00.000Z",
    );
    connection.prepare(`
      INSERT INTO issue_sessions (
        project_id, linear_issue_id, issue_key, repo_id, summary_text,
        created_at, display_updated_at, updated_at, session_state, waiting_reason,
        last_wake_reason, active_thread_id, thread_generation,
        lease_id, worker_id, leased_until
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "usertold",
      "issue-2",
      "USE-2",
      "usertold",
      "Mixed-version operator summary",
      "2026-07-23T00:00:00.000Z",
      "2026-07-23T00:00:00.000Z",
      "2026-07-23T00:00:00.000Z",
      "running",
      null,
      "run:implementation",
      "thread-stale",
      2,
      "lease-stale",
      "worker-stale",
      "2020-01-01T00:00:00.000Z",
    );
    connection.prepare(`
      INSERT INTO issue_session_threads (
        project_id, linear_issue_id, active_thread_id, thread_generation, updated_at
      ) VALUES (?, ?, ?, ?, ?)
    `).run(
      "usertold",
      "issue-2",
      "thread-current",
      9,
      "2026-07-23T00:30:00.000Z",
    );
    connection.prepare(`
      INSERT INTO issue_session_leases (
        project_id, linear_issue_id, lease_id, worker_id, leased_until, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      "usertold",
      "issue-2",
      "lease-current",
      "worker-current",
      "2027-01-01T00:00:00.000Z",
      "2026-07-23T00:30:00.000Z",
    );

    runPatchRelayMigrations(connection);
    runPatchRelayMigrations(connection);

    const columns = connection.prepare("PRAGMA table_info(issue_sessions)").all() as Array<Record<string, unknown>>;
    for (const retiredColumn of [
      "session_state",
      "waiting_reason",
      "last_wake_reason",
      "active_thread_id",
      "thread_generation",
      "lease_id",
      "worker_id",
      "leased_until",
    ]) {
      assert.equal(columns.some((column) => column.name === retiredColumn), false);
    }
    const row = connection.prepare(`
      SELECT issue_key, summary_text, last_workflow_reason
      FROM issue_sessions
      WHERE project_id = ? AND linear_issue_id = ?
    `).get("usertold", "issue-1") as Record<string, unknown>;
    assert.equal(row.issue_key, "USE-1");
    assert.equal(row.summary_text, "Compact operator summary");
    assert.equal(row.last_workflow_reason, "run:review_fix");
    const thread = connection.prepare(`
      SELECT active_thread_id, thread_generation
      FROM issue_session_threads
      WHERE project_id = ? AND linear_issue_id = ?
    `).get("usertold", "issue-1") as Record<string, unknown>;
    assert.equal(thread.active_thread_id, "thread-legacy");
    assert.equal(thread.thread_generation, 4);
    const lease = connection.prepare(`
      SELECT lease_id, worker_id, leased_until
      FROM issue_session_leases
      WHERE project_id = ? AND linear_issue_id = ?
    `).get("usertold", "issue-1") as Record<string, unknown>;
    assert.equal(lease.lease_id, "lease-legacy");
    assert.equal(lease.worker_id, "worker-legacy");
    assert.equal(lease.leased_until, "2026-07-23T01:00:00.000Z");
    const currentThread = connection.prepare(`
      SELECT active_thread_id, thread_generation
      FROM issue_session_threads
      WHERE project_id = ? AND linear_issue_id = ?
    `).get("usertold", "issue-2") as Record<string, unknown>;
    assert.equal(currentThread.active_thread_id, "thread-current");
    assert.equal(currentThread.thread_generation, 9);
    const currentLease = connection.prepare(`
      SELECT lease_id, worker_id, leased_until
      FROM issue_session_leases
      WHERE project_id = ? AND linear_issue_id = ?
    `).get("usertold", "issue-2") as Record<string, unknown>;
    assert.equal(currentLease.lease_id, "lease-current");
    assert.equal(currentLease.worker_id, "worker-current");
    assert.equal(currentLease.leased_until, "2027-01-01T00:00:00.000Z");
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("issue sessions retain operational pointers and summaries without lifecycle state", () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-session-dual-write-"));
  try {
    const db = new PatchRelayDatabase(path.join(baseDir, "patchrelay.sqlite"), true);
    db.runMigrations();

    const issue = db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-1",
      issueKey: "USE-1",
      title: "Implement sessions",
      workflowOutcome: undefined,
      branchName: "use/USE-1-implement-sessions",
      worktreePath: "/tmp/use-1",
      threadId: "thread-1",
    });
    db.workflowTasks.reconcileTasks({
      projectId: "usertold",
      subjectId: "issue-1",
      tasks: [{
        task: { id: "run:implementation", type: "run", runType: "implementation", reason: "delegated" },
        authorityEpoch: 0,
        gateAction: "start",
      }],
    });
    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-1",
      workflowOutcome: undefined,
    });
    const queuedSession = db.issueSessions.getIssueSession("usertold", "issue-1");
    assert.equal(queuedSession?.threadGeneration, 1);

    const run = db.runs.createRun({
      issueId: issue.id,
      projectId: "usertold",
      linearIssueId: "issue-1",
      runType: "implementation",
      promptText: "Ship it",
    });
    assert.equal(db.runs.getRunById(run.id)?.launchPhase, "claimed");
    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-1",
      activeRunId: run.id,
      workflowOutcome: undefined,
    });
    db.runs.updateRunThread(run.id, { threadId: "thread-2", turnId: "turn-1" });
    assert.equal(db.runs.getRunById(run.id)?.launchPhase, "running");
    const runningSession = db.issueSessions.getIssueSession("usertold", "issue-1");
    assert.equal(runningSession?.activeRunId, run.id);

    db.runs.finishRun(run.id, {
      status: "completed",
      summaryJson: JSON.stringify({ latestAssistantMessage: "Implementation finished cleanly." }),
    });
    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-1",
      activeRunId: null,
      workflowOutcome: undefined,
      prNumber: 10,
      prHeadSha: "sha-1",
      prAuthorLogin: "patchrelay[bot]",
    });
    const completedSession = db.issueSessions.getIssueSession("usertold", "issue-1");
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
      workflowOutcome: undefined,
      branchName: "use/USE-SUMMARY",
    });

    const implementationRun = db.runs.createRun({
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
      workflowOutcome: undefined,
    });
    db.runs.finishRun(implementationRun.id, {
      status: "completed",
      summaryJson: JSON.stringify({ latestAssistantMessage: "Published PR #42 with the seeded word-pack library." }),
    });
    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-summary",
      activeRunId: null,
      workflowOutcome: undefined,
      prNumber: 42,
      prHeadSha: "sha-42",
      prAuthorLogin: "patchrelay[bot]",
    });

    const staleRepair = db.runs.createRun({
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
      workflowOutcome: undefined,
    });
    db.runs.finishRun(staleRepair.id, {
      status: "failed",
      failureReason: "Codex turn was interrupted",
    });
    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-summary",
      activeRunId: null,
      workflowOutcome: undefined,
      prCheckStatus: "success",
      prReviewState: null,
    });

    const session = db.issueSessions.getIssueSession("usertold", "issue-summary");
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
      workflowOutcome: undefined,
    });

    assert.equal(
      db.issueSessions.acquireIssueSessionLease({
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
      db.issueSessions.acquireIssueSessionLease({
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
      db.issueSessions.renewIssueSessionLease({
        projectId: "usertold",
        linearIssueId: "issue-lease",
        leaseId: "lease-1",
        leasedUntil: "2026-04-05T10:07:00.000Z",
        now: "2026-04-05T10:02:00.000Z",
      }),
      true,
    );
    assert.equal(
      db.issueSessions.acquireIssueSessionLease({
        projectId: "usertold",
        linearIssueId: "issue-lease",
        leaseId: "lease-3",
        workerId: "worker-c",
        leasedUntil: "2026-04-05T10:11:00.000Z",
        now: "2026-04-05T10:08:00.000Z",
      }),
      true,
    );
    const session = db.issueSessions.getIssueSession("usertold", "issue-lease");
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
      workflowOutcome: undefined,
      branchName: "use/USE-LEASE-GUARDS",
    });

    const run = db.runs.createRun({
      issueId: issue.id,
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      runType: "implementation",
      promptText: "Ship it",
    });

    assert.equal(
      db.issueSessions.acquireIssueSessionLease({
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
      db.issueSessions.acquireIssueSessionLease({
        projectId: issue.projectId,
        linearIssueId: issue.linearIssueId,
        leaseId: "lease-2",
        workerId: "worker-b",
        leasedUntil: "2030-04-05T10:10:00.000Z",
        now: "2030-04-05T10:06:00.000Z",
      }),
      true,
    );

    const staleIssueWrite = db.issueSessions.commitIssueState({
      writer: "test",
      lease: { projectId: issue.projectId, linearIssueId: issue.linearIssueId, leaseId: "lease-1" },
      update: {
        projectId: issue.projectId,
        linearIssueId: issue.linearIssueId,
        workflowOutcome: undefined,
      },
    });
    assert.equal(staleIssueWrite.outcome, "lease_denied");
    assert.equal(db.getIssue(issue.projectId, issue.linearIssueId)?.workflowOutcome, undefined);

    const staleRunFinish = db.issueSessions.finishRunWithLease(
      { projectId: issue.projectId, linearIssueId: issue.linearIssueId, leaseId: "lease-1" },
      run.id,
      { status: "failed", failureReason: "stale worker" },
    );
    assert.equal(staleRunFinish, false);
    assert.equal(db.runs.getRunById(run.id)?.status, "queued");

    const freshIssueWrite = db.issueSessions.commitIssueState({
      writer: "test",
      lease: { projectId: issue.projectId, linearIssueId: issue.linearIssueId, leaseId: "lease-2" },
      update: {
        projectId: issue.projectId,
        linearIssueId: issue.linearIssueId,
        workflowOutcome: undefined,
        activeRunId: run.id,
      },
    });
    assert.equal(freshIssueWrite.outcome, "applied");
    assert.equal(freshIssueWrite.outcome === "applied" ? freshIssueWrite.issue.activeRunId : undefined, run.id);

    const freshRunFinish = db.issueSessions.finishRunWithLease(
      { projectId: issue.projectId, linearIssueId: issue.linearIssueId, leaseId: "lease-2" },
      run.id,
      { status: "completed", summaryJson: JSON.stringify({ latestAssistantMessage: "Done" }) },
    );
    assert.equal(freshRunFinish, true);
    assert.equal(db.runs.getRunById(run.id)?.status, "completed");
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
      workflowOutcome: undefined,
    });

    assert.equal(
      db.issueSessions.acquireIssueSessionLease({
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
      workflowOutcome: undefined,
    });
    assert.equal(
      db.issueSessions.acquireIssueSessionLease({
        projectId: "usertold",
        linearIssueId: "issue-fresh-lease",
        leaseId: "lease-fresh",
        workerId: "worker-b",
        leasedUntil: "2030-04-05T12:00:00.000Z",
        now: "2030-04-05T09:00:00.000Z",
      }),
      true,
    );

    db.issueSessions.releaseExpiredIssueSessionLeases("2030-04-05T10:30:00.000Z");

    assert.equal(db.issueSessions.getIssueSession("usertold", "issue-stale-lease")?.leaseId, undefined);
    assert.equal(db.issueSessions.getIssueSession("usertold", "issue-fresh-lease")?.leaseId, "lease-fresh");
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("active-lease-aware helpers use the current live lease for control writes", () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-session-active-lease-helpers-"));
  try {
    const db = new PatchRelayDatabase(path.join(baseDir, "patchrelay.sqlite"), true);
    db.runMigrations();
    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-active-lease",
      issueKey: "USE-ACTIVE-LEASE",
      workflowOutcome: undefined,
    });
    db.issueSessions.appendIssueSessionEvent({
      projectId: "usertold",
      linearIssueId: "issue-active-lease",
      eventType: "followup_comment",
      eventJson: JSON.stringify({ body: "hello" }),
    });

    assert.equal(
      db.issueSessions.acquireIssueSessionLease({
        projectId: "usertold",
        linearIssueId: "issue-active-lease",
        leaseId: "lease-1",
        workerId: "worker-a",
        leasedUntil: "2030-04-05T10:05:00.000Z",
        now: "2030-04-05T10:00:00.000Z",
      }),
      true,
    );
    assert.equal(
      db.issueSessions.acquireIssueSessionLease({
        projectId: "usertold",
        linearIssueId: "issue-active-lease",
        leaseId: "lease-2",
        workerId: "worker-b",
        leasedUntil: "2030-04-05T10:10:00.000Z",
        now: "2030-04-05T10:06:00.000Z",
      }),
      true,
    );

    const issueWrite = db.issueSessions.commitIssueState({
      writer: "test",
      update: {
        projectId: "usertold",
        linearIssueId: "issue-active-lease",
        workflowOutcome: undefined,
      },
    });
    assert.equal(issueWrite.outcome, "applied");
    assert.equal(issueWrite.outcome === "applied" ? issueWrite.issue.workflowOutcome : "not-applied", undefined);

    assert.equal(
      db.issueSessions.clearPendingIssueSessionEventsWithLease({
        projectId: "usertold",
        linearIssueId: "issue-active-lease",
        leaseId: "lease-1",
      }),
      false,
    );
    assert.equal(db.issueSessions.hasPendingIssueSessionEvents("usertold", "issue-active-lease"), true);
    assert.equal(db.issueSessions.clearPendingIssueSessionEventsRespectingActiveLease("usertold", "issue-active-lease"), true);
    assert.equal(db.issueSessions.hasPendingIssueSessionEvents("usertold", "issue-active-lease"), false);

    db.issueSessions.releaseIssueSessionLeaseRespectingActiveLease("usertold", "issue-active-lease");
    assert.equal(db.issueSessions.getIssueSession("usertold", "issue-active-lease")?.leaseId, undefined);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("issue session input derives follow-up mode and thread reuse from queued events", () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-session-events-"));
  try {
    const db = new PatchRelayDatabase(path.join(baseDir, "patchrelay.sqlite"), true);
    db.runMigrations();
    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-followup",
      issueKey: "USE-14",
      workflowOutcome: undefined,
      prNumber: 14,
      threadId: "thread-followup",
      prReviewState: "approved",
    });
    db.issueSessions.appendIssueSessionEvent({
      projectId: "usertold",
      linearIssueId: "issue-followup",
      eventType: "followup_prompt",
      eventJson: JSON.stringify({ text: "Please split the parser into smaller functions.", author: "alice" }),
    });
    db.issueSessions.appendIssueSessionEvent({
      projectId: "usertold",
      linearIssueId: "issue-followup",
      eventType: "followup_comment",
      eventJson: JSON.stringify({ body: "And keep the API stable.", author: "bob" }),
    });

    const workflowTask = db.issueSessions.peekPendingSessionInputPlanForDiagnostics("usertold", "issue-followup");
    assert.equal(workflowTask?.runType, "implementation");
    assert.equal(workflowTask?.resumeThread, true);
    assert.equal(workflowTask?.workflowReason, "followup_prompt");
    assert.equal(Array.isArray(workflowTask?.context.followUps), true);
    assert.equal(workflowTask?.context.followUpMode, true);
    assert.equal(workflowTask?.eventIds.length, 2);
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
      workflowOutcome: undefined,
      prNumber: 16,
      threadId: "thread-comment-followup",
      prReviewState: "approved",
    });
    db.issueSessions.appendIssueSessionEvent({
      projectId: "usertold",
      linearIssueId: "issue-comment-followup",
      eventType: "followup_comment",
      eventJson: JSON.stringify({ body: "Please keep the current copy.", author: "alice" }),
    });

    const workflowTask = db.issueSessions.peekPendingSessionInputPlanForDiagnostics("usertold", "issue-comment-followup");
    assert.equal(workflowTask?.runType, "implementation");
    assert.equal(workflowTask?.resumeThread, true);
    assert.equal(workflowTask?.workflowReason, "followup_comment");
    assert.equal(workflowTask?.context.followUpMode, true);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("orchestration child delivery queues workflow tasks the next turn on the same thread", () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-session-child-delivered-"));
  try {
    const db = new PatchRelayDatabase(path.join(baseDir, "patchrelay.sqlite"), true);
    db.runMigrations();
    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-parent",
      issueKey: "USE-PARENT",
      issueClass: "orchestration",
      workflowOutcome: undefined,
      threadId: "thread-parent",
    });
    db.issueSessions.appendIssueSessionEventRespectingActiveLease("usertold", "issue-parent", {
      projectId: "usertold",
      linearIssueId: "issue-parent",
      eventType: "child_delivered",
      eventJson: JSON.stringify({
        childIssueId: "issue-child",
        childIssueKey: "USE-CHILD",
        childTitle: "Ship the child task",
      }),
    });

    const workflowTask = db.issueSessions.peekPendingSessionInputPlanForDiagnostics("usertold", "issue-parent");
    assert.equal(workflowTask?.runType, "implementation");
    assert.equal(workflowTask?.workflowReason, "child_delivered");
    assert.equal(workflowTask?.resumeThread, true);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("canonical child issues exclude duplicate and canceled Linear children", () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-canonical-children-"));
  try {
    const db = new PatchRelayDatabase(path.join(baseDir, "patchrelay.sqlite"), true);
    db.runMigrations();
    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-parent",
      issueKey: "USE-PARENT",
      workflowOutcome: undefined,
    });
    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-active-child",
      issueKey: "USE-ACTIVE",
      workflowOutcome: undefined,
      currentLinearState: "Backlog",
      currentLinearStateType: "backlog",
      parentLinearIssueId: "issue-parent",
    });
    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-done-child",
      issueKey: "USE-DONE",
      workflowOutcome: "completed",
      currentLinearState: "Done",
      currentLinearStateType: "completed",
      parentLinearIssueId: "issue-parent",
    });
    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-duplicate-child",
      issueKey: "USE-DUP",
      workflowOutcome: undefined,
      currentLinearState: "Duplicate",
      currentLinearStateType: "canceled",
      parentLinearIssueId: "issue-parent",
    });
    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-canceled-child",
      issueKey: "USE-CANCELED",
      workflowOutcome: undefined,
      currentLinearState: "Canceled",
      currentLinearStateType: "canceled",
      parentLinearIssueId: "issue-parent",
    });
    for (const childLinearIssueId of [
      "issue-active-child",
      "issue-done-child",
      "issue-duplicate-child",
      "issue-canceled-child",
    ]) {
      db.issues.replaceIssueParentLink({
        projectId: "usertold",
        childLinearIssueId,
        parentLinearIssueId: "issue-parent",
      });
    }

    assert.deepEqual(
      db.issues.listCanonicalChildIssues("usertold", "issue-parent").map((issue) => issue.issueKey),
      ["USE-ACTIVE", "USE-DONE"],
    );
    assert.deepEqual(
      db.issues.listChildIssues("usertold", "issue-parent").map((issue) => issue.issueKey),
      ["USE-ACTIVE", "USE-CANCELED", "USE-DONE", "USE-DUP"],
    );
    assert.equal(db.issues.countOpenChildIssues("usertold", "issue-parent"), 1);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("direct_reply queues workflow tasks the next turn in direct-reply mode on the same thread", () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-session-direct-reply-"));
  try {
    const db = new PatchRelayDatabase(path.join(baseDir, "patchrelay.sqlite"), true);
    db.runMigrations();
    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-direct-reply",
      issueKey: "USE-17",
      inputRequestKind: "completion_check_question",
      threadId: "thread-direct-reply",
    });
    db.issueSessions.appendIssueSessionEvent({
      projectId: "usertold",
      linearIssueId: "issue-direct-reply",
      eventType: "direct_reply",
      eventJson: JSON.stringify({ body: "Use the staged rollout copy.", author: "alice" }),
    });

    const workflowTask = db.issueSessions.peekPendingSessionInputPlanForDiagnostics("usertold", "issue-direct-reply");
    assert.equal(workflowTask?.runType, "implementation");
    assert.equal(workflowTask?.resumeThread, true);
    assert.equal(workflowTask?.workflowReason, "direct_reply");
    assert.equal(workflowTask?.context.directReplyMode, true);
    assert.equal(Array.isArray(workflowTask?.context.followUps), true);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("terminal session events suppress queued follow-up workflow tasks", () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-session-terminal-events-"));
  try {
    const db = new PatchRelayDatabase(path.join(baseDir, "patchrelay.sqlite"), true);
    db.runMigrations();
    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-terminal",
      issueKey: "USE-15",
      workflowOutcome: undefined,
      prNumber: 15,
      threadId: "thread-terminal",
    });
    db.issueSessions.appendIssueSessionEvent({
      projectId: "usertold",
      linearIssueId: "issue-terminal",
      eventType: "followup_comment",
      eventJson: JSON.stringify({ body: "Please adjust the copy." }),
    });
    db.issueSessions.appendIssueSessionEvent({
      projectId: "usertold",
      linearIssueId: "issue-terminal",
      eventType: "pr_merged",
      dedupeKey: "pr_merged:15",
    });

    const workflowTask = db.issueSessions.peekPendingSessionInputPlanForDiagnostics("usertold", "issue-terminal");
    assert.equal(workflowTask, undefined);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("self comments are not treated as pending actionable workflow tasks", () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-session-self-comment-"));
  try {
    const db = new PatchRelayDatabase(path.join(baseDir, "patchrelay.sqlite"), true);
    db.runMigrations();
    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-self-comment",
      issueKey: "USE-SELF",
      workflowOutcome: undefined,
      prNumber: 16,
    });
    db.issueSessions.appendIssueSessionEvent({
      projectId: "usertold",
      linearIssueId: "issue-self-comment",
      eventType: "self_comment",
      eventJson: JSON.stringify({ body: "Status update", author: "patchrelay" }),
    });

    assert.equal(db.issueSessions.peekPendingSessionInputPlanForDiagnostics("usertold", "issue-self-comment"), undefined);
    assert.equal(db.issueSessions.hasPendingIssueSessionEvents("usertold", "issue-self-comment"), false);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("same-head requested-changes events coalesce and keep the richer payload", () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-session-review-coalesce-"));
  try {
    const db = new PatchRelayDatabase(path.join(baseDir, "patchrelay.sqlite"), true);
    db.runMigrations();
    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-review-coalesce",
      issueKey: "USE-REVIEW-COALESCE",
      workflowOutcome: undefined,
      prNumber: 17,
      prHeadSha: "sha-reviewed",
      prReviewState: "changes_requested",
    });
    const idleIdentity = buildRequestedChangesWorkflowIdentity({
      linearIssueId: "issue-review-coalesce",
      headSha: "sha-reviewed",
    });
    db.issueSessions.appendIssueSessionEvent({
      projectId: "usertold",
      linearIssueId: "issue-review-coalesce",
      eventType: "review_changes_requested",
      eventJson: JSON.stringify({
        requestedChangesCoalesceKey: idleIdentity.coalesceKey,
        requestedChangesHeadSha: idleIdentity.headSha,
      }),
      dedupeKey: idleIdentity.dedupeKey,
    });

    const webhookIdentity = buildRequestedChangesWorkflowIdentity({
      linearIssueId: "issue-review-coalesce",
      reviewId: 123,
      reviewCommitId: "sha-reviewed",
      reviewerName: "review-quill[bot]",
    });
    db.issueSessions.appendIssueSessionEvent({
      projectId: "usertold",
      linearIssueId: "issue-review-coalesce",
      eventType: "review_changes_requested",
      eventJson: JSON.stringify({
        requestedChangesCoalesceKey: webhookIdentity.coalesceKey,
        requestedChangesHeadSha: webhookIdentity.headSha,
        reviewId: 123,
        reviewerName: "review-quill[bot]",
        reviewBody: "Fix the collapsed state.",
      }),
      dedupeKey: webhookIdentity.dedupeKey,
    });

    const events = db.issueSessions.listIssueSessionEvents("usertold", "issue-review-coalesce");
    assert.equal(events.length, 1);
    const payload = JSON.parse(events[0]!.eventJson ?? "{}") as Record<string, unknown>;
    assert.equal(payload.reviewId, 123);
    assert.equal(payload.reviewBody, "Fix the collapsed state.");
    assert.equal(db.issueSessions.peekPendingSessionInputPlanForDiagnostics("usertold", "issue-review-coalesce")?.eventIds.length, 1);
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
      workflowOutcome: undefined,
    });
    const run = db.runs.createRun({
      issueId: issue.id,
      projectId: "usertold",
      linearIssueId: "issue-ended-run",
      runType: "implementation",
    });
    db.runs.finishRun(run.id, { status: "failed", failureReason: "zombie" });

    db.runs.updateRunThread(run.id, {
      threadId: "thread-after-end",
      turnId: "turn-after-end",
    });

    const finished = db.runs.getRunById(run.id);
    assert.equal(finished?.status, "failed");
    assert.equal(finished?.threadId, undefined);
    assert.equal(finished?.turnId, undefined);
    assert.equal(finished?.failureReason, "zombie");
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("reactive intent is derived from GitHub truth instead of compatibility stage names", () => {
  assert.deepEqual(
    deriveReactiveWorkflowIntent({
      prNumber: 17,
      prState: "open",
      prCheckStatus: "failed",
    }),
    {
      runType: "ci_repair",
      workflowReason: "settled_red_ci",
    },
  );

  assert.deepEqual(
    deriveReactiveWorkflowIntent({
      prNumber: 18,
      prState: "open",
      prHeadSha: "reviewed-head",
      prReviewState: "changes_requested",
      lastBlockingReviewHeadSha: "reviewed-head",
    }),
    {
      runType: "review_fix",
      workflowReason: "review_changes_requested",
    },
  );

  assert.deepEqual(
    deriveReactiveWorkflowIntent({
      prNumber: 19,
      prState: "open",
      mergeConflictDetected: true,
      downstreamOwned: true,
    }),
    {
      runType: "queue_repair",
      workflowReason: "merge_steward_incident",
    },
  );
});

test("reactive intent does not repeat requested-changes work after the PR head advances", () => {
  assert.equal(
    deriveReactiveWorkflowIntent({
      prNumber: 18,
      prState: "open",
      prHeadSha: "new-head",
      prReviewState: "changes_requested",
      lastBlockingReviewHeadSha: "old-reviewed-head",
    }),
    undefined,
  );
});
