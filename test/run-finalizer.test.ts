import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { assertIssuePhase } from "./assert-issue-phase.ts";
import pino from "pino";
import { PatchRelayDatabase } from "../src/db.ts";
import { RunFinalizer } from "../src/run-finalizer.ts";
import type { WorkflowOutcome } from "../src/issue-phase.ts";
import { reconcileWorkflowTasksForIssue } from "../src/workflow-task-reconciler.ts";
import { createTestWorkflowTaskDispatcher } from "./helpers/workflow-task-dispatcher.ts";

function createDb() {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-run-finalizer-"));
  const db = new PatchRelayDatabase(path.join(baseDir, "patchrelay.sqlite"), true);
  db.runMigrations();
  return { baseDir, db };
}

function acquireLease(db: PatchRelayDatabase, projectId: string, linearIssueId: string): { projectId: string; linearIssueId: string; leaseId: string } {
  const leaseId = "lease-1";
  db.issueSessions.forceAcquireIssueSessionLease({
    projectId,
    linearIssueId,
    leaseId,
    workerId: "worker-1",
    leasedUntil: new Date(Date.now() + 60_000).toISOString(),
  });
  return { projectId, linearIssueId, leaseId };
}

function createFinalizer(db: PatchRelayDatabase, completionCheckResult: {
  outcome: "continue" | "needs_input" | "done" | "failed";
  summary: string;
  question?: string;
  why?: string;
  recommendedReply?: string;
}, options?: {
  publishedOutcomeError?: string | null;
  failedRecoveryError?: string | null;
  reactiveAdvanceError?: string | null;
  reviewFixAdvanceError?: string | null;
  onEnqueue?: (projectId: string, issueId: string) => void;
  failRunAndClear?: (runId: number, message: string, nextState?: WorkflowOutcome) => void;
}) {
  const feedEvents: Array<Record<string, unknown>> = [];
  const activities: Array<Record<string, unknown>> = [];
  const enqueueCalls: Array<{ projectId: string; issueId: string }> = [];
  const lease = acquireLease(db, "usertold", "issue-1");
  const release = () => db.issueSessions.releaseIssueSessionLease(lease.projectId, lease.linearIssueId, lease.leaseId);
  // Shared feed: the dispatcher publishes the deferred_follow_up_queued
  // event after a run release, so it must write into the same array
  // that the finalizer's `feed` writes into.
  const sharedFeed = {
    publish(event: unknown) {
      feedEvents.push(event as Record<string, unknown>);
      return event as never;
    },
  };
  const dispatcher = createTestWorkflowTaskDispatcher(
    db,
    (projectId, issueId) => {
      enqueueCalls.push({ projectId, issueId });
      options?.onEnqueue?.(projectId, issueId);
    },
    release,
    sharedFeed as never,
  );
  const finalizer = new RunFinalizer(
    db,
    pino({ enabled: false }),
    {
      emitActivity: async (_issue, content) => {
        activities.push(content as unknown as Record<string, unknown>);
      },
      syncSession: async () => {},
      clearProgress: () => {},
    } as never,
    dispatcher,
    (_projectId, _linearIssueId, fn) => fn(lease as never),
    release,
    () => true,
    (run, message, nextState) => {
      if (options?.failRunAndClear) {
        options.failRunAndClear(run.id, message, nextState);
        return;
      }
      throw new Error("failRunAndClear should not be called in completion-check tests");
    },
    {
      verifyReactiveRunAdvancedBranch: async () => options && "reactiveAdvanceError" in options
        ? options.reactiveAdvanceError ?? undefined
        : undefined,
      verifyReviewFixAdvancedHead: async () => options && "reviewFixAdvanceError" in options
        ? options.reviewFixAdvanceError ?? undefined
        : undefined,
      verifyReactiveRunStayedInScope: async () => undefined,
      verifyPublishedRunOutcome: async () => options && "publishedOutcomeError" in options
        ? options.publishedOutcomeError ?? undefined
        : "Implementation completed without opening a PR.",
      detectRecoverableFailedImplementationOutcome: async () => options && "failedRecoveryError" in options
        ? options.failedRecoveryError ?? undefined
        : undefined,
      refreshIssueAfterReactivePublish: async (_run, issue) => issue,
      resolvePostRunFollowUp: async () => undefined,
    } as never,
    {
      run: async () => ({
        threadId: "fork-1",
        turnId: "turn-1",
        ...completionCheckResult,
      }),
    },
    sharedFeed as never,
  );
  return { finalizer, feedEvents, activities, enqueueCalls };
}

