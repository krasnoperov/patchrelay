import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { PatchRelayDatabase } from "../src/db.ts";
import type { IssueRecord } from "../src/db-types.ts";
import { reconcileWorkflowTasksForIssue } from "../src/workflow-task-reconciler.ts";

// S5 inbox tasks: durable human-input / completion-check / orchestration
// child-update signals become run:input / run:orchestration_followup tasks,
// with exactly-once consumption via workflow.signal_consumed observations.

function createDb(): { db: PatchRelayDatabase; cleanup: () => void } {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-s5-inbox-"));
  const db = new PatchRelayDatabase(path.join(baseDir, "patchrelay.sqlite"), true);
  db.runMigrations();
  return {
    db,
    cleanup: () => {
      db.close();
      rmSync(baseDir, { recursive: true, force: true });
    },
  };
}

function makeIssue(db: PatchRelayDatabase, patch: Partial<IssueRecord> = {}): IssueRecord {
  const projectId = patch.projectId ?? "proj";
  const linearIssueId = patch.linearIssueId ?? "issue-1";
  const commit = db.issueSessions.commitIssueState({
    writer: "s5-inbox-test",
    update: {
      projectId,
      linearIssueId,
      issueKey: "USE-1",
      title: "Do the thing",
      factoryState: "delegated",
      delegatedToPatchRelay: true,
      ...patch,
    },
  });
  assert.equal(commit.outcome, "applied");
  return db.getIssue(projectId, linearIssueId)!;
}

function humanInputDedupeKey(linearIssueId: string, text: string, inputKind: string): string {
  return `input:${linearIssueId}:${createHash("sha256").update(text).digest("hex")}:${inputKind}`;
}

function appendHumanInput(
  db: PatchRelayDatabase,
  issue: Pick<IssueRecord, "projectId" | "linearIssueId">,
  opts: { text: string; inputKind: string; author?: string },
): number {
  return db.workflowObservations.appendObservation({
    projectId: issue.projectId,
    subjectId: issue.linearIssueId,
    source: opts.inputKind === "operator_prompt" ? "operator" : "linear",
    type: "human.input",
    payloadJson: JSON.stringify({
      text: opts.text,
      inputKind: opts.inputKind,
      ...(opts.author ? { author: opts.author } : {}),
    }),
    dedupeKey: humanInputDedupeKey(issue.linearIssueId, opts.text, opts.inputKind),
  }).id;
}

function appendSignalConsumed(
  db: PatchRelayDatabase,
  issue: Pick<IssueRecord, "projectId" | "linearIssueId">,
  opts: { runId?: number; taskId?: string; consumedObservationIds: number[]; method: "claim" | "steer"; dedupeKey: string },
): void {
  db.workflowObservations.appendObservation({
    projectId: issue.projectId,
    subjectId: issue.linearIssueId,
    source: "executor",
    type: "workflow.signal_consumed",
    payloadJson: JSON.stringify({
      ...(opts.runId !== undefined ? { runId: opts.runId } : {}),
      ...(opts.taskId ? { taskId: opts.taskId } : {}),
      consumedObservationIds: opts.consumedObservationIds,
      method: opts.method,
    }),
    dedupeKey: opts.dedupeKey,
  });
}

function openTaskIds(db: PatchRelayDatabase, issue: IssueRecord): string[] {
  return reconcileWorkflowTasksForIssue(db, db.getIssue(issue.projectId, issue.linearIssueId)!)
    .result.open.map((task) => task.taskId);
}

function runInputTask(db: PatchRelayDatabase, issue: IssueRecord) {
  return reconcileWorkflowTasksForIssue(db, db.getIssue(issue.projectId, issue.linearIssueId)!)
    .result.open.find((task) => task.taskId === "run:input");
}

// ─── Per-family derivation ────────────────────────────────────────────

test("human.input on an idle issue derives run:input (implementation) carrying followUps", () => {
  const { db, cleanup } = createDb();
  try {
    const issue = makeIssue(db);
    const obsId = appendHumanInput(db, issue, { text: "please add tests", inputKind: "followup_prompt", author: "alice" });
    const task = runInputTask(db, issue);
    assert.ok(task, "run:input task should exist");
    assert.equal(task!.runType, "implementation");
    assert.equal(task!.gateAction, "start");
    const requirements = JSON.parse(task!.requirementsJson!) as Record<string, unknown>;
    assert.deepEqual(requirements.consumesObservationIds, [obsId]);
    assert.equal(requirements.resumeThread, true);
    assert.equal((requirements.followUps as unknown[]).length, 1);
    assert.equal((requirements.followUps as Array<{ text: string }>)[0]!.text, "please add tests");
  } finally {
    cleanup();
  }
});

