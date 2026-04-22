import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import pino from "pino";
import { PatchRelayDatabase } from "../src/db.ts";
import { RunFinalizer } from "../src/run-finalizer.ts";

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
  publicationRecapSummary?: string;
  onEnqueue?: (projectId: string, issueId: string) => void;
}) {
  const feedEvents: Array<Record<string, unknown>> = [];
  const activities: Array<Record<string, unknown>> = [];
  const enqueueCalls: Array<{ projectId: string; issueId: string }> = [];
  const lease = acquireLease(db, "usertold", "issue-1");
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
    (projectId, issueId) => {
      enqueueCalls.push({ projectId, issueId });
      options?.onEnqueue?.(projectId, issueId);
    },
    (_projectId, _linearIssueId, fn) => fn(lease as never),
    () => db.issueSessions.releaseIssueSessionLease(lease.projectId, lease.linearIssueId, lease.leaseId),
    () => true,
    () => {
      throw new Error("failRunAndClear should not be called in completion-check tests");
    },
    {
      verifyReactiveRunAdvancedBranch: async () => undefined,
      verifyReviewFixAdvancedHead: async () => undefined,
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
    options?.publicationRecapSummary
      ? {
          run: async () => ({
            threadId: "fork-publication-1",
            turnId: "turn-publication-1",
            summary: options.publicationRecapSummary!,
          }),
        }
      : undefined,
    {
      publish(event) {
        feedEvents.push(event as unknown as Record<string, unknown>);
        return event as never;
      },
    } as never,
  );
  return { finalizer, feedEvents, activities, enqueueCalls };
}

