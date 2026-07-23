import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { PatchRelayDatabase } from "../src/db.ts";
import { syncActiveWorkflowState } from "../src/linear-workflow-state-sync.ts";

function createDb() {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-linear-workflow-state-"));
  const db = new PatchRelayDatabase(path.join(baseDir, "patchrelay.sqlite"), true);
  db.runMigrations();
  return { baseDir, db };
}

test("syncActiveWorkflowState routes awaiting_input issues to a human-needed Linear state", async () => {
  const { baseDir, db } = createDb();
  try {
    const issue = db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-human",
      issueKey: "USE-HUMAN",
      inputRequestKind: "completion_check_question",
      currentLinearState: "In Progress",
    });

    let requestedState: string | undefined;
    await syncActiveWorkflowState({
      db,
      issue,
      linear: {
        getIssue: async () => ({
          id: issue.linearIssueId,
          stateName: "In Progress",
          stateType: "started",
          workflowStates: [
            { name: "In Progress", type: "started" },
            { name: "Human Needed", type: "unstarted" },
          ],
        }),
        setIssueState: async (_issueId, state) => {
          requestedState = state;
          return { stateName: state, stateType: "unstarted" };
        },
      } as never,
    });

    assert.equal(requestedState, "Human Needed");
    assert.equal(db.issues.getIssue(issue.projectId, issue.linearIssueId)?.currentLinearState, "Human Needed");
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("syncActiveWorkflowState routes approved (pre-merge) issues to In Merge Queue, not Deploying", async () => {
  const { baseDir, db } = createDb();
  try {
    const issue = db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-queue",
      issueKey: "USE-QUEUE",
      workflowOutcome: undefined,
      prNumber: 7,
      prReviewState: "approved",
      prCheckStatus: "success",
      prState: "open",
      currentLinearState: "In Review",
    });

    let requestedState: string | undefined;
    await syncActiveWorkflowState({
      db,
      issue,
      linear: {
        getIssue: async () => ({
          id: issue.linearIssueId,
          stateName: "In Review",
          stateType: "started",
          workflowStates: [
            { name: "In Review", type: "started" },
            { name: "In Merge Queue", type: "started" },
            { name: "Deploying", type: "started" },
          ],
        }),
        setIssueState: async (_issueId, state) => {
          requestedState = state;
          return { stateName: state, stateType: "started" };
        },
        updateIssueLabels: async () => undefined,
      } as never,
    });

    assert.equal(requestedState, "In Merge Queue");
    assert.equal(db.issues.getIssue(issue.projectId, issue.linearIssueId)?.currentLinearState, "In Merge Queue");
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("syncActiveWorkflowState routes a merged (post-merge) PR to Deploying", async () => {
  const { baseDir, db } = createDb();
  try {
    const issue = db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-deploying",
      issueKey: "USE-DEPLOYING",
      // Post-merge deploy tracking introduces a non-terminal window; until
      // then the merged PR is detected purely from prState.
      workflowOutcome: undefined,
      prNumber: 8,
      prReviewState: "approved",
      prState: "merged",
      currentLinearState: "In Merge Queue",
    });

    let requestedState: string | undefined;
    await syncActiveWorkflowState({
      db,
      issue,
      linear: {
        getIssue: async () => ({
          id: issue.linearIssueId,
          stateName: "In Merge Queue",
          stateType: "started",
          workflowStates: [
            { name: "In Review", type: "started" },
            { name: "In Merge Queue", type: "started" },
            { name: "Deploying", type: "started" },
            { name: "Done", type: "completed" },
          ],
        }),
        setIssueState: async (_issueId, state) => {
          requestedState = state;
          return { stateName: state, stateType: "started" };
        },
        updateIssueLabels: async () => undefined,
      } as never,
    });

    assert.equal(requestedState, "Deploying");
    assert.equal(db.issues.getIssue(issue.projectId, issue.linearIssueId)?.currentLinearState, "Deploying");
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("syncActiveWorkflowState routes changes-requested work to Implementing", async () => {
  const { baseDir, db } = createDb();
  try {
    const issue = db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-changes",
      issueKey: "USE-CHANGES",
      workflowOutcome: undefined,
      prNumber: 9,
      prReviewState: "changes_requested",
      prState: "open",
      currentLinearState: "Reviewing",
    });

    let requestedState: string | undefined;
    await syncActiveWorkflowState({
      db,
      issue,
      linear: {
        getIssue: async () => ({
          id: issue.linearIssueId,
          stateName: "Reviewing",
          stateType: "started",
          workflowStates: [
            { name: "Implementing", type: "started" },
            { name: "Reviewing", type: "started" },
            { name: "In Merge Queue", type: "started" },
          ],
        }),
        setIssueState: async (_issueId, state) => {
          requestedState = state;
          return { stateName: state, stateType: "started" };
        },
        updateIssueLabels: async () => undefined,
      } as never,
    });

    assert.equal(requestedState, "Implementing");
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("syncActiveWorkflowState does NOT flap to Implementing while a run is active during review", async () => {
  const { baseDir, db } = createDb();
  try {
    // PR open, review verdict pending, and a run is in flight (activeRunId
    // set). The old mapping flipped to Implementing on the active run;
    // the durable mapping must stay on the review phase.
    const issue = db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-flap",
      issueKey: "USE-FLAP",
      workflowOutcome: undefined,
      prNumber: 11,
      prState: "open",
      currentLinearState: "Reviewing",
    });
    const run = db.runs.createRun({
      issueId: issue.id,
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      runType: "review_fix",
    });
    db.upsertIssue({ projectId: "usertold", linearIssueId: "issue-flap", activeRunId: run.id });

    let requestedState: string | undefined;
    await syncActiveWorkflowState({
      db,
      issue: db.getIssue("usertold", "issue-flap")!,
      options: { activeRunType: "review_fix" },
      linear: {
        getIssue: async () => ({
          id: issue.linearIssueId,
          stateName: "Reviewing",
          stateType: "started",
          workflowStates: [
            { name: "Implementing", type: "started" },
            { name: "Reviewing", type: "started" },
          ],
        }),
        setIssueState: async (_issueId, state) => {
          requestedState = state;
          return { stateName: state, stateType: "started" };
        },
        updateIssueLabels: async () => undefined,
      } as never,
    });

    // Stays on Reviewing (already current) — no flip to Implementing.
    assert.equal(requestedState, undefined);
    assert.equal(db.issues.getIssue(issue.projectId, issue.linearIssueId)?.currentLinearState, "Reviewing");
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("syncActiveWorkflowState routes pending review-quill verdicts to the preferred active review state", async () => {
  const { baseDir, db } = createDb();
  try {
    const issue = db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-reviewing",
      issueKey: "USE-REVIEWING",
      workflowOutcome: undefined,
      prNumber: 42,
      lastGitHubCiSnapshotJson: JSON.stringify({
        gateCheckStatus: "pending",
        checks: [{ name: "review-quill/verdict", status: "pending" }],
      }),
      currentLinearState: "In Review",
    });

    let requestedState: string | undefined;
    await syncActiveWorkflowState({
      db,
      issue,
      linear: {
        getIssue: async () => ({
          id: issue.linearIssueId,
          stateName: "In Review",
          stateType: "started",
          workflowStates: [
            { name: "In Review", type: "started" },
            { name: "Reviewing", type: "started" },
          ],
        }),
        setIssueState: async (_issueId, state) => {
          requestedState = state;
          return { stateName: state, stateType: "started" };
        },
      } as never,
    });

    assert.equal(requestedState, undefined);
    assert.equal(db.issues.getIssue(issue.projectId, issue.linearIssueId)?.currentLinearState, "In Review");
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("syncActiveWorkflowState completes trusted no-PR done issues in Linear", async () => {
  const { baseDir, db } = createDb();
  try {
    const issue = db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-no-pr-done",
      issueKey: "USE-DONE",
      workflowOutcome: "completed",
      currentLinearState: "In Progress",
      currentLinearStateType: "started",
    });
    const run = db.runs.createRun({
      issueId: issue.id,
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      runType: "implementation",
    });
    db.runs.finishRun(run.id, { status: "completed" });
    db.runs.saveCompletionCheck(run.id, {
      outcome: "done",
      summary: "Already complete on the published head.",
    });

    let requestedState: string | undefined;
    await syncActiveWorkflowState({
      db,
      issue: db.getIssue(issue.projectId, issue.linearIssueId)!,
      linear: {
        getIssue: async () => ({
          id: issue.linearIssueId,
          stateName: "In Progress",
          stateType: "started",
          workflowStates: [
            { name: "In Progress", type: "started" },
            { name: "Done", type: "completed" },
          ],
        }),
        setIssueState: async (_issueId, state) => {
          requestedState = state;
          return { stateName: state, stateType: "completed" };
        },
      } as never,
    });

    assert.equal(requestedState, "Done");
    const refreshed = db.issues.getIssue(issue.projectId, issue.linearIssueId);
    assert.equal(refreshed?.currentLinearState, "Done");
    assert.equal(refreshed?.currentLinearStateType, "completed");
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("syncActiveWorkflowState moves undelegated no-PR work back to the queued Linear state", async () => {
  const { baseDir, db } = createDb();
  try {
    const issue = db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-paused",
      issueKey: "USE-PAUSED",
      workflowOutcome: undefined,
      delegatedToPatchRelay: false,
      currentLinearState: "In Progress",
      currentLinearStateType: "started",
    });

    let requestedState: string | undefined;
    await syncActiveWorkflowState({
      db,
      issue,
      trackedIssue: {
        blockedByCount: 0,
        readyForExecution: false,
      } as never,
      linear: {
        getIssue: async () => ({
          id: issue.linearIssueId,
          stateName: "In Progress",
          stateType: "started",
          workflowStates: [
            { name: "Backlog", type: "backlog" },
            { name: "In Progress", type: "started" },
            { name: "Done", type: "completed" },
          ],
        }),
        setIssueState: async (_issueId, state) => {
          requestedState = state;
          return { stateName: state, stateType: "backlog" };
        },
      } as never,
    });

    assert.equal(requestedState, "Backlog");
    assert.equal(db.issues.getIssue(issue.projectId, issue.linearIssueId)?.currentLinearState, "Backlog");
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("syncActiveWorkflowState moves blocked delegated no-PR work back to the queued Linear state", async () => {
  const { baseDir, db } = createDb();
  try {
    const issue = db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-blocked",
      issueKey: "USE-BLOCKED",
      workflowOutcome: undefined,
      delegatedToPatchRelay: true,
      currentLinearState: "In Progress",
      currentLinearStateType: "started",
    });
    db.replaceIssueDependencies({
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      blockers: [{
        blockerLinearIssueId: "issue-blocker",
        blockerIssueKey: "USE-BLOCKER",
        blockerTitle: "Blocking work",
        blockerCurrentLinearState: "In Progress",
        blockerCurrentLinearStateType: "started",
      }],
    });

    let requestedState: string | undefined;
    await syncActiveWorkflowState({
      db,
      issue,
      linear: {
        getIssue: async () => ({
          id: issue.linearIssueId,
          stateName: "In Progress",
          stateType: "started",
          workflowStates: [
            { name: "Backlog", type: "backlog" },
            { name: "In Progress", type: "started" },
            { name: "Done", type: "completed" },
          ],
        }),
        setIssueState: async (_issueId, state) => {
          requestedState = state;
          return { stateName: state, stateType: "backlog" };
        },
      } as never,
    });

    assert.equal(requestedState, "Backlog");
    assert.equal(db.issues.getIssue(issue.projectId, issue.linearIssueId)?.currentLinearState, "Backlog");
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});