test("direct_reply with current-head requested changes derives run:input (review_fix) with a blocking head", () => {
  const { db, cleanup } = createDb();
  try {
    const issue = makeIssue(db, {
      factoryState: "changes_requested",
      prNumber: 7,
      prState: "open",
      prHeadSha: "head-9",
      prReviewState: "changes_requested",
      lastBlockingReviewHeadSha: "head-9",
    });
    appendHumanInput(db, issue, { text: "address the comment", inputKind: "direct_reply" });
    const task = runInputTask(db, issue);
    assert.ok(task);
    assert.equal(task!.runType, "review_fix");
    const requirements = JSON.parse(task!.requirementsJson!) as Record<string, unknown>;
    assert.equal(requirements.blockingHeadSha, "head-9");
    assert.equal(requirements.directReplyMode, true);
  } finally {
    cleanup();
  }
});

test("completion_check_continue derives run:input with the payload runType", () => {
  const { db, cleanup } = createDb();
  try {
    const issue = makeIssue(db);
    db.workflowObservations.appendObservation({
      projectId: issue.projectId,
      subjectId: issue.linearIssueId,
      source: "executor",
      type: "executor.completion_check_continue",
      payloadJson: JSON.stringify({ runId: 42, runType: "implementation", completionCheckSummary: "keep going" }),
      dedupeKey: "cc_continue:42",
    });
    const task = runInputTask(db, issue);
    assert.ok(task);
    assert.equal(task!.runType, "implementation");
    const requirements = JSON.parse(task!.requirementsJson!) as Record<string, unknown>;
    assert.equal(requirements.completionCheckMode, true);
    assert.equal(requirements.completionCheckSummary, "keep going");
  } finally {
    cleanup();
  }
});

test("orchestration child update derives run:orchestration_followup only when the parent has a thread", () => {
  const { db, cleanup } = createDb();
  try {
    const parent = makeIssue(db, { linearIssueId: "parent-1", issueClass: "orchestration" });
    db.workflowObservations.appendObservation({
      projectId: parent.projectId,
      subjectId: parent.linearIssueId,
      source: "linear",
      type: "orchestration.child_delivered",
      payloadJson: JSON.stringify({ childIssueId: "child-1", factoryState: "done" }),
      dedupeKey: "child_delivered:parent-1:child-1:done:no-pr",
    });

    // No thread yet → the child update is absorbed, no followup task.
    assert.equal(openTaskIds(db, parent).includes("run:orchestration_followup"), false);

    // Parent starts a thread → the update becomes a runnable followup.
    const withThread = makeIssue(db, { linearIssueId: "parent-1", issueClass: "orchestration", threadId: "thread-x" });
    const task = reconcileWorkflowTasksForIssue(db, db.getIssue(withThread.projectId, withThread.linearIssueId)!)
      .result.open.find((entry) => entry.taskId === "run:orchestration_followup");
    assert.ok(task, "run:orchestration_followup should exist once the parent has a thread");
    assert.equal(task!.runType, "implementation");
    assert.equal(task!.gateAction, "start");
    const requirements = JSON.parse(task!.requirementsJson!) as Record<string, unknown>;
    assert.equal(requirements.resumeThread, true);
  } finally {
    cleanup();
  }
});

// ─── Invariants ───────────────────────────────────────────────────────

test("invariant 1 — exactly-once: a re-claim signal_consumed for the same run is deduped", () => {
  const { db, cleanup } = createDb();
  try {
    const issue = makeIssue(db);
    const obsId = appendHumanInput(db, issue, { text: "one", inputKind: "followup_prompt" });
    appendSignalConsumed(db, issue, { runId: 1, taskId: "run:input", consumedObservationIds: [obsId], method: "claim", dedupeKey: "signal_consumed:run:1" });
    appendSignalConsumed(db, issue, { runId: 1, taskId: "run:input", consumedObservationIds: [obsId], method: "claim", dedupeKey: "signal_consumed:run:1" });
    const consumed = db.workflowObservations.listObservations(issue.projectId, issue.linearIssueId)
      .filter((obs) => obs.type === "workflow.signal_consumed");
    assert.equal(consumed.length, 1, "the second claim is deduped by signal_consumed:run:<id>");
    assert.equal(runInputTask(db, issue), undefined, "consumed input yields no open task");
  } finally {
    cleanup();
  }
});

test("invariant 2 — steer success suppresses the run:input task", () => {
  const { db, cleanup } = createDb();
  try {
    const issue = makeIssue(db);
    const obsId = appendHumanInput(db, issue, { text: "steer me", inputKind: "followup_prompt" });
    appendSignalConsumed(db, issue, { consumedObservationIds: [obsId], method: "steer", dedupeKey: `signal_consumed:steer:${obsId}` });
    assert.equal(runInputTask(db, issue), undefined);
  } finally {
    cleanup();
  }
});