test("run finalizer moves no-PR runs into awaiting_input when completion check needs input", async () => {
  const { baseDir, db } = createDb();
  try {
    const issue = db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-1",
      issueKey: "USE-110",
      title: "Harden worker security headers",
      factoryState: "implementing",
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
      resolveRecoverableRunState: () => undefined,
    });

    const updatedIssue = db.getIssue(issue.projectId, issue.linearIssueId)!;
    const updatedRun = db.runs.getRunById(run.id)!;
    assert.equal(updatedIssue.factoryState, "awaiting_input");
    assert.equal(updatedRun.status, "completed");
    assert.equal(updatedRun.completionCheckOutcome, "needs_input");
    assert.equal(updatedRun.completionCheckQuestion, "Approve routing /v1/* through the worker?");
    assert.equal(feedEvents.at(-1)?.status, "completion_check_needs_input");
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
      factoryState: "implementing",
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
      resolveRecoverableRunState: () => undefined,
    });

    const updatedIssue = db.getIssue(issue.projectId, issue.linearIssueId)!;
    const wake = db.issueSessions.peekIssueSessionWake(issue.projectId, issue.linearIssueId);
    const pendingEvent = db.issueSessions.listIssueSessionEvents(issue.projectId, issue.linearIssueId, { pendingOnly: true }).at(-1);
    assert.equal(updatedIssue.factoryState, "delegated");
    assert.equal(db.runs.getRunById(run.id)?.completionCheckOutcome, "continue");
    assert.equal(wake?.runType, "implementation");
    assert.equal(wake?.resumeThread, true);
    assert.equal(pendingEvent?.eventType, "completion_check_continue");
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("run finalizer re-enqueues a pending requested-changes wake after the active run finishes", async () => {
  const { baseDir, db } = createDb();
  try {
    const issue = db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-1",
      issueKey: "USE-111A",
      title: "Finish main repair before replaying review work",
      factoryState: "implementing",
      prNumber: 41,
      prState: "open",
      prReviewState: "changes_requested",
      prHeadSha: "sha-before-finish",
    });
    const run = db.runs.createRun({
      issueId: issue.id,
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      runType: "main_repair",
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
      resolveRecoverableRunState: () => undefined,
    });

    const updatedIssue = db.getIssue(issue.projectId, issue.linearIssueId)!;
    const wake = db.issueSessions.peekIssueSessionWake(issue.projectId, issue.linearIssueId);
    assert.equal(updatedIssue.activeRunId, undefined);
    assert.equal(updatedIssue.factoryState, "pr_open");
    assert.equal(wake?.runType, "review_fix");
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
      factoryState: "implementing",
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
      resolveRecoverableRunState: () => undefined,
    });

    const updatedIssue = db.getIssue(issue.projectId, issue.linearIssueId)!;
    const updatedRun = db.runs.getRunById(run.id)!;
    const wake = db.issueSessions.peekIssueSessionWake(issue.projectId, issue.linearIssueId);
    const pendingEvent = db.issueSessions.listIssueSessionEvents(issue.projectId, issue.linearIssueId, { pendingOnly: true }).at(-1);
    assert.equal(updatedIssue.factoryState, "delegated");
    assert.equal(updatedRun.status, "completed");
    assert.equal(updatedRun.completionCheckOutcome, "continue");
    assert.match(String(updatedRun.completionCheckSummary ?? ""), /has not published them yet/);
    assert.equal(wake?.runType, "implementation");
    assert.equal(wake?.resumeThread, true);
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
      factoryState: "implementing",
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
      resolveRecoverableRunState: () => undefined,
    });

    const updatedIssue = db.getIssue(issue.projectId, issue.linearIssueId)!;
    const updatedRun = db.runs.getRunById(run.id)!;
    assert.equal(updatedIssue.factoryState, "done");
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
      factoryState: "implementing",
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
      resolveRecoverableRunState: () => undefined,
    });

    const updatedIssue = db.getIssue(issue.projectId, issue.linearIssueId)!;
    const updatedRun = db.runs.getRunById(run.id)!;
    const wake = db.issueSessions.peekIssueSessionWake(issue.projectId, issue.linearIssueId);
    assert.equal(updatedIssue.factoryState, "failed");
    assert.equal(updatedRun.status, "failed");
    assert.equal(updatedRun.completionCheckOutcome, "failed");
    assert.equal(wake, undefined);
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
      factoryState: "implementing",
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
    const wake = db.issueSessions.peekIssueSessionWake(issue.projectId, issue.linearIssueId);
    assert.equal(recovered, true);
    assert.equal(updatedIssue.factoryState, "delegated");
    assert.equal(updatedRun.status, "failed");
    assert.equal(updatedRun.failureReason, "Codex reported the turn completed in a failed state");
    assert.equal(updatedRun.completionCheckOutcome, "continue");
    assert.equal(wake?.runType, "implementation");
    assert.equal(wake?.resumeThread, true);
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
      factoryState: "implementing",
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
    const wake = db.issueSessions.peekIssueSessionWake(issue.projectId, issue.linearIssueId);
    assert.equal(recovered, false);
    assert.equal(updatedRun.status, "running");
    assert.equal(updatedRun.completionCheckOutcome, undefined);
    assert.equal(wake, undefined);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("run finalizer prefers the separate publication recap for Linear-visible completion text", async () => {
  const { baseDir, db } = createDb();
  try {
    const issue = db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-1",
      issueKey: "USE-116",
      title: "Publish concise Linear recap",
      factoryState: "implementing",
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
    const wake = db.issueSessions.peekIssueSessionWake(issue.projectId, issue.linearIssueId);
    const run = db.runs.createRun({
      issueId: issue.id,
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      runType: "review_fix",
    });
    db.issueSessions.consumeIssueSessionEvents(issue.projectId, issue.linearIssueId, wake?.eventIds ?? [], run.id);
    db.issueSessions.setIssueSessionLastWakeReason(issue.projectId, issue.linearIssueId, wake?.wakeReason ?? null);
    db.runs.updateRunThread(run.id, { threadId: "thread-1", turnId: "turn-main" });

    const { finalizer, activities, feedEvents } = createFinalizer(db, {
      outcome: "done",
      summary: "unused",
    }, {
      publishedOutcomeError: null,
      publicationRecapSummary: "Addressed the requested publishing-summary feedback and updated PR #42.",
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
      resolveRecoverableRunState: () => undefined,
    });

    const updatedRun = db.runs.getRunById(run.id)!;
    const parsedSummary = JSON.parse(updatedRun.summaryJson ?? "{}") as Record<string, unknown>;
    assert.equal(parsedSummary.publicationRecapSummary, "Addressed the requested publishing-summary feedback and updated PR #42.");
    assert.equal(
      activities.at(-1)?.body,
      "Updated PR #42 to address review feedback. Addressed the requested publishing-summary feedback and updated PR #42.",
    );
    assert.equal(feedEvents.at(-1)?.detail, "Addressed the requested publishing-summary feedback and updated PR #42.");
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});
