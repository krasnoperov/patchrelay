import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import test from "node:test";
import { PatchRelayDatabase } from "../src/db.ts";
import { peekRunnableWorkflowTaskRunType } from "../src/pending-workflow-task.ts";
import { IssueOverviewQuery } from "../src/issue-overview-query.ts";
import { DependencyReadinessHandler } from "../src/webhooks/dependency-readiness-handler.ts";
import { TrackedIssueListQuery } from "../src/tracked-issue-list-query.ts";
import { WorkflowTaskDispatcher } from "../src/workflow-task-dispatcher.ts";
import { MemoryPatchRelayTelemetry, type PatchRelayTelemetryEvent } from "../src/telemetry.ts";

async function withDb(fn: (db: PatchRelayDatabase, telemetry: MemoryPatchRelayTelemetry) => Promise<void> | void): Promise<void> {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-blocker-invariants-"));
  const telemetry = new MemoryPatchRelayTelemetry();
  try {
    const db = new PatchRelayDatabase(path.join(baseDir, "patchrelay.sqlite"), true, telemetry);
    db.runMigrations();
    await fn(db, telemetry);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
}

function makeDispatcher(
  db: PatchRelayDatabase,
  enqueued: Array<{ projectId: string; issueId: string }>,
  telemetry?: MemoryPatchRelayTelemetry,
): WorkflowTaskDispatcher {
  return new WorkflowTaskDispatcher(
    db,
    (projectId, issueId) => {
      enqueued.push({ projectId, issueId });
    },
    (projectId, issueId) => db.issueSessions.releaseIssueSessionLease(projectId, issueId),
    pino({ enabled: false }),
    undefined,
    telemetry,
  );
}

function makeDependencyReadinessHandler(
  db: PatchRelayDatabase,
  dispatcher: WorkflowTaskDispatcher,
  telemetry?: MemoryPatchRelayTelemetry,
): DependencyReadinessHandler {
  return new DependencyReadinessHandler(
    db,
    dispatcher,
    telemetry,
  );
}

function eventsOf<T extends PatchRelayTelemetryEvent["type"]>(
  telemetry: MemoryPatchRelayTelemetry,
  type: T,
): Array<Extract<PatchRelayTelemetryEvent, { type: T }>> {
  return telemetry.list(type);
}

async function getOverviewWaitingReason(db: PatchRelayDatabase, issueKey: string): Promise<string | undefined> {
  const overview = await new IssueOverviewQuery(
    db,
    { readThread: async () => ({ id: "thread-1", turns: [] }) } as never,
    { getActiveRunStatus: async () => undefined },
  ).getIssueOverview(issueKey);
  return overview?.issue.waitingReason;
}

function getListEntry(db: PatchRelayDatabase, issueKey: string) {
  return new TrackedIssueListQuery(db).listTrackedIssues().find((entry) => entry.issueKey === issueKey);
}

function upsertBlockedImplementationIssue(db: PatchRelayDatabase, params?: {
  linearIssueId?: string;
  issueKey?: string;
  blockerLinearIssueId?: string;
  blockerIssueKey?: string;
  }): void {
  const linearIssueId = params?.linearIssueId ?? "issue-child";
  const blockerLinearIssueId = params?.blockerLinearIssueId ?? "issue-blocker";
  db.replaceIssueDependencies({
    projectId: "usertold",
    linearIssueId,
    blockers: [{
      blockerLinearIssueId,
      blockerIssueKey: params?.blockerIssueKey ?? "USE-1",
      blockerTitle: "Blocking issue",
      blockerCurrentLinearState: "In Progress",
      blockerCurrentLinearStateType: "started",
    }],
  });
  db.upsertIssue({
    projectId: "usertold",
    linearIssueId,
    issueKey: params?.issueKey ?? "USE-2",
    title: "Blocked issue",
    delegatedToPatchRelay: true,
    workflowOutcome: undefined,
  });
}

test("blocked idle issue has one derived truth across list, overview, and dispatch", async () => {
  await withDb(async (db, telemetry) => {
    const enqueued: Array<{ projectId: string; issueId: string }> = [];
    upsertBlockedImplementationIssue(db);

    const dispatcher = makeDispatcher(db, enqueued, telemetry);
    const listEntry = getListEntry(db, "USE-2");

    assert.equal(db.countUnresolvedBlockers("usertold", "issue-child"), 1);
    assert.equal(peekRunnableWorkflowTaskRunType(db, "usertold", "issue-child"), undefined);
    assert.deepEqual(db.listIssuesReadyForExecution(), []);
    assert.equal(dispatcher.dispatchIfWorkflowTaskPending("usertold", "issue-child"), undefined);
    assert.deepEqual(enqueued, []);
    assert.equal(listEntry?.blockedByCount, 1);
    assert.deepEqual(listEntry?.blockedByKeys, ["USE-1"]);
    assert.equal(listEntry?.waitingReason, "Blocked by USE-1");
    assert.equal(await getOverviewWaitingReason(db, "USE-2"), "Blocked by USE-1");
    assert.ok(eventsOf(telemetry, "dispatch.suppressed").some((event) => (
      event.reason === "blocked"
      && event.linearIssueId === "issue-child"
      && event.blockerCount === 1
      && event.blockerKeys?.includes("USE-1")
    )));
    assert.equal(eventsOf(telemetry, "health.invariant").some((event) => (
      event.invariant === "blocked_issue_with_pending_workflow_task"
      && event.linearIssueId === "issue-child"
    )), false);
  });
});

test("unblock while idle enqueues implementation and clears the derived blocked reason", async () => {
  await withDb(async (db, telemetry) => {
    const enqueued: Array<{ projectId: string; issueId: string }> = [];
    const dispatcher = makeDispatcher(db, enqueued, telemetry);
    const readiness = makeDependencyReadinessHandler(db, dispatcher, telemetry);
    upsertBlockedImplementationIssue(db);

    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-blocker",
      issueKey: "USE-1",
      currentLinearState: "Done",
      currentLinearStateType: "completed",
      workflowOutcome: "completed",
    });

    assert.deepEqual(readiness.reconcile("usertold", "issue-blocker"), ["issue-child"]);
    const listEntry = getListEntry(db, "USE-2");
    const workflowTask = db.workflowTasks.getTask("usertold", "issue-child", "run:implementation");

    assert.equal(db.countUnresolvedBlockers("usertold", "issue-child"), 0);
    assert.equal(db.issueSessions.peekPendingSessionInputPlanForDiagnostics("usertold", "issue-child"), undefined);
    assert.equal(workflowTask?.runType, "implementation");
    assert.equal(workflowTask?.gateAction, "start");
    assert.deepEqual(db.listIssuesReadyForExecution(), [{ projectId: "usertold", linearIssueId: "issue-child" }]);
    assert.deepEqual(enqueued, [{ projectId: "usertold", issueId: "issue-child" }]);
    assert.equal(listEntry?.blockedByCount, 0);
    assert.deepEqual(listEntry?.blockedByKeys, []);
    assert.equal(listEntry?.readyForExecution, true);
    assert.notEqual(listEntry?.waitingReason, "Blocked by USE-1");
    assert.notEqual(await getOverviewWaitingReason(db, "USE-2"), "Blocked by USE-1");
    assert.ok(eventsOf(telemetry, "projection.invalidated").some((event) => (
      event.reason === "issue_changed"
      && event.linearIssueId === "issue-blocker"
      && event.affectedCount === 2
    )));
    assert.ok(eventsOf(telemetry, "dependency.dependent_unblocked").some((event) => (
      event.linearIssueId === "issue-child"
      && event.blockerLinearIssueId === "issue-blocker"
      && event.dispatchedRunType === "implementation"
    )));
    assert.equal(eventsOf(telemetry, "dispatch.dispatched").filter((event) => event.linearIssueId === "issue-child").length, 1);
  });
});

