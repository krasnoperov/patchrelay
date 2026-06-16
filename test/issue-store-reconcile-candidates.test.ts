import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { PatchRelayDatabase } from "../src/db.ts";
import { NON_ACTIONABLE_SESSION_EVENTS } from "../src/issue-session-events.ts";

const PROJECT = "usertold";
const NON_ACTIONABLE = [...NON_ACTIONABLE_SESSION_EVENTS];

function withDb(fn: (db: PatchRelayDatabase) => void): void {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-reconcile-candidates-"));
  try {
    const db = new PatchRelayDatabase(path.join(baseDir, "patchrelay.sqlite"), true);
    db.runMigrations();
    fn(db);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
}

function addIssue(db: PatchRelayDatabase, id: string, fields: Record<string, unknown>): void {
  db.upsertIssue({ projectId: PROJECT, linearIssueId: id, issueKey: id.toUpperCase(), ...fields } as never);
}

function keys(rows: Array<{ linearIssueId: string }>): string[] {
  return rows.map((r) => r.linearIssueId).sort();
}

test("listWorkflowTaskReconcileCandidates: non-terminal and done-with-open-task, never done-with-nothing-open", () => {
  withDb((db) => {
    addIssue(db, "non-terminal", { factoryState: "delegated" });
    addIssue(db, "done-clean", { factoryState: "done" });
    addIssue(db, "done-open-task", { factoryState: "done" });

    // Give done-open-task a lingering open workflow task.
    db.workflowTasks.reconcileTasks({
      projectId: PROJECT,
      subjectId: "done-open-task",
      tasks: [{ task: { id: "run:implementation", type: "run", runType: "implementation", reason: "x" }, authorityEpoch: 0, gateAction: "start" }],
    });

    assert.deepEqual(keys(db.issues.listWorkflowTaskReconcileCandidates()), ["done-open-task", "non-terminal"]);
  });
});

test("listTerminalIssuesNeedingGitHubProbe: escalated/failed with an open PR, excluding merged", () => {
  withDb((db) => {
    addIssue(db, "escalated-open", { factoryState: "escalated", prNumber: 1, prState: "open" });
    addIssue(db, "failed-open", { factoryState: "failed", prNumber: 2, prState: "open" });
    addIssue(db, "failed-merged", { factoryState: "failed", prNumber: 3, prState: "merged" });
    addIssue(db, "escalated-no-pr", { factoryState: "escalated" });
    addIssue(db, "escalated-active", { factoryState: "escalated", prNumber: 4, prState: "open", activeRunId: 99 });
    addIssue(db, "done-with-pr", { factoryState: "done", prNumber: 5, prState: "open" });

    assert.deepEqual(keys(db.issues.listTerminalIssuesNeedingGitHubProbe()), ["escalated-open", "failed-open"]);
  });
});

test("listOrchestrationIssuesWithSettleDeadline: orchestration rows with a settle deadline and no active run", () => {
  withDb((db) => {
    addIssue(db, "orch-settle", { factoryState: "delegated", issueClass: "orchestration", orchestrationSettleUntil: "2026-01-01T00:00:00.000Z" });
    addIssue(db, "orch-active", { factoryState: "delegated", issueClass: "orchestration", orchestrationSettleUntil: "2026-01-01T00:00:00.000Z", activeRunId: 7 });
    addIssue(db, "orch-no-settle", { factoryState: "delegated", issueClass: "orchestration" });
    addIssue(db, "plain-settle", { factoryState: "delegated", orchestrationSettleUntil: "2026-01-01T00:00:00.000Z" });

    assert.deepEqual(keys(db.issues.listOrchestrationIssuesWithSettleDeadline()), ["orch-settle"]);
  });
});

test("listRecentCompletionCandidates: done/merged within the cutoff window only", () => {
  withDb((db) => {
    addIssue(db, "done-recent", { factoryState: "done" });
    addIssue(db, "merged-recent", { factoryState: "deploying", prState: "merged" });
    addIssue(db, "delegated-recent", { factoryState: "delegated" });

    const past = "2000-01-01T00:00:00.000Z";
    const future = "2100-01-01T00:00:00.000Z";

    // All rows were just written (updated_at = now), so a past cutoff includes
    // the done/merged ones and excludes the in-flight one.
    assert.deepEqual(keys(db.issues.listRecentCompletionCandidates(past)), ["done-recent", "merged-recent"]);
    // A future cutoff excludes everything (recency boundary).
    assert.deepEqual(keys(db.issues.listRecentCompletionCandidates(future)), []);
  });
});

test("listTerminalIssuesWithPendingWake: actionable pending event or pending run type, not non-actionable noise", () => {
  withDb((db) => {
    addIssue(db, "term-actionable", { factoryState: "done" });
    db.issueSessions.appendIssueSessionEvent({
      projectId: PROJECT,
      linearIssueId: "term-actionable",
      eventType: "review_changes_requested",
      eventJson: JSON.stringify({ reviewBody: "fix" }),
    });

    addIssue(db, "term-noise", { factoryState: "done" });
    db.issueSessions.appendIssueSessionEvent({
      projectId: PROJECT,
      linearIssueId: "term-noise",
      eventType: "self_comment",
      eventJson: JSON.stringify({ text: "fyi" }),
    });

    addIssue(db, "term-pending-run", { factoryState: "failed", pendingRunType: "ci_repair" });
    addIssue(db, "nonterminal-actionable", { factoryState: "delegated" });
    db.issueSessions.appendIssueSessionEvent({
      projectId: PROJECT,
      linearIssueId: "nonterminal-actionable",
      eventType: "review_changes_requested",
      eventJson: JSON.stringify({ reviewBody: "fix" }),
    });

    assert.deepEqual(keys(db.issues.listTerminalIssuesWithPendingWake(NON_ACTIONABLE)), ["term-actionable", "term-pending-run"]);
  });
});

test("listIssuesWithActiveRun: only issues pinning an active run", () => {
  withDb((db) => {
    addIssue(db, "has-run", { factoryState: "implementing", activeRunId: 42 });
    addIssue(db, "no-run", { factoryState: "delegated" });

    assert.deepEqual(keys(db.issues.listIssuesWithActiveRun()), ["has-run"]);
  });
});
