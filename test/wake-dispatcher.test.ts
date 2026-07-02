import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import pino from "pino";
import { PatchRelayDatabase } from "../src/db.ts";
import { WakeDispatcher } from "../src/wake-dispatcher.ts";
import { reconcileWorkflowTasksForIssue } from "../src/workflow-task-reconciler.ts";
import { MemoryPatchRelayTelemetry } from "../src/telemetry.ts";

function withDb<T>(fn: (db: PatchRelayDatabase, baseDir: string) => Promise<T>): Promise<T> {
  return (async () => {
    const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-wake-dispatcher-"));
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
  factoryState: string;
}> = {}) {
  return db.upsertIssue({
    projectId: "proj",
    linearIssueId: "issue-1",
    issueKey: "PRJ-1",
    branchName: "feat/x",
    delegatedToPatchRelay: true,
    factoryState: "pr_open",
    prNumber: 1,
    prState: "open",
    ...overrides,
  });
}

test("recordEventAndDispatch appends event and enqueues when no run is active", async () => {
  await withDb(async (db) => {
    makeIssue(db, { prReviewState: "changes_requested", prHeadSha: "sha-1" });
    const enqueueCalls: Array<[string, string]> = [];
    const dispatcher = new WakeDispatcher(
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
    const dispatcher = new WakeDispatcher(
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
    // Both dispatches enqueue (the second peek still finds a wake), but
    // SerialWorkQueue dedupes by key in production.
    assert.equal(enqueueCalls.length, 2);
  });
});

test("recordEventAndDispatch does NOT enqueue while an active run is in flight", async () => {
  await withDb(async (db) => {
    const issue = makeIssue(db, { prReviewState: "changes_requested", prHeadSha: "sha-1", factoryState: "implementing" });
    const run = db.runs.createRun({
      issueId: issue.id,
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      runType: "implementation",
    });
    db.upsertIssue({ projectId: "proj", linearIssueId: "issue-1", activeRunId: run.id });

    const enqueueCalls: Array<[string, string]> = [];
    const dispatcher = new WakeDispatcher(
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

test("releaseRunAndDispatch releases the lease and enqueues if a wake is pending", async () => {
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
    const dispatcher = new WakeDispatcher(
      db,
      (p, i) => enqueueCalls.push([p, i]),
      () => { releaseCallCount += 1; },
      pino({ enabled: false }),
    );

    const result = dispatcher.releaseRunAndDispatch({ run });

    assert.equal(releaseCallCount, 1, "lease release fires unconditionally");
    assert.equal(result?.runType, "review_fix");
    assert.deepEqual(enqueueCalls, [["proj", "issue-1"]], "wake gets enqueued after release");
  });
});

test("releaseRunAndDispatch is a no-op enqueue when no wake is pending", async () => {
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
    const dispatcher = new WakeDispatcher(
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
    const dispatcher = new WakeDispatcher(
      db,
      (p, i) => enqueueCalls.push([p, i]),
      () => undefined,
      pino({ enabled: false }),
    );

    await dispatcher.withTick(async () => {
      // Two sub-passes detect the same wake. The first appends an event
      // and dispatches; the second only peeks. Tick dedupe means only
      // the first call records an enqueue.
      dispatcher.recordEventAndDispatch("proj", "issue-1", {
        eventType: "review_changes_requested",
        dedupeKey: "rcr::sha-1::reviewbot",
      });
      dispatcher.dispatchIfWakePending("proj", "issue-1");
      dispatcher.dispatchIfWakePending("proj", "issue-1");
    });

    assert.deepEqual(
      enqueueCalls,
      [["proj", "issue-1"]],
      "withTick must collapse repeated dispatches for the same issue",
    );
  });
});

test("dispatchIfWakePending falls back to legacy pendingRunType when no event exists", async () => {
  await withDb(async (db) => {
    makeIssue(db);
    db.upsertIssue({
      projectId: "proj",
      linearIssueId: "issue-1",
      pendingRunType: "branch_upkeep",
    });

    const enqueueCalls: Array<[string, string]> = [];
    const dispatcher = new WakeDispatcher(
      db,
      (p, i) => enqueueCalls.push([p, i]),
      () => undefined,
      pino({ enabled: false }),
    );

    const runType = dispatcher.dispatchIfWakePending("proj", "issue-1");

    assert.equal(runType, "branch_upkeep");
    assert.deepEqual(enqueueCalls, [["proj", "issue-1"]]);
  });
});

test("dispatchIfWakePending resolves branch_upkeep from a workflow task with source workflow_task", async () => {
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
    const dispatcher = new WakeDispatcher(
      db,
      (p, i) => enqueueCalls.push([p, i]),
      () => undefined,
      pino({ enabled: false }),
      undefined,
      telemetry,
    );

    const runType = dispatcher.dispatchIfWakePending("proj", "issue-1");

    assert.equal(runType, "branch_upkeep");
    assert.deepEqual(enqueueCalls, [["proj", "issue-1"]]);
    assert.equal(telemetry.list("wake.derived").at(-1)?.source, "workflow_task");
  });
});

test("legacy pending_run_type rung fires the legacy_pending_dispatch invariant (S6)", async () => {
  await withDb(async (db) => {
    // No runnable task, no session wake — only the legacy column. The rung still
    // works (dual-path) but must fire the proving invariant for the S7 cutover.
    makeIssue(db, { factoryState: "pr_open" });
    db.upsertIssue({ projectId: "proj", linearIssueId: "issue-1", pendingRunType: "review_fix" });

    const telemetry = new MemoryPatchRelayTelemetry();
    const enqueueCalls: Array<[string, string]> = [];
    const dispatcher = new WakeDispatcher(
      db,
      (p, i) => enqueueCalls.push([p, i]),
      () => undefined,
      pino({ enabled: false }),
      undefined,
      telemetry,
    );

    const runType = dispatcher.dispatchIfWakePending("proj", "issue-1");

    assert.equal(runType, "review_fix");
    assert.equal(telemetry.list("wake.derived").at(-1)?.source, "legacy_pending_run_type");
    const invariant = telemetry.list("health.invariant").find((e) => e.invariant === "legacy_pending_dispatch");
    assert.ok(invariant, "legacy_pending_dispatch invariant should fire");
  });
});

test("session-event rung fires the session_event_dispatch invariant (S6)", async () => {
  await withDb(async (db) => {
    // A session-event wake with no backing workflow task: still dispatches
    // (dual-path) but fires the union invariant that must be silent for S7.
    makeIssue(db, { factoryState: "pr_open" });
    db.issueSessions.appendIssueSessionEventRespectingActiveLease("proj", "issue-1", {
      projectId: "proj",
      linearIssueId: "issue-1",
      eventType: "delegated",
      dedupeKey: "delegated:issue-1",
    });

    const telemetry = new MemoryPatchRelayTelemetry();
    const dispatcher = new WakeDispatcher(
      db,
      () => undefined,
      () => undefined,
      pino({ enabled: false }),
      undefined,
      telemetry,
    );

    const runType = dispatcher.dispatchIfWakePending("proj", "issue-1");

    assert.equal(runType, "implementation");
    assert.equal(telemetry.list("wake.derived").at(-1)?.source, "session_event");
    const invariant = telemetry.list("health.invariant").find((e) => e.invariant === "session_event_dispatch");
    assert.ok(invariant, "session_event_dispatch invariant should fire");
  });
});

test("dispatchIfWakePending enqueues an already materialized runnable workflow task", async () => {
  await withDb(async (db) => {
    const issue = db.upsertIssue({
      projectId: "proj",
      linearIssueId: "issue-1",
      issueKey: "PRJ-1",
      branchName: "feat/x",
      delegatedToPatchRelay: true,
      factoryState: "delegated",
    });
    reconcileWorkflowTasksForIssue(db, issue);

    const enqueueCalls: Array<[string, string]> = [];
    const dispatcher = new WakeDispatcher(
      db,
      (p, i) => enqueueCalls.push([p, i]),
      () => undefined,
      pino({ enabled: false }),
    );

    const runType = dispatcher.dispatchIfWakePending("proj", "issue-1");

    assert.equal(runType, "implementation");
    assert.deepEqual(enqueueCalls, [["proj", "issue-1"]]);
    assert.equal(db.issueSessions.listIssueSessionEvents("proj", "issue-1", { pendingOnly: true }).length, 0);
  });
});