test("blocked active issue emits invariant telemetry when dispatch is suppressed", async () => {
  await withDb(async (db, telemetry) => {
    const enqueued: Array<{ projectId: string; issueId: string }> = [];
    const dispatcher = makeDispatcher(db, enqueued, telemetry);
    upsertBlockedImplementationIssue(db);
    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-child",
      activeRunId: 123,
      workflowOutcome: undefined,
    });

    assert.equal(dispatcher.dispatchIfWorkflowTaskPending("usertold", "issue-child"), undefined);
    assert.deepEqual(enqueued, []);
    assert.ok(eventsOf(telemetry, "health.invariant").some((event) => (
      event.invariant === "active_run_with_unresolved_blocker"
      && event.linearIssueId === "issue-child"
      && event.runId === 123
    )));
  });
});

test("external blocker completion releases dependents without a blocker issue row or stale blocked text", async () => {
  await withDb(async (db, telemetry) => {
    const enqueued: Array<{ projectId: string; issueId: string }> = [];
    const readiness = makeDependencyReadinessHandler(db, makeDispatcher(db, enqueued, telemetry), telemetry);
    upsertBlockedImplementationIssue(db);

    db.issues.updateDependencyBlockerSnapshot({
      projectId: "usertold",
      blockerLinearIssueId: "issue-blocker",
      blockerCurrentLinearState: "Done",
      blockerCurrentLinearStateType: "completed",
    });

    assert.equal(db.getIssue("usertold", "issue-blocker"), undefined);
    assert.deepEqual(readiness.reconcile("usertold", "issue-blocker"), ["issue-child"]);
    const listEntry = getListEntry(db, "USE-2");
    const workflowTask = db.workflowTasks.getTask("usertold", "issue-child", "run:implementation");
    assert.equal(db.countUnresolvedBlockers("usertold", "issue-child"), 0);
    assert.equal(db.issueSessions.peekPendingSessionInputPlanForDiagnostics("usertold", "issue-child"), undefined);
    assert.equal(workflowTask?.runType, "implementation");
    assert.equal(workflowTask?.gateAction, "start");
    assert.deepEqual(enqueued, [{ projectId: "usertold", issueId: "issue-child" }]);
    assert.equal(listEntry?.readyForExecution, true);
    assert.notEqual(listEntry?.waitingReason, "Blocked by USE-1");
    assert.ok(eventsOf(telemetry, "projection.invalidated").some((event) => (
      event.reason === "dependency_blocker_changed"
      && event.linearIssueId === "issue-blocker"
      && event.affectedCount === 1
    )));
    assert.ok(eventsOf(telemetry, "dependency.dependent_unblocked").some((event) => event.linearIssueId === "issue-child"));
  });
});