test("repair run finalizer continues automatically with a preserved dirty worktree", async () => {
  const { baseDir, db } = createDb();
  try {
    const worktreePath = path.join(baseDir, "repo");
    execFileSync("git", ["init", worktreePath], { stdio: "ignore" });
    execFileSync("git", ["-C", worktreePath, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", worktreePath, "config", "user.name", "Test User"]);
    writeFileSync(path.join(worktreePath, "tracked.txt"), "base\n");
    execFileSync("git", ["-C", worktreePath, "add", "tracked.txt"]);
    execFileSync("git", ["-C", worktreePath, "commit", "-m", "base"], { stdio: "ignore" });
    writeFileSync(path.join(worktreePath, "tracked.txt"), "dirty\n");

    const issue = db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-1",
      issueKey: "USE-REPAIR",
      title: "Repair dirty worktree",
      workflowOutcome: undefined,
      worktreePath,
      prNumber: 123,
    });
    const run = db.runs.createRun({
      issueId: issue.id,
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      runType: "branch_upkeep",
    });
    db.runs.updateRunThread(run.id, { threadId: "thread-1", turnId: "turn-main" });

    const { finalizer, feedEvents, enqueueCalls, activities } = createFinalizer(
      db,
      { outcome: "done", summary: "done" },
      {
        publishedOutcomeError: null,
      },
    );

    await finalizer.finalizeCompletedRun({
      source: "notification",
      run: db.runs.getRunById(run.id)!,
      issue: db.getIssue(issue.projectId, issue.linearIssueId)!,
      thread: {
        id: "thread-1",
        preview: "",
        cwd: worktreePath,
        status: "idle",
        turns: [
          {
            id: "turn-main",
            status: "completed",
            items: [{ id: "msg-1", type: "agentMessage", text: "Pushed the repair." }],
          },
        ],
      },
      threadId: "thread-1",
      completedTurnId: "turn-main",
    });

    const updatedIssue = db.getIssue(issue.projectId, issue.linearIssueId)!;
    const updatedRun = db.runs.getRunById(run.id)!;
    const workflowTask = db.issueSessions.peekPendingSessionInputPlanForDiagnostics(issue.projectId, issue.linearIssueId);
    assertIssuePhase(updatedIssue, "pr_open");
    assert.equal(updatedRun.status, "completed");
    assert.equal(workflowTask?.runType, "branch_upkeep");
    assert.equal(workflowTask?.resumeThread, true);
    assert.equal(workflowTask?.context.preserveDirtyWorktree, true);
    assert.match(String(workflowTask?.context.dirtyWorktreeSummary ?? ""), /tracked\.txt/);
    assert.deepEqual(enqueueCalls, [{ projectId: issue.projectId, issueId: issue.linearIssueId }]);
    assert.equal(feedEvents.at(-1)?.status, "dirty_repair_continue");
    assert.match(String(activities.at(-1)?.body ?? ""), /continuing automatically/);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("run finalizer moves no-PR runs into awaiting_input when completion check needs input", async () => {
  const { baseDir, db } = createDb();
  try {
    const issue = db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-1",
      issueKey: "USE-110",
      title: "Harden worker security headers",
      workflowOutcome: undefined,
      agentSessionId: "session-1",
    });
    const run = db.runs.createRun({
      issueId: issue.id,
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      runType: "implementation",
    });
    db.runs.updateRunThread(run.id, { threadId: "thread-1", turnId: "turn-main" });

    const { finalizer, feedEvents } = createFinalizer(db, {
      outcome: "needs_input",
      summary: "Approval is needed before the worker routing can change.",
      question: "Approve routing /v1/* through the worker?",
      why: "The widget asset still bypasses the worker.",
      recommendedReply: "Approved: route /v1/* through the worker.",
    });

    await finalizer.finalizeCompletedRun({
      source: "notification",
      run: db.runs.getRunById(run.id)!,
      issue: db.getIssue(issue.projectId, issue.linearIssueId)!,
      thread: {
        id: "thread-1",
        preview: "",
        cwd: "/tmp/work",
        status: "idle",
        turns: [
          {
            id: "turn-main",
            status: "completed",
            items: [{ id: "msg-1", type: "agentMessage", text: "Routing still needs approval." }],
          },
        ],
      },
      threadId: "thread-1",
      completedTurnId: "turn-main",
    });

    const updatedIssue = db.getIssue(issue.projectId, issue.linearIssueId)!;
    const updatedRun = db.runs.getRunById(run.id)!;
    assertIssuePhase(updatedIssue, "awaiting_input");
    assert.equal(updatedRun.status, "completed");
    assert.equal(updatedRun.completionCheckOutcome, "needs_input");
    assert.equal(updatedRun.completionCheckQuestion, "Approve routing /v1/* through the worker?");
    assert.equal(feedEvents.at(-1)?.status, "completion_check_needs_input");
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("run finalizer suppresses late completion after authority is revoked", async () => {
  const { baseDir, db } = createDb();
  try {
    const issue = db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-1",
      issueKey: "USE-REVOKED",
      title: "Do not publish after undelegation",
      workflowOutcome: undefined,
      delegatedToPatchRelay: false,
    });
    const run = db.runs.createRun({
      issueId: issue.id,
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      runType: "implementation",
      authorityEpoch: 1,
    });
    db.runs.updateRunThread(run.id, { threadId: "thread-1", turnId: "turn-main" });
    db.issueSessions.commitIssueState({
      writer: "run-finalizer-test",
      update: {
        projectId: issue.projectId,
        linearIssueId: issue.linearIssueId,
        activeRunId: run.id,
      },
    });
    db.workflowObservations.appendObservation({
      projectId: issue.projectId,
      subjectId: issue.linearIssueId,
      source: "linear",
      type: "linear.undelegated",
      payloadJson: JSON.stringify({ delegated: false }),
      observedAt: "2026-06-14T10:05:00.000Z",
    });

    const { finalizer, feedEvents } = createFinalizer(db, {
      outcome: "done",
      summary: "would have continued if authority were still present",
    });

    await finalizer.finalizeCompletedRun({
      source: "notification",
      run: db.runs.getRunById(run.id)!,
      issue: db.getIssue(issue.projectId, issue.linearIssueId)!,
      thread: {
        id: "thread-1",
        preview: "",
        cwd: "/tmp/work",
        status: "idle",
        turns: [
          {
            id: "turn-main",
            status: "completed",
            items: [{ id: "msg-1", type: "agentMessage", text: "Done." }],
          },
        ],
      },
      threadId: "thread-1",
      completedTurnId: "turn-main",
    });

    const updatedIssue = db.getIssue(issue.projectId, issue.linearIssueId)!;
    const updatedRun = db.runs.getRunById(run.id)!;
    assert.equal(updatedIssue.activeRunId, undefined);
    assert.equal(updatedRun.status, "superseded");
    assert.equal(updatedRun.failureReason, "authority revoked before run completion");
    assert.equal(updatedRun.completionCheckOutcome, undefined);
    assert.match(String(feedEvents.at(-1)?.summary ?? ""), /authority revoked before run completion/);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("run finalizer accepts a review-fix verifier result despite a stale workflow projection", async () => {
  const { baseDir, db } = createDb();
  try {
    const issue = db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-1",
      issueKey: "USE-111B",
      title: "Fix requested review changes",
      workflowOutcome: undefined,
      delegatedToPatchRelay: true,
      prNumber: 42,
      prState: "open",
      prReviewState: "changes_requested",
      prHeadSha: "sha-blocked",
      lastBlockingReviewHeadSha: "sha-blocked",
    });
    reconcileWorkflowTasksForIssue(db, issue);
    const task = db.workflowTasks.getTask(issue.projectId, issue.linearIssueId, "run:review_fix");
    assert.equal(task?.gateAction, "start");
    const run = db.runs.createRun({
      issueId: issue.id,
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      runType: "review_fix",
      sourceHeadSha: "sha-blocked",
    });
    db.runs.updateRunThread(run.id, { threadId: "thread-1", turnId: "turn-main" });
    db.upsertIssue({
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      activeRunId: run.id,
    });
    reconcileWorkflowTasksForIssue(db, db.getIssue(issue.projectId, issue.linearIssueId)!);

    const { finalizer } = createFinalizer(db, {
      outcome: "done",
      summary: "unused",
    }, {
      publishedOutcomeError: null,
    });

    await finalizer.finalizeCompletedRun({
      source: "notification",
      run: db.runs.getRunById(run.id)!,
      issue: db.getIssue(issue.projectId, issue.linearIssueId)!,
      thread: {
        id: "thread-1",
        preview: "",
        cwd: "/tmp/work",
        status: "idle",
        turns: [
          {
            id: "turn-main",
            status: "completed",
            items: [{ id: "msg-1", type: "agentMessage", text: "I addressed the review." }],
          },
        ],
      },
      threadId: "thread-1",
      completedTurnId: "turn-main",
    });

    const updatedIssue = db.getIssue(issue.projectId, issue.linearIssueId)!;
    const updatedRun = db.runs.getRunById(run.id)!;
    assert.notEqual(updatedIssue.workflowOutcome, "escalated");
    assert.equal(updatedIssue.activeRunId, undefined);
    assert.equal(updatedRun.status, "completed");
    assert.equal(updatedRun.failureReason, undefined);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("run finalizer escalates a review fix only when the verifier rejects it", async () => {
  const { baseDir, db } = createDb();
  try {
    const issue = db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-1",
      issueKey: "USE-111V",
      title: "Fix requested review changes",
      workflowOutcome: undefined,
      delegatedToPatchRelay: true,
      prNumber: 42,
      prState: "open",
      prReviewState: "changes_requested",
      prHeadSha: "sha-blocked",
      lastBlockingReviewHeadSha: "sha-blocked",
    });
    const run = db.runs.createRun({
      issueId: issue.id,
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      runType: "review_fix",
      sourceHeadSha: "sha-blocked",
    });
    db.runs.updateRunThread(run.id, { threadId: "thread-1", turnId: "turn-main" });
    db.upsertIssue({
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      activeRunId: run.id,
    });

    const verificationError = "Requested-changes run finished for PR #42 without pushing a new head past blocking review SHA sha-bloc; PatchRelay must not hand the same SHA back to review.";
    const { finalizer } = createFinalizer(db, {
      outcome: "done",
      summary: "unused",
    }, {
      reviewFixAdvanceError: verificationError,
      publishedOutcomeError: null,
      failRunAndClear: (runId, message, nextState) => {
        db.runs.finishRun(runId, { status: "failed", failureReason: message });
        db.upsertIssue({
          projectId: issue.projectId,
          linearIssueId: issue.linearIssueId,
          activeRunId: null,
          workflowOutcome: nextState ?? "failed",
        });
      },
    });

    await finalizer.finalizeCompletedRun({
      source: "notification",
      run: db.runs.getRunById(run.id)!,
      issue: db.getIssue(issue.projectId, issue.linearIssueId)!,
      thread: {
        id: "thread-1",
        preview: "",
        cwd: "/tmp/work",
        status: "idle",
        turns: [{ id: "turn-main", status: "completed", items: [{ id: "msg-1", type: "agentMessage", text: "I addressed the review." }] }],
      },
      threadId: "thread-1",
      completedTurnId: "turn-main",
    });

    const updatedIssue = db.getIssue(issue.projectId, issue.linearIssueId)!;
    const updatedRun = db.runs.getRunById(run.id)!;
    assertIssuePhase(updatedIssue, "escalated");
    assert.equal(updatedRun.status, "failed");
    assert.equal(updatedRun.failureReason, verificationError);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("run finalizer summarizes task-backed review blocker in Linear activity", async () => {
  const { baseDir, db } = createDb();
  try {
    const issue = db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-1",
      issueKey: "USE-111R",
      title: "Fix requested review changes",
      workflowOutcome: undefined,
      delegatedToPatchRelay: true,
      prNumber: 42,
      prState: "open",
      prReviewState: "changes_requested",
      prHeadSha: "sha-blocked",
      lastBlockingReviewHeadSha: "sha-blocked",
    });
    db.workflowTasks.reconcileTasks({
      projectId: issue.projectId,
      subjectId: issue.linearIssueId,
      tasks: [{
        task: {
          id: "run:review_fix",
          type: "run",
          runType: "review_fix",
          reason: "PR has requested changes",
          requirements: {
            blockingHeadSha: "sha-blocked",
            requestedChangesHeadSha: "sha-blocked",
            reviewerName: "review-quill[bot]",
            reviewBody: "**Verdict: 🛑 Request changes** — Request changes because website video generation currently records usage against the image billing meter.",
          },
        },
        authorityEpoch: 0,
        gateAction: "start",
      }],
    });
    const run = db.runs.createRun({
      issueId: issue.id,
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      runType: "review_fix",
      sourceHeadSha: "sha-blocked",
    });
    db.runs.updateRunThread(run.id, { threadId: "thread-1", turnId: "turn-main" });
    db.upsertIssue({
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      activeRunId: run.id,
      prHeadSha: "sha-fixed",
    });
    db.workflowTasks.reconcileTasks({
      projectId: issue.projectId,
      subjectId: issue.linearIssueId,
      tasks: [],
    });

    const { finalizer, activities } = createFinalizer(db, {
      outcome: "done",
      summary: "unused",
    }, {
      publishedOutcomeError: null,
    });

    await finalizer.finalizeCompletedRun({
      source: "notification",
      run: db.runs.getRunById(run.id)!,
      issue: db.getIssue(issue.projectId, issue.linearIssueId)!,
      thread: {
        id: "thread-1",
        preview: "",
        cwd: "/tmp/work",
        status: "idle",
        turns: [
          {
            id: "turn-main",
            status: "completed",
            items: [{ id: "msg-1", type: "agentMessage", text: "I fixed the review blocker." }],
          },
        ],
      },
      threadId: "thread-1",
      completedTurnId: "turn-main",
    });

    const updatedRun = db.runs.getRunById(run.id)!;
    const parsedSummary = JSON.parse(updatedRun.summaryJson ?? "{}") as Record<string, unknown>;
    assert.equal(
      parsedSummary.outcomeSummary,
      "Website video generation currently records usage against the image billing meter.",
    );
    assert.equal(
      activities.at(-1)?.body,
      [
        "Review round 1 completed.",
        "",
        "Addressed:",
        "- Website video generation currently records usage against the image billing meter.",
      ].join("\n"),
    );
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("run finalizer requeues task-backed CI repairs that do not advance the failing head", async () => {
  const { baseDir, db } = createDb();
  try {
    const issue = db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-1",
      issueKey: "USE-111C",
      title: "Fix failing CI",
      workflowOutcome: undefined,
      delegatedToPatchRelay: true,
      prNumber: 42,
      prState: "open",
      prHeadSha: "sha-failing",
      prCheckStatus: "failed",
      lastGitHubFailureSource: "branch_ci",
      lastGitHubFailureHeadSha: "sha-failing",
      lastGitHubFailureSignature: "ci:verify",
    });
    reconcileWorkflowTasksForIssue(db, issue);
    const task = db.workflowTasks.getTask(issue.projectId, issue.linearIssueId, "run:ci_repair");
    assert.equal(task?.gateAction, "start");
    const run = db.runs.createRun({
      issueId: issue.id,
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      runType: "ci_repair",
      sourceHeadSha: "sha-failing",
    });
    db.runs.updateRunThread(run.id, { threadId: "thread-1", turnId: "turn-main" });
    db.upsertIssue({
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      activeRunId: run.id,
    });
    reconcileWorkflowTasksForIssue(db, db.getIssue(issue.projectId, issue.linearIssueId)!);

    let failedMessage: string | undefined;
    let failedNextState: WorkflowOutcome | undefined;
    const { finalizer, feedEvents, enqueueCalls } = createFinalizer(db, {
      outcome: "done",
      summary: "unused",
    }, {
      publishedOutcomeError: null,
      reactiveAdvanceError: "Repair finished but PR #42 is still on failing head sha-fail",
      failRunAndClear: (runId, message, nextState) => {
        failedMessage = message;
        failedNextState = nextState;
        db.runs.finishRun(runId, { status: "failed", failureReason: message });
        db.upsertIssue({
          projectId: issue.projectId,
          linearIssueId: issue.linearIssueId,
          activeRunId: null,
          workflowOutcome: nextState ?? "failed",
        });
      },
    });

    await finalizer.finalizeCompletedRun({
      source: "notification",
      run: db.runs.getRunById(run.id)!,
      issue: db.getIssue(issue.projectId, issue.linearIssueId)!,
      thread: {
        id: "thread-1",
        preview: "",
        cwd: "/tmp/work",
        status: "idle",
        turns: [
          {
            id: "turn-main",
            status: "completed",
            items: [{ id: "msg-1", type: "agentMessage", text: "I fixed CI." }],
          },
        ],
      },
      threadId: "thread-1",
      completedTurnId: "turn-main",
    });

    const updatedIssue = db.getIssue(issue.projectId, issue.linearIssueId)!;
    const updatedRun = db.runs.getRunById(run.id)!;
    const retryTask = db.workflowTasks.getTask(issue.projectId, issue.linearIssueId, "run:ci_repair");
    assert.equal(failedMessage, undefined);
    assert.equal(failedNextState, undefined);
    assertIssuePhase(updatedIssue, "repairing_ci");
    assert.equal(updatedIssue.activeRunId, undefined);
    assert.equal(updatedIssue.lastAttemptedFailureHeadSha, undefined);
    assert.equal(updatedIssue.lastAttemptedFailureSignature, undefined);
    assert.equal(updatedRun.status, "failed");
    assert.equal(updatedRun.failureReason, "Repair finished but PR #42 is still on failing head sha-fail");
    assert.equal(updatedRun.completionCheckOutcome, undefined);
    assert.equal(feedEvents.at(-1)?.status, "branch_not_advanced");
    assert.equal(retryTask?.gateAction, "start");
    assert.deepEqual(enqueueCalls, [{ projectId: issue.projectId, issueId: issue.linearIssueId }]);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("run finalizer requeues task-backed queue repairs that do not advance the failing head", async () => {
  const { baseDir, db } = createDb();
  try {
    const issue = db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-1",
      issueKey: "USE-111Q",
      title: "Recover from merge queue eviction",
      workflowOutcome: undefined,
      delegatedToPatchRelay: true,
      prNumber: 42,
      prState: "open",
      prHeadSha: "sha-failing",
      prCheckStatus: "failed",
      lastGitHubFailureSource: "queue_eviction",
      lastGitHubFailureHeadSha: "sha-failing",
      lastGitHubFailureSignature: "queue:evicted",
    });
    reconcileWorkflowTasksForIssue(db, issue);
    const task = db.workflowTasks.getTask(issue.projectId, issue.linearIssueId, "run:queue_repair");
    assert.equal(task?.gateAction, "start");
    const run = db.runs.createRun({
      issueId: issue.id,
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      runType: "queue_repair",
      sourceHeadSha: "sha-failing",
    });
    db.runs.updateRunThread(run.id, { threadId: "thread-1", turnId: "turn-main" });
    db.upsertIssue({
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      activeRunId: run.id,
    });
    reconcileWorkflowTasksForIssue(db, db.getIssue(issue.projectId, issue.linearIssueId)!);

    let failedMessage: string | undefined;
    let failedNextState: WorkflowOutcome | undefined;
    const { finalizer, feedEvents, enqueueCalls } = createFinalizer(db, {
      outcome: "done",
      summary: "unused",
    }, {
      publishedOutcomeError: null,
      reactiveAdvanceError: "Repair finished but PR #42 is still on failing head sha-fail",
      failRunAndClear: (runId, message, nextState) => {
        failedMessage = message;
        failedNextState = nextState;
        db.runs.finishRun(runId, { status: "failed", failureReason: message });
        db.upsertIssue({
          projectId: issue.projectId,
          linearIssueId: issue.linearIssueId,
          activeRunId: null,
          workflowOutcome: nextState ?? "failed",
        });
      },
    });

    await finalizer.finalizeCompletedRun({
      source: "notification",
      run: db.runs.getRunById(run.id)!,
      issue: db.getIssue(issue.projectId, issue.linearIssueId)!,
      thread: {
        id: "thread-1",
        preview: "",
        cwd: "/tmp/work",
        status: "idle",
        turns: [
          {
            id: "turn-main",
            status: "completed",
            items: [{ id: "msg-1", type: "agentMessage", text: "I fixed queue eviction." }],
          },
        ],
      },
      threadId: "thread-1",
      completedTurnId: "turn-main",
    });

    const updatedIssue = db.getIssue(issue.projectId, issue.linearIssueId)!;
    const updatedRun = db.runs.getRunById(run.id)!;
    const retryTask = db.workflowTasks.getTask(issue.projectId, issue.linearIssueId, "run:queue_repair");
    assert.equal(failedMessage, undefined);
    assert.equal(failedNextState, undefined);
    assertIssuePhase(updatedIssue, "repairing_queue");
    assert.equal(updatedIssue.activeRunId, undefined);
    assert.equal(updatedIssue.lastAttemptedFailureHeadSha, undefined);
    assert.equal(updatedIssue.lastAttemptedFailureSignature, undefined);
    assert.equal(updatedRun.status, "failed");
    assert.equal(updatedRun.failureReason, "Repair finished but PR #42 is still on failing head sha-fail");
    assert.equal(updatedRun.completionCheckOutcome, undefined);
    assert.equal(feedEvents.at(-1)?.status, "branch_not_advanced");
    assert.equal(retryTask?.gateAction, "start");
    assert.deepEqual(enqueueCalls, [{ projectId: issue.projectId, issueId: issue.linearIssueId }]);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("run finalizer queues a same-thread follow-up when completion check says continue", async () => {
  const { baseDir, db } = createDb();
  try {
    const issue = db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-1",
      issueKey: "USE-111",
      title: "Harden worker security headers",
      workflowOutcome: undefined,
    });
    const run = db.runs.createRun({
      issueId: issue.id,
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      runType: "implementation",
    });
    db.runs.updateRunThread(run.id, { threadId: "thread-1", turnId: "turn-main" });

    const { finalizer } = createFinalizer(db, {
      outcome: "continue",
      summary: "The run stopped early and PatchRelay can keep going automatically.",
    });

    await finalizer.finalizeCompletedRun({
      source: "notification",
      run: db.runs.getRunById(run.id)!,
      issue: db.getIssue(issue.projectId, issue.linearIssueId)!,
      thread: {
        id: "thread-1",
        preview: "",
        cwd: "/tmp/work",
        status: "idle",
        turns: [
          {
            id: "turn-main",
            status: "completed",
            items: [{ id: "msg-1", type: "agentMessage", text: "I have more to do here." }],
          },
        ],
      },
      threadId: "thread-1",
      completedTurnId: "turn-main",
    });

    const updatedIssue = db.getIssue(issue.projectId, issue.linearIssueId)!;
    const workflowTask = db.issueSessions.peekPendingSessionInputPlanForDiagnostics(issue.projectId, issue.linearIssueId);
    const pendingEvent = db.issueSessions.listIssueSessionEvents(issue.projectId, issue.linearIssueId, { pendingOnly: true }).at(-1);
    assertIssuePhase(updatedIssue, "delegated");
    assert.equal(db.runs.getRunById(run.id)?.completionCheckOutcome, "continue");
    assert.equal(workflowTask?.runType, "implementation");
    assert.equal(workflowTask?.resumeThread, true);
    assert.equal(pendingEvent?.eventType, "completion_check_continue");
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("run finalizer re-enqueues a pending requested-changes workflowTask after the active run finishes", async () => {
  const { baseDir, db } = createDb();
  try {
    const issue = db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-1",
      issueKey: "USE-111A",
      title: "Finish implementation before replaying review work",
      workflowOutcome: undefined,
      prNumber: 41,
      prState: "open",
      prReviewState: "changes_requested",
      prHeadSha: "sha-before-finish",
    });
    const run = db.runs.createRun({
      issueId: issue.id,
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      runType: "implementation",
    });
    db.runs.updateRunThread(run.id, { threadId: "thread-1", turnId: "turn-main" });
    db.upsertIssue({
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      activeRunId: run.id,
    });
    db.issueSessions.appendIssueSessionEventRespectingActiveLease(issue.projectId, issue.linearIssueId, {
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      eventType: "review_changes_requested",
      eventJson: JSON.stringify({
        reviewBody: "Please revise the migration before merge.",
        reviewCommitId: "sha-before-finish",
        reviewId: 91,
        reviewerName: "reviewbot",
      }),
      dedupeKey: "review_changes_requested::sha-before-finish::reviewbot",
    });

    const { finalizer, enqueueCalls, feedEvents } = createFinalizer(db, {
      outcome: "done",
      summary: "The main repair PR is published and ready for downstream automation.",
    }, {
      publishedOutcomeError: null,
    });

    await finalizer.finalizeCompletedRun({
      source: "notification",
      run: db.runs.getRunById(run.id)!,
      issue: db.getIssue(issue.projectId, issue.linearIssueId)!,
      thread: {
        id: "thread-1",
        preview: "",
        cwd: "/tmp/work",
        status: "idle",
        turns: [
          {
            id: "turn-main",
            status: "completed",
            items: [{ id: "msg-1", type: "agentMessage", text: "The repair PR is published." }],
          },
        ],
      },
      threadId: "thread-1",
      completedTurnId: "turn-main",
    });

    const updatedIssue = db.getIssue(issue.projectId, issue.linearIssueId)!;
    const workflowTask = db.issueSessions.peekPendingSessionInputPlanForDiagnostics(issue.projectId, issue.linearIssueId);
    assert.equal(updatedIssue.activeRunId, undefined);
    assertIssuePhase(updatedIssue, "changes_requested");
    assert.equal(workflowTask?.runType, "review_fix");
    assert.deepEqual(enqueueCalls, [{ projectId: "usertold", issueId: "issue-1" }]);
    assert.equal(feedEvents.at(-1)?.status, "deferred_follow_up_queued");
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("run finalizer continues automatically when no-PR done leaves local changes unpublished", async () => {
  const { baseDir, db } = createDb();
  try {
    const issue = db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-1",
      issueKey: "USE-112A",
      title: "Publish local changes before closing the issue",
      workflowOutcome: undefined,
    });
    const run = db.runs.createRun({
      issueId: issue.id,
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      runType: "implementation",
    });
    db.runs.updateRunThread(run.id, { threadId: "thread-1", turnId: "turn-main" });

    const { finalizer, feedEvents } = createFinalizer(db, {
      outcome: "done",
      summary: "The requested code changes are finished.",
    }, {
      publishedOutcomeError: "Implementation completed without opening a PR; worktree still has 2 uncommitted change(s)",
    });

    await finalizer.finalizeCompletedRun({
      source: "notification",
      run: db.runs.getRunById(run.id)!,
      issue: db.getIssue(issue.projectId, issue.linearIssueId)!,
      thread: {
        id: "thread-1",
        preview: "",
        cwd: "/tmp/work",
        status: "idle",
        turns: [
          {
            id: "turn-main",
            status: "completed",
            items: [{ id: "msg-1", type: "agentMessage", text: "I made the code changes locally." }],
          },
        ],
      },
      threadId: "thread-1",
      completedTurnId: "turn-main",
    });

    const updatedIssue = db.getIssue(issue.projectId, issue.linearIssueId)!;
    const updatedRun = db.runs.getRunById(run.id)!;
    const workflowTask = db.issueSessions.peekPendingSessionInputPlanForDiagnostics(issue.projectId, issue.linearIssueId);
    const pendingEvent = db.issueSessions.listIssueSessionEvents(issue.projectId, issue.linearIssueId, { pendingOnly: true }).at(-1);
    assertIssuePhase(updatedIssue, "delegated");
    assert.equal(updatedRun.status, "completed");
    assert.equal(updatedRun.completionCheckOutcome, "continue");
    assert.match(String(updatedRun.completionCheckSummary ?? ""), /has not published them yet/);
    assert.equal(workflowTask?.runType, "implementation");
    assert.equal(workflowTask?.resumeThread, true);
    assert.equal(pendingEvent?.eventType, "completion_check_continue");
    assert.equal(feedEvents.at(-1)?.status, "completion_check_continue");
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("run finalizer marks no-PR completion checks done when the fork confirms delivery", async () => {
  const { baseDir, db } = createDb();
  try {
    const issue = db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-1",
      issueKey: "USE-112",
      title: "Write rollout summary in Linear only",
      workflowOutcome: undefined,
    });
    const run = db.runs.createRun({
      issueId: issue.id,
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      runType: "implementation",
    });
    db.runs.updateRunThread(run.id, { threadId: "thread-1", turnId: "turn-main" });

    const { finalizer, feedEvents, activities } = createFinalizer(db, {
      outcome: "done",
      summary: "Created the requested follow-up Linear issues and no PR was needed.",
    });

    await finalizer.finalizeCompletedRun({
      source: "notification",
      run: db.runs.getRunById(run.id)!,
      issue: db.getIssue(issue.projectId, issue.linearIssueId)!,
      thread: {
        id: "thread-1",
        preview: "",
        cwd: "/tmp/work",
        status: "idle",
        turns: [
          {
            id: "turn-main",
            status: "completed",
            items: [{ id: "msg-1", type: "agentMessage", text: "The Linear deliverables are complete." }],
          },
        ],
      },
      threadId: "thread-1",
      completedTurnId: "turn-main",
    });

    const updatedIssue = db.getIssue(issue.projectId, issue.linearIssueId)!;
    const updatedRun = db.runs.getRunById(run.id)!;
    assertIssuePhase(updatedIssue, "done");
    assert.equal(updatedRun.status, "completed");
    assert.equal(updatedRun.completionCheckOutcome, "done");
    assert.equal(feedEvents.at(-1)?.status, "completion_check_done");
    assert.match(String(activities.at(-1)?.body ?? ""), /Completed without a PR/);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});
test("run finalizer fails no-PR completion checks when the fork says the run stopped incorrectly", async () => {
  const { baseDir, db } = createDb();
  try {
    const issue = db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-1",
      issueKey: "USE-113",
      title: "Finish task or fail clearly",
      workflowOutcome: undefined,
    });
    const run = db.runs.createRun({
      issueId: issue.id,
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      runType: "implementation",
    });
    db.runs.updateRunThread(run.id, { threadId: "thread-1", turnId: "turn-main" });

    const { finalizer, feedEvents } = createFinalizer(db, {
      outcome: "failed",
      summary: "The task stopped before publishing and should not auto-continue.",
    });

    await finalizer.finalizeCompletedRun({
      source: "notification",
      run: db.runs.getRunById(run.id)!,
      issue: db.getIssue(issue.projectId, issue.linearIssueId)!,
      thread: {
        id: "thread-1",
        preview: "",
        cwd: "/tmp/work",
        status: "idle",
        turns: [
          {
            id: "turn-main",
            status: "completed",
            items: [{ id: "msg-1", type: "agentMessage", text: "I stopped early." }],
          },
        ],
      },
      threadId: "thread-1",
      completedTurnId: "turn-main",
    });

    const updatedIssue = db.getIssue(issue.projectId, issue.linearIssueId)!;
    const updatedRun = db.runs.getRunById(run.id)!;
    const workflowTask = db.issueSessions.peekPendingSessionInputPlanForDiagnostics(issue.projectId, issue.linearIssueId);
    assertIssuePhase(updatedIssue, "failed");
    assert.equal(updatedRun.status, "failed");
    assert.equal(updatedRun.completionCheckOutcome, "failed");
    assert.equal(workflowTask, undefined);
    assert.equal(feedEvents.at(-1)?.status, "completion_check_failed");
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("run finalizer recovers failed implementation turns when unpublished local work exists", async () => {
  const { baseDir, db } = createDb();
  try {
    const issue = db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-1",
      issueKey: "USE-114",
      title: "Recover failed implementation publication",
      workflowOutcome: undefined,
    });
    const run = db.runs.createRun({
      issueId: issue.id,
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      runType: "implementation",
    });
    db.runs.updateRunThread(run.id, { threadId: "thread-1", turnId: "turn-main" });

    const { finalizer, feedEvents } = createFinalizer(db, {
      outcome: "continue",
      summary: "PatchRelay can keep going and publish the local work.",
    }, {
      failedRecoveryError: "Implementation completed without opening a PR; worktree still has 3 uncommitted change(s)",
    });

    const recovered = await finalizer.recoverFailedImplementationRun({
      run: db.runs.getRunById(run.id)!,
      issue: db.getIssue(issue.projectId, issue.linearIssueId)!,
      thread: {
        id: "thread-1",
        preview: "",
        cwd: "/tmp/work",
        status: "idle",
        turns: [
          {
            id: "turn-main",
            status: "failed",
            items: [{ id: "msg-1", type: "agentMessage", text: "I changed files locally before the turn failed." }],
          },
        ],
      },
      threadId: "thread-1",
      completedTurnId: "turn-main",
      failureReason: "Codex reported the turn completed in a failed state",
    });

    const updatedIssue = db.getIssue(issue.projectId, issue.linearIssueId)!;
    const updatedRun = db.runs.getRunById(run.id)!;
    const workflowTask = db.issueSessions.peekPendingSessionInputPlanForDiagnostics(issue.projectId, issue.linearIssueId);
    assert.equal(recovered, true);
    assertIssuePhase(updatedIssue, "delegated");
    assert.equal(updatedRun.status, "failed");
    assert.equal(updatedRun.failureReason, "Codex reported the turn completed in a failed state");
    assert.equal(updatedRun.completionCheckOutcome, "continue");
    assert.equal(workflowTask?.runType, "implementation");
    assert.equal(workflowTask?.resumeThread, true);
    assert.equal(feedEvents.at(-1)?.status, "completion_check_continue");
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("run finalizer leaves failed implementation turns alone when no unpublished work is detected", async () => {
  const { baseDir, db } = createDb();
  try {
    const issue = db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-1",
      issueKey: "USE-115",
      title: "Do not recover clean failed implementation turns",
      workflowOutcome: undefined,
    });
    const run = db.runs.createRun({
      issueId: issue.id,
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      runType: "implementation",
    });
    db.runs.updateRunThread(run.id, { threadId: "thread-1", turnId: "turn-main" });

    const { finalizer } = createFinalizer(db, {
      outcome: "continue",
      summary: "unused",
    });

    const recovered = await finalizer.recoverFailedImplementationRun({
      run: db.runs.getRunById(run.id)!,
      issue: db.getIssue(issue.projectId, issue.linearIssueId)!,
      thread: {
        id: "thread-1",
        preview: "",
        cwd: "/tmp/work",
        status: "idle",
        turns: [
          {
            id: "turn-main",
            status: "failed",
            items: [],
          },
        ],
      },
      threadId: "thread-1",
      completedTurnId: "turn-main",
      failureReason: "Codex reported the turn completed in a failed state",
    });

    const updatedRun = db.runs.getRunById(run.id)!;
    const workflowTask = db.issueSessions.peekPendingSessionInputPlanForDiagnostics(issue.projectId, issue.linearIssueId);
    assert.equal(recovered, false);
    assert.equal(updatedRun.status, "running");
    assert.equal(updatedRun.completionCheckOutcome, undefined);
    assert.equal(workflowTask, undefined);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("run finalizer builds Linear-visible completion text without an extra recap turn", async () => {
  const { baseDir, db } = createDb();
  try {
    const issue = db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-1",
      issueKey: "USE-116",
      title: "Publish concise Linear recap",
      workflowOutcome: undefined,
      prNumber: 42,
      prState: "open",
    });
    db.issueSessions.appendIssueSessionEvent({
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      eventType: "review_changes_requested",
      eventJson: JSON.stringify({
        reviewerName: "Ada",
        reviewBody: "Please tighten the publishing summary.",
      }),
    });
    const workflowTask = db.issueSessions.peekPendingSessionInputPlanForDiagnostics(issue.projectId, issue.linearIssueId);
    const run = db.runs.createRun({
      issueId: issue.id,
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      runType: "review_fix",
    });
    db.issueSessions.consumeIssueSessionEvents(issue.projectId, issue.linearIssueId, workflowTask?.eventIds ?? [], run.id);
    db.issueSessions.setIssueSessionLastWorkflowReason(issue.projectId, issue.linearIssueId, workflowTask?.workflowReason ?? null);
    db.runs.updateRunThread(run.id, { threadId: "thread-1", turnId: "turn-main" });

    const { finalizer, activities, feedEvents } = createFinalizer(db, {
      outcome: "done",
      summary: "unused",
    }, {
      publishedOutcomeError: null,
    });

    await finalizer.finalizeCompletedRun({
      source: "notification",
      run: db.runs.getRunById(run.id)!,
      issue: db.getIssue(issue.projectId, issue.linearIssueId)!,
      thread: {
        id: "thread-1",
        preview: "",
        cwd: "/tmp/work",
        status: "idle",
        turns: [
          {
            id: "turn-main",
            status: "completed",
            items: [
              {
                id: "msg-1",
                type: "agentMessage",
                text: "Updated the PR, reran the relevant checks, and adjusted the copy to match the requested review changes in detail.",
              },
            ],
          },
        ],
      },
      threadId: "thread-1",
      completedTurnId: "turn-main",
    });

    const updatedRun = db.runs.getRunById(run.id)!;
    const parsedSummary = JSON.parse(updatedRun.summaryJson ?? "{}") as Record<string, unknown>;
    assert.equal(
      parsedSummary.outcomeSummary,
      "Publishing summary tightened.",
    );
    assert.equal(parsedSummary.publicationRecapSummary, undefined);
    assert.equal(
      activities.at(-1)?.body,
      [
        "Review round 1 completed.",
        "",
        "Addressed:",
        "- Publishing summary tightened.",
      ].join("\n"),
    );
    assert.equal(
      feedEvents.at(-1)?.detail,
      "Publishing summary tightened.",
    );
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});
