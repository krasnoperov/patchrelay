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
      factoryState: "awaiting_input",
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

test("syncActiveWorkflowState routes approved-and-green issues to deploying", async () => {
  const { baseDir, db } = createDb();
  try {
    const issue = db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-deploy",
      issueKey: "USE-DEPLOY",
      factoryState: "pr_open",
      prReviewState: "approved",
      prCheckStatus: "success",
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
            { name: "Deploying", type: "started" },
          ],
        }),
        setIssueState: async (_issueId, state) => {
          requestedState = state;
          return { stateName: state, stateType: "started" };
        },
      } as never,
    });

    assert.equal(requestedState, "Deploying");
    assert.equal(db.issues.getIssue(issue.projectId, issue.linearIssueId)?.currentLinearState, "Deploying");
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
      factoryState: "pr_open",
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
      factoryState: "done",
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
      factoryState: "implementing",
      delegatedToPatchRelay: false,
      currentLinearState: "In Progress",
      currentLinearStateType: "started",
    });

    let requestedState: string | undefined;
    await syncActiveWorkflowState({
      db,
      issue,
      trackedIssue: {
        sessionState: "idle",
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
      factoryState: "delegated",
      delegatedToPatchRelay: true,
      currentLinearState: "In Progress",
      currentLinearStateType: "started",
    });

    let requestedState: string | undefined;
    await syncActiveWorkflowState({
      db,
      issue,
      trackedIssue: {
        sessionState: "idle",
        blockedByCount: 2,
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