test("multiple blockers keep the remaining blocker until the final unblock queues workflow work", async () => {
  await withDb(async (db, telemetry) => {
    const enqueued: Array<{ projectId: string; issueId: string }> = [];
    const readiness = makeDependencyReadinessHandler(db, makeDispatcher(db, enqueued, telemetry), telemetry);
    db.replaceIssueDependencies({
      projectId: "usertold",
      linearIssueId: "issue-child",
      blockers: [
        {
          blockerLinearIssueId: "issue-blocker-1",
          blockerIssueKey: "USE-1",
          blockerCurrentLinearState: "In Progress",
          blockerCurrentLinearStateType: "started",
        },
        {
          blockerLinearIssueId: "issue-blocker-2",
          blockerIssueKey: "USE-3",
          blockerCurrentLinearState: "In Progress",
          blockerCurrentLinearStateType: "started",
        },
      ],
    });
    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-child",
      issueKey: "USE-2",
      delegatedToPatchRelay: true,
      workflowOutcome: undefined,
    });

    db.issues.updateDependencyBlockerSnapshot({
      projectId: "usertold",
      blockerLinearIssueId: "issue-blocker-1",
      blockerCurrentLinearState: "Done",
      blockerCurrentLinearStateType: "completed",
    });
    assert.deepEqual(readiness.reconcile("usertold", "issue-blocker-1"), []);
    let listEntry = getListEntry(db, "USE-2");
    assert.equal(db.countUnresolvedBlockers("usertold", "issue-child"), 1);
    assert.deepEqual(enqueued, []);
    assert.deepEqual(listEntry?.blockedByKeys, ["USE-3"]);
    assert.equal(listEntry?.waitingReason, "Blocked by USE-3");
    assert.ok(eventsOf(telemetry, "dependency.remaining_blockers").some((event) => (
      event.linearIssueId === "issue-child"
      && event.blockerLinearIssueId === "issue-blocker-1"
      && event.blockerCount === 1
      && event.blockerKeys?.includes("USE-3")
    )));

    db.issues.updateDependencyBlockerSnapshot({
      projectId: "usertold",
      blockerLinearIssueId: "issue-blocker-2",
      blockerCurrentLinearState: "Done",
      blockerCurrentLinearStateType: "completed",
    });
    assert.deepEqual(readiness.reconcile("usertold", "issue-blocker-2"), ["issue-child"]);
    listEntry = getListEntry(db, "USE-2");
    assert.equal(db.countUnresolvedBlockers("usertold", "issue-child"), 0);
    assert.deepEqual(enqueued, [{ projectId: "usertold", issueId: "issue-child" }]);
    assert.deepEqual(listEntry?.blockedByKeys, []);
    assert.equal(listEntry?.waitingReason, "Ready to run implementation");
    assert.ok(eventsOf(telemetry, "dependency.dependent_unblocked").some((event) => (
      event.linearIssueId === "issue-child"
      && event.blockerLinearIssueId === "issue-blocker-2"
      && event.dispatchedRunType === "implementation"
    )));
  });
});

