import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import pino from "pino";
import { PatchRelayDatabase } from "../src/db.ts";
import { WorkflowTaskDispatcher } from "../src/workflow-task-dispatcher.ts";
import { reconcileWorkflowTasksForIssue } from "../src/workflow-task-reconciler.ts";
import { MemoryPatchRelayTelemetry } from "../src/telemetry.ts";

function withDb<T>(fn: (db: PatchRelayDatabase, baseDir: string) => Promise<T>): Promise<T> {
  return (async () => {
    const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-workflow-task-dispatcher-"));
    try {
      const db = new PatchRelayDatabase(path.join(baseDir, "patchrelay.sqlite"), true);
      db.runMigrations();
      return await fn(db, baseDir);
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  })();
}

function makeIssue(db: PatchRelayDatabase, overrides: Partial<{
  prState: string;
  prReviewState: string;
  prCheckStatus: string;
  prHeadSha: string;
  prNumber: number;
  workflowOutcome: string;
}> = {}) {
  return db.upsertIssue({
    projectId: "proj",
    linearIssueId: "issue-1",
    issueKey: "PRJ-1",
    branchName: "feat/x",
    delegatedToPatchRelay: true,
    workflowOutcome: undefined,
    prNumber: 1,
    prState: "open",
    ...overrides,
  });
}

test("recordEventAndDispatch appends event and enqueues when no run is active", async () => {
  await withDb(async (db) => {
    makeIssue(db, { prReviewState: "changes_requested", prHeadSha: "sha-1" });
    const enqueueCalls: Array<[string, string]> = [];
    const dispatcher = new WorkflowTaskDispatcher(
      db,
      (p, i) => enqueueCalls.push([p, i]),
      () => undefined,
      pino({ enabled: false }),
    );

    const runType = dispatcher.recordEventAndDispatch("proj", "issue-1", {
      eventType: "review_changes_requested",
      dedupeKey: "rcr::sha-1::reviewbot",
    });

    assert.equal(runType, "review_fix");
    assert.deepEqual(enqueueCalls, [["proj", "issue-1"]]);
    const events = db.issueSessions.listIssueSessionEvents("proj", "issue-1", { pendingOnly: true });
    assert.equal(events.length, 1);
    assert.equal(events[0]!.eventType, "review_changes_requested");
  });
});

test("recordEventAndDispatch dedupes both the event and the enqueue when called twice with the same dedupeKey", async () => {
  await withDb(async (db) => {
    makeIssue(db, { prReviewState: "changes_requested", prHeadSha: "sha-1" });
    const enqueueCalls: Array<[string, string]> = [];
    const dispatcher = new WorkflowTaskDispatcher(
      db,
      (p, i) => enqueueCalls.push([p, i]),
      () => undefined,
      pino({ enabled: false }),
    );

    dispatcher.recordEventAndDispatch("proj", "issue-1", {
      eventType: "review_changes_requested",
      dedupeKey: "rcr::sha-1::reviewbot",
    });
    dispatcher.recordEventAndDispatch("proj", "issue-1", {
      eventType: "review_changes_requested",
      dedupeKey: "rcr::sha-1::reviewbot",
    });

    const events = db.issueSessions.listIssueSessionEvents("proj", "issue-1", { pendingOnly: true });
    assert.equal(events.length, 1, "dedupeKey should collapse the two appends into one event");
    // Both dispatches enqueue (the second peek still finds a workflowTask), but
    // SerialWorkQueue dedupes by key in production.
    assert.equal(enqueueCalls.length, 2);
  });
});

test("recordEventAndDispatch does NOT enqueue while an active run is in flight", async () => {
  await withDb(async (db) => {
    const issue = makeIssue(db, { prReviewState: "changes_requested", prHeadSha: "sha-1", workflowOutcome: undefined });
    const run = db.runs.createRun({
      issueId: issue.id,
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      runType: "implementation",
    });
    db.upsertIssue({ projectId: "proj", linearIssueId: "issue-1", activeRunId: run.id });

    const enqueueCalls: Array<[string, string]> = [];
    const dispatcher = new WorkflowTaskDispatcher(
      db,
      (p, i) => enqueueCalls.push([p, i]),
      () => undefined,
      pino({ enabled: false }),
    );

    dispatcher.recordEventAndDispatch("proj", "issue-1", {
      eventType: "review_changes_requested",
      dedupeKey: "rcr::sha-1::reviewbot",
    });

    // The event must persist (so the finalizer can pick it up later),
    // but no enqueue happens while the run is still active.
    const events = db.issueSessions.listIssueSessionEvents("proj", "issue-1", { pendingOnly: true });
    assert.equal(events.length, 1);
    assert.deepEqual(enqueueCalls, []);
  });
});

test("releaseRunAndDispatch releases the lease and enqueues if a workflowTask is pending", async () => {
  await withDb(async (db) => {
    const issue = makeIssue(db, { prReviewState: "changes_requested", prHeadSha: "sha-1" });
    const run = db.runs.createRun({
      issueId: issue.id,
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      runType: "implementation",
    });
    db.upsertIssue({ projectId: "proj", linearIssueId: "issue-1", activeRunId: run.id });
    db.issueSessions.appendIssueSessionEventRespectingActiveLease("proj", "issue-1", {
      projectId: "proj",
      linearIssueId: "issue-1",
      eventType: "review_changes_requested",
      dedupeKey: "rcr::sha-1::reviewbot",
    });
    // Simulate the run finalizer's pre-release: clear the active run id.
    db.upsertIssue({ projectId: "proj", linearIssueId: "issue-1", activeRunId: null });

    const enqueueCalls: Array<[string, string]> = [];
    let releaseCallCount = 0;
    const dispatcher = new WorkflowTaskDispatcher(
      db,
      (p, i) => enqueueCalls.push([p, i]),
      () => { releaseCallCount += 1; },
      pino({ enabled: false }),
    );

    const result = dispatcher.releaseRunAndDispatch({ run });

    assert.equal(releaseCallCount, 1, "lease release fires unconditionally");
    assert.equal(result?.runType, "review_fix");
    assert.deepEqual(enqueueCalls, [["proj", "issue-1"]], "workflowTask gets enqueued after release");
  });
});

test("releaseRunAndDispatch is a no-op enqueue when no workflowTask is pending", async () => {
  await withDb(async (db) => {
    const issue = makeIssue(db);
    const run = db.runs.createRun({
      issueId: issue.id,
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      runType: "implementation",
    });

    const enqueueCalls: Array<[string, string]> = [];
    let releaseCallCount = 0;
    const dispatcher = new WorkflowTaskDispatcher(
      db,
      (p, i) => enqueueCalls.push([p, i]),
      () => { releaseCallCount += 1; },
      pino({ enabled: false }),
    );

    const result = dispatcher.releaseRunAndDispatch({ run });

    assert.equal(releaseCallCount, 1);
    assert.equal(result, undefined);
    assert.deepEqual(enqueueCalls, []);
  });
});

test("withTick scopes per-pass dedupe across nested dispatch calls", async () => {
  await withDb(async (db) => {
    makeIssue(db, { prReviewState: "changes_requested", prHeadSha: "sha-1" });

    const enqueueCalls: Array<[string, string]> = [];
    const dispatcher = new WorkflowTaskDispatcher(
      db,
      (p, i) => enqueueCalls.push([p, i]),
      () => undefined,
      pino({ enabled: false }),
    );

    await dispatcher.withTick(async () => {
      // Two sub-passes detect the same workflowTask. The first appends an event
      // and dispatches; the second only peeks. Tick dedupe means only
      // the first call records an enqueue.
      dispatcher.recordEventAndDispatch("proj", "issue-1", {
        eventType: "review_changes_requested",
        dedupeKey: "rcr::sha-1::reviewbot",
      });
      dispatcher.dispatchIfWorkflowTaskPending("proj", "issue-1");
      dispatcher.dispatchIfWorkflowTaskPending("proj", "issue-1");
    });

    assert.deepEqual(
      enqueueCalls,
      [["proj", "issue-1"]],
      "withTick must collapse repeated dispatches for the same issue",
    );
  });
});

test("dispatchIfWorkflowTaskPending does not dispatch without a runnable workflow task", async () => {
  await withDb(async (db) => {
    makeIssue(db);

    const enqueueCalls: Array<[string, string]> = [];
    const dispatcher = new WorkflowTaskDispatcher(
      db,
      (p, i) => enqueueCalls.push([p, i]),
      () => undefined,
      pino({ enabled: false }),
    );

    const runType = dispatcher.dispatchIfWorkflowTaskPending("proj", "issue-1");

    assert.equal(runType, undefined);
    assert.deepEqual(enqueueCalls, []);
  });
});

test("dispatchIfWorkflowTaskPending resolves branch_upkeep from a workflow task with source workflow_task", async () => {
  await withDb(async (db) => {
    makeIssue(db, { prNumber: 101, prState: "open", prHeadSha: "child-head-1" });
    db.workflowObservations.appendObservation({
      projectId: "proj",
      subjectId: "issue-1",
      source: "github",
      type: "github.parent_head_moved",
      payloadJson: JSON.stringify({
        parentBranch: "feat/parent",
        parentHeadSha: "parent-head-2",
        childPrNumber: 101,
        childHeadSha: "child-head-1",
      }),
      dedupeKey: "branch_upkeep:issue-1:parent-head-2",
    });
    reconcileWorkflowTasksForIssue(db, db.getIssue("proj", "issue-1")!);

    const telemetry = new MemoryPatchRelayTelemetry();
    const enqueueCalls: Array<[string, string]> = [];
    const dispatcher = new WorkflowTaskDispatcher(
      db,
      (p, i) => enqueueCalls.push([p, i]),
      () => undefined,
      pino({ enabled: false }),
      undefined,
      telemetry,
    );

    const runType = dispatcher.dispatchIfWorkflowTaskPending("proj", "issue-1");

    assert.equal(runType, "branch_upkeep");
    assert.deepEqual(enqueueCalls, [["proj", "issue-1"]]);
    assert.equal(telemetry.list("dispatch.derived").at(-1)?.source, "workflow_task");
  });
});

test("PR facts without a derived workflow task are not a dispatch source", async () => {
  await withDb(async (db) => {
    makeIssue(db, { workflowOutcome: undefined });

    const telemetry = new MemoryPatchRelayTelemetry();
    const enqueueCalls: Array<[string, string]> = [];
    const dispatcher = new WorkflowTaskDispatcher(
      db,
      (p, i) => enqueueCalls.push([p, i]),
      () => undefined,
      pino({ enabled: false }),
      undefined,
      telemetry,
    );

    const runType = dispatcher.dispatchIfWorkflowTaskPending("proj", "issue-1");

    assert.equal(runType, undefined);
    assert.deepEqual(enqueueCalls, []);
    assert.equal(telemetry.list("dispatch.derived").length, 0);
  });
});

test("session-event workflowTask is not a dispatch source without a runnable workflow task", async () => {
  await withDb(async (db) => {
    makeIssue(db, { workflowOutcome: undefined });
    db.issueSessions.appendIssueSessionEventRespectingActiveLease("proj", "issue-1", {
      projectId: "proj",
      linearIssueId: "issue-1",
      eventType: "delegated",
      dedupeKey: "delegated:issue-1",
    });

    const telemetry = new MemoryPatchRelayTelemetry();
    const dispatcher = new WorkflowTaskDispatcher(
      db,
      () => undefined,
      () => undefined,
      pino({ enabled: false }),
      undefined,
      telemetry,
    );

    const runType = dispatcher.dispatchIfWorkflowTaskPending("proj", "issue-1");

    assert.equal(runType, undefined);
    assert.equal(telemetry.list("dispatch.derived").length, 0);
  });
});

test("dispatchIfWorkflowTaskPending enqueues an already materialized runnable workflow task", async () => {
  await withDb(async (db) => {
    const issue = db.upsertIssue({
      projectId: "proj",
      linearIssueId: "issue-1",
      issueKey: "PRJ-1",
      branchName: "feat/x",
      delegatedToPatchRelay: true,
      workflowOutcome: undefined,
    });
    reconcileWorkflowTasksForIssue(db, issue);

    const enqueueCalls: Array<[string, string]> = [];
    const dispatcher = new WorkflowTaskDispatcher(
      db,
      (p, i) => enqueueCalls.push([p, i]),
      () => undefined,
      pino({ enabled: false }),
    );

    const runType = dispatcher.dispatchIfWorkflowTaskPending("proj", "issue-1");

    assert.equal(runType, "implementation");
    assert.deepEqual(enqueueCalls, [["proj", "issue-1"]]);
    assert.equal(db.issueSessions.listIssueSessionEvents("proj", "issue-1", { pendingOnly: true }).length, 0);
  });
});