test("invariant 3 & 5 — input while a run is active masks the task, then re-derives at release", () => {
  const { db, cleanup } = createDb();
  try {
    const issue = makeIssue(db);
    const run = db.runs.createRun({ issueId: issue.id, projectId: issue.projectId, linearIssueId: issue.linearIssueId, runType: "implementation" });
    db.issueSessions.commitIssueState({
      writer: "s5-inbox-test",
      update: { projectId: issue.projectId, linearIssueId: issue.linearIssueId, activeRunId: run.id },
    });
    // Steer failed (no consumption); the observation lands while the run is active.
    appendHumanInput(db, issue, { text: "queued during run", inputKind: "followup_prompt" });
    const active = db.getIssue(issue.projectId, issue.linearIssueId)!;
    assert.equal(openTaskIds(db, active).some((id) => id.startsWith("wait:active-run:")), true);
    assert.equal(runInputTask(db, active), undefined, "inbox task is masked while the run is active");

    // Run releases (run finished + slot cleared).
    db.runs.finishRun(run.id, { status: "completed" });
    db.issueSessions.commitIssueState({
      writer: "s5-inbox-test",
      update: { projectId: issue.projectId, linearIssueId: issue.linearIssueId, activeRunId: null },
    });
    assert.ok(runInputTask(db, db.getIssue(issue.projectId, issue.linearIssueId)!), "input is not lost — it derives at release");
  } finally {
    cleanup();
  }
});

test("invariant 4 — monotonic: two reconciles with no new observations produce identical open tasks", () => {
  const { db, cleanup } = createDb();
  try {
    const issue = makeIssue(db);
    appendHumanInput(db, issue, { text: "monotone", inputKind: "followup_prompt" });
    const first = openTaskIds(db, issue);
    const second = openTaskIds(db, issue);
    assert.deepEqual(first, second);
    assert.equal(first.includes("run:input"), true);
  } finally {
    cleanup();
  }
});

test("invariant 6 — startup: unconsumed input re-enqueues, consumed input does not", () => {
  const { db, cleanup } = createDb();
  try {
    const issue = makeIssue(db);
    const obsId = appendHumanInput(db, issue, { text: "restart", inputKind: "followup_prompt" });
    // Simulate a fresh startup reconcile.
    reconcileWorkflowTasksForIssue(db, db.getIssue(issue.projectId, issue.linearIssueId)!);
    assert.equal(
      db.workflowTasks.listOpenRunnableTasks(issue.projectId).some((task) => task.subjectId === issue.linearIssueId && task.taskId === "run:input"),
      true,
      "unconsumed input is runnable after restart-style reconcile",
    );

    appendSignalConsumed(db, issue, { runId: 5, taskId: "run:input", consumedObservationIds: [obsId], method: "claim", dedupeKey: "signal_consumed:run:5" });
    reconcileWorkflowTasksForIssue(db, db.getIssue(issue.projectId, issue.linearIssueId)!);
    assert.equal(
      db.workflowTasks.listOpenRunnableTasks(issue.projectId).some((task) => task.subjectId === issue.linearIssueId && task.taskId === "run:input"),
      false,
      "consumed-before-restart input is not runnable",
    );
  } finally {
    cleanup();
  }
});

test("invariant 7 — dedupe: same text+kind is one observation, different text is two", () => {
  const { db, cleanup } = createDb();
  try {
    const issue = makeIssue(db);
    const first = appendHumanInput(db, issue, { text: "same", inputKind: "followup_prompt" });
    const dupe = appendHumanInput(db, issue, { text: "same", inputKind: "followup_prompt" });
    assert.equal(first, dupe, "same text+kind collapses to one observation");
    const other = appendHumanInput(db, issue, { text: "different", inputKind: "followup_prompt" });
    assert.notEqual(first, other);
    const inputs = db.workflowObservations.listObservations(issue.projectId, issue.linearIssueId)
      .filter((obs) => obs.type === "human.input");
    assert.equal(inputs.length, 2);
  } finally {
    cleanup();
  }
});

test("precedence — a settled CI repair signal outranks unconsumed human input", () => {
  const { db, cleanup } = createDb();
  try {
    const issue = makeIssue(db, {
      factoryState: "repairing_ci",
      prNumber: 3,
      prState: "open",
      prHeadSha: "head-1",
      lastGitHubFailureSource: "branch_ci",
      lastGitHubFailureHeadSha: "head-1",
      lastGitHubFailureSignature: "sig-1",
    });
    appendHumanInput(db, issue, { text: "meanwhile a human typed", inputKind: "followup_prompt" });
    const open = openTaskIds(db, issue);
    assert.equal(open.includes("run:ci_repair"), true, "ci_repair wins first");
    assert.equal(open.includes("run:input"), false, "run:input yields to the structural repair");
  } finally {
    cleanup();
  }
});