test("blocked requested-changes work waits until unblock and then queues review_fix workflow work, not implementation", async () => {
  await withDb(async (db, telemetry) => {
    const enqueued: Array<{ projectId: string; issueId: string }> = [];
    const dispatcher = makeDispatcher(db, enqueued, telemetry);
    const readiness = makeDependencyReadinessHandler(db, dispatcher, telemetry);
    db.replaceIssueDependencies({
      projectId: "usertold",
      linearIssueId: "issue-review",
      blockers: [{
        blockerLinearIssueId: "issue-blocker",
        blockerIssueKey: "USE-1",
        blockerCurrentLinearState: "In Progress",
        blockerCurrentLinearStateType: "started",
      }],
    });
    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-review",
      issueKey: "USE-4",
      delegatedToPatchRelay: true,
      workflowOutcome: undefined,
      prNumber: 44,
      prState: "open",
      prHeadSha: "sha-review",
      prReviewState: "changes_requested",
      lastBlockingReviewHeadSha: "sha-review",
      prCheckStatus: "success",
    });

    assert.equal(dispatcher.recordEventAndDispatch("usertold", "issue-review", {
      eventType: "review_changes_requested",
      dedupeKey: "review:issue-review:head",
    }), undefined);
    assert.deepEqual(enqueued, []);

    db.issues.updateDependencyBlockerSnapshot({
      projectId: "usertold",
      blockerLinearIssueId: "issue-blocker",
      blockerCurrentLinearState: "Done",
      blockerCurrentLinearStateType: "completed",
    });
    assert.deepEqual(readiness.reconcile("usertold", "issue-blocker"), ["issue-review"]);
    assert.equal(peekRunnableWorkflowTaskRunType(db, "usertold", "issue-review"), "review_fix");
    assert.deepEqual(enqueued, [{ projectId: "usertold", issueId: "issue-review" }]);
    assert.ok(eventsOf(telemetry, "dispatch.suppressed").some((event) => (
      event.reason === "blocked"
      && event.linearIssueId === "issue-review"
    )));
    assert.ok(eventsOf(telemetry, "dependency.dependent_unblocked").some((event) => (
      event.linearIssueId === "issue-review"
      && event.dispatchedRunType === "review_fix"
    )));
  });
});

