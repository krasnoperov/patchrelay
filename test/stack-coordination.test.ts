import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { PatchRelayDatabase } from "../src/db.ts";
import { maybeFanChildRebaseWakes } from "../src/github-webhook-stack-coordination.ts";
import { createTestWakeDispatcher } from "./helpers/wake-dispatcher.ts";

function silentLogger() {
  const logger = {
    info() {}, warn() {}, error() {}, debug() {}, fatal() {}, trace() {},
    child() { return logger; },
  };
  return logger as unknown as Parameters<typeof maybeFanChildRebaseWakes>[0]["logger"];
}

function withDb<T>(fn: (db: PatchRelayDatabase) => T): T {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-stack-coord-"));
  try {
    const db = new PatchRelayDatabase(path.join(baseDir, "patchrelay.sqlite"), true);
    db.runMigrations();
    return fn(db);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
}

test("listIssuesWithParentBranch returns active children of a parent branch", () => {
  withDb((db) => {
    db.issues.upsertIssue({
      projectId: "p", linearIssueId: "PARENT", issueKey: "P-1",
      factoryState: "pr_open", branchName: "feat/parent", prNumber: 100,
    });
    db.issues.upsertIssue({
      projectId: "p", linearIssueId: "CHILD-A", issueKey: "C-A",
      factoryState: "pr_open", branchName: "feat/child-a", prNumber: 101,
      parentPrBranch: "feat/parent",
    });
    db.issues.upsertIssue({
      projectId: "p", linearIssueId: "CHILD-B", issueKey: "C-B",
      factoryState: "implementing", branchName: "feat/child-b", prNumber: 102,
      parentPrBranch: "feat/parent",
    });
    db.issues.upsertIssue({
      projectId: "p", linearIssueId: "CHILD-DONE", issueKey: "C-DONE",
      factoryState: "done", branchName: "feat/child-done",
      parentPrBranch: "feat/parent",
    });

    const children = db.issues.listIssuesWithParentBranch("feat/parent");
    const keys = children.map((c) => c.issueKey).sort();
    assert.deepEqual(keys, ["C-A", "C-B"], "should return active children only (not done)");
  });
});

test("maybeFanChildRebaseWakes enqueues branch_upkeep on stacked children for pr_synchronize", () => {
  withDb((db) => {
    db.issues.upsertIssue({
      projectId: "p", linearIssueId: "PARENT",
      factoryState: "pr_open", branchName: "feat/parent", prNumber: 100,
    });
    db.issues.upsertIssue({
      projectId: "p", linearIssueId: "CHILD",
      factoryState: "pr_open", branchName: "feat/child", prNumber: 101,
      parentPrBranch: "feat/parent", delegatedToPatchRelay: true,
    });

    const enqueued: Array<[string, string]> = [];
    const fan = () => maybeFanChildRebaseWakes({
      db,
      logger: silentLogger(),
      wakeDispatcher: createTestWakeDispatcher(db, (projectId, issueId) => enqueued.push([projectId, issueId])),
      event: {
        triggerEvent: "pr_synchronize",
        repoFullName: "owner/repo",
        branchName: "feat/parent",
        headSha: "deadbeef",
      },
    });
    fan();

    assert.deepEqual(enqueued, [["p", "CHILD"]]);

    // Legacy dual-path write is kept this stage.
    const child = db.issues.getIssue("p", "CHILD")!;
    assert.equal(child.pendingRunType, "branch_upkeep");

    // S2: the durable v2 signal is appended and materialized into a runnable
    // workflow task, so the workflow_task dispatch rung wins.
    const observations = db.workflowObservations.listObservations("p", "CHILD")
      .filter((observation) => observation.type === "github.parent_head_moved");
    assert.equal(observations.length, 1);
    const runnable = db.workflowTasks.listOpenRunnableTasks("p")
      .filter((task) => task.subjectId === "CHILD" && task.taskId === "run:branch_upkeep");
    assert.equal(runnable.length, 1);

    // Repeated syncs on the same parent head dedupe the observation.
    fan();
    const afterSecond = db.workflowObservations.listObservations("p", "CHILD")
      .filter((observation) => observation.type === "github.parent_head_moved");
    assert.equal(afterSecond.length, 1);
  });
});

test("maybeFanChildRebaseWakes is a no-op for non-pr_synchronize events", () => {
  withDb((db) => {
    db.issues.upsertIssue({
      projectId: "p", linearIssueId: "CHILD",
      factoryState: "pr_open", branchName: "feat/child", prNumber: 101,
      parentPrBranch: "feat/parent",
    });

    const enqueued: Array<[string, string]> = [];
    maybeFanChildRebaseWakes({
      db,
      logger: silentLogger(),
      wakeDispatcher: createTestWakeDispatcher(db, (projectId, issueId) => enqueued.push([projectId, issueId])),
      event: {
        triggerEvent: "review_approved",
        repoFullName: "owner/repo",
        branchName: "feat/parent",
        headSha: "deadbeef",
      },
    });

    assert.deepEqual(enqueued, []);
  });
});

test("maybeFanChildRebaseWakes skips children with an active run", () => {
  withDb((db) => {
    db.issues.upsertIssue({
      projectId: "p", linearIssueId: "CHILD",
      factoryState: "pr_open", branchName: "feat/child", prNumber: 101,
      parentPrBranch: "feat/parent",
    });
    const child = db.issues.getIssue("p", "CHILD")!;
    const run = db.runs.createRun({
      issueId: child.id,
      projectId: "p",
      linearIssueId: "CHILD",
      runType: "implementation",
    });
    db.issues.upsertIssue({
      projectId: "p", linearIssueId: "CHILD",
      activeRunId: run.id,
    });

    const enqueued: Array<[string, string]> = [];
    maybeFanChildRebaseWakes({
      db,
      logger: silentLogger(),
      wakeDispatcher: createTestWakeDispatcher(db, (projectId, issueId) => enqueued.push([projectId, issueId])),
      event: {
        triggerEvent: "pr_synchronize",
        repoFullName: "owner/repo",
        branchName: "feat/parent",
        headSha: "deadbeef",
      },
    });

    assert.deepEqual(enqueued, []);
    const after = db.issues.getIssue("p", "CHILD")!;
    assert.equal(after.pendingRunType, undefined, "should not stomp on an in-flight run");
  });
});