test("blocked red-CI work waits until unblock and then queues ci_repair workflow work, not implementation", async () => {
  await withDb(async (db, telemetry) => {
    const enqueued: Array<{ projectId: string; issueId: string }> = [];
    const dispatcher = makeDispatcher(db, enqueued, telemetry);
    const readiness = makeDependencyReadinessHandler(db, dispatcher, telemetry);
    db.replaceIssueDependencies({
      projectId: "usertold",
      linearIssueId: "issue-ci",
      blockers: [{
        blockerLinearIssueId: "issue-blocker",
        blockerIssueKey: "USE-1",
        blockerCurrentLinearState: "In Progress",
        blockerCurrentLinearStateType: "started",
      }],
    });
    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-ci",
      issueKey: "USE-5",
      delegatedToPatchRelay: true,
      workflowOutcome: undefined,
      prNumber: 55,
      prState: "open",
      prHeadSha: "sha-1",
      prCheckStatus: "failure",
      lastGitHubFailureSource: "branch_ci",
      lastGitHubFailureHeadSha: "sha-1",
      lastGitHubFailureSignature: "ci::sha-1",
    });

    assert.equal(dispatcher.recordEventAndDispatch("usertold", "issue-ci", {
      eventType: "settled_red_ci",
      dedupeKey: "ci:issue-ci:sha-1",
    }), undefined);
    assert.deepEqual(enqueued, []);

    db.issues.updateDependencyBlockerSnapshot({
      projectId: "usertold",
      blockerLinearIssueId: "issue-blocker",
      blockerCurrentLinearState: "Done",
      blockerCurrentLinearStateType: "completed",
    });
    assert.deepEqual(readiness.reconcile("usertold", "issue-blocker"), ["issue-ci"]);
    assert.equal(peekRunnableWorkflowTaskRunType(db, "usertold", "issue-ci"), "ci_repair");
    assert.deepEqual(enqueued, [{ projectId: "usertold", issueId: "issue-ci" }]);
    assert.ok(eventsOf(telemetry, "dependency.dependent_unblocked").some((event) => (
      event.linearIssueId === "issue-ci"
      && event.dispatchedRunType === "ci_repair"
    )));
  });
});

test("unblock under a held lease preserves lease ownership and dedupes enqueue within a reconcile tick", async () => {
  await withDb(async (db, telemetry) => {
    const enqueued: Array<{ projectId: string; issueId: string }> = [];
    const dispatcher = makeDispatcher(db, enqueued, telemetry);
    const readiness = makeDependencyReadinessHandler(db, dispatcher, telemetry);
    upsertBlockedImplementationIssue(db);
    assert.equal(db.issueSessions.acquireIssueSessionLease({
      projectId: "usertold",
      linearIssueId: "issue-child",
      leaseId: "lease-live",
      workerId: "worker-a",
      leasedUntil: "2030-01-01T00:05:00.000Z",
      now: "2030-01-01T00:00:00.000Z",
    }), true);
    assert.equal(db.issueSessions.commitIssueState({
      writer: "test",
      lease: {
        projectId: "usertold",
        linearIssueId: "issue-child",
        leaseId: "lease-stale",
      },
      update: {
        projectId: "usertold",
        linearIssueId: "issue-child",
        workflowOutcome: undefined,
      },
    }).outcome, "lease_denied");

    db.issues.updateDependencyBlockerSnapshot({
      projectId: "usertold",
      blockerLinearIssueId: "issue-blocker",
      blockerCurrentLinearState: "Done",
      blockerCurrentLinearStateType: "completed",
    });

    await dispatcher.withTick(async () => {
      assert.deepEqual(readiness.reconcile("usertold", "issue-blocker"), ["issue-child"]);
      assert.deepEqual(readiness.reconcile("usertold", "issue-blocker"), ["issue-child"]);
    });
    const session = db.issueSessions.getIssueSession("usertold", "issue-child");
    assert.equal(session?.leaseId, "lease-live");
    assert.deepEqual(enqueued, [{ projectId: "usertold", issueId: "issue-child" }]);
    assert.equal(eventsOf(telemetry, "dispatch.dispatched").filter((event) => event.linearIssueId === "issue-child").length, 1);
    assert.ok(eventsOf(telemetry, "dispatch.deduped").some((event) => event.linearIssueId === "issue-child"));
    assert.ok(eventsOf(telemetry, "queue.deduped").some((event) => event.linearIssueId === "issue-child"));
  });
});
