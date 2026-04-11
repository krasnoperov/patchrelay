import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import test from "node:test";
import { PatchRelayDatabase } from "../src/db.ts";
import { MergedLinearCompletionReconciler } from "../src/merged-linear-completion-reconciler.ts";
import type { LinearClient } from "../src/types.ts";

function createDb(): { baseDir: string; db: PatchRelayDatabase } {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-linear-completion-"));
  const db = new PatchRelayDatabase(path.join(baseDir, "patchrelay.sqlite"), true);
  db.runMigrations();
  return { baseDir, db };
}

function buildLiveIssue(params: {
  id: string;
  identifier: string;
  title: string;
  stateName: string;
  stateType: string;
  blockedBy?: Array<{ id: string; identifier?: string; title?: string; stateName?: string; stateType?: string }>;
}) {
  return {
    id: params.id,
    identifier: params.identifier,
    title: params.title,
    description: "",
    url: `https://linear.app/test/issue/${params.identifier}`,
    teamId: "team-use",
    teamKey: "USE",
    stateId: `state-${params.stateName.toLowerCase().replace(/\s+/g, "-")}`,
    stateName: params.stateName,
    stateType: params.stateType,
    workflowStates: [
      { id: "state-todo", name: "Todo", type: "unstarted" },
      { id: "state-progress", name: "In Progress", type: "started" },
      { id: "state-review", name: "In Review", type: "started" },
      { id: "state-done", name: "Done", type: "completed" },
    ],
    labelIds: [],
    labels: [],
    teamLabels: [],
    blockedBy: params.blockedBy ?? [],
    blocks: [],
  };
}

test("reconciler reopens stale local done issues back into requested-changes repair state", async () => {
  const { baseDir, db } = createDb();
  try {
    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-review-fix",
      issueKey: "USE-201",
      delegatedToPatchRelay: true,
      factoryState: "done",
      currentLinearState: "In Progress",
      currentLinearStateType: "started",
      prNumber: 201,
      prState: "open",
      prReviewState: "changes_requested",
      prCheckStatus: "success",
    });

    const reconciler = new MergedLinearCompletionReconciler(
      db,
      {
        forProject: async () => ({
          getIssue: async () => buildLiveIssue({
            id: "issue-review-fix",
            identifier: "USE-201",
            title: "Review fix issue",
            stateName: "In Progress",
            stateType: "started",
          }),
          setIssueState: async () => {
            throw new Error("setIssueState should not be called for stale local reopen");
          },
        }) as LinearClient,
      },
      pino({ enabled: false }),
    );

    await reconciler.reconcile();

    const issue = db.getIssue("usertold", "issue-review-fix");
    assert.equal(issue?.factoryState, "changes_requested");
    assert.equal(issue?.pendingRunType, "review_fix");
    assert.equal(issue?.currentLinearState, "In Progress");
    assert.equal(issue?.currentLinearStateType, "started");
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("reconciler reopens stale blocked local done issues back into delegated state", async () => {
  const { baseDir, db } = createDb();
  try {
    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-blocked-done",
      issueKey: "USE-202",
      delegatedToPatchRelay: true,
      factoryState: "done",
      currentLinearState: "Todo",
      currentLinearStateType: "unstarted",
    });

    const reconciler = new MergedLinearCompletionReconciler(
      db,
      {
        forProject: async () => ({
          getIssue: async () => buildLiveIssue({
            id: "issue-blocked-done",
            identifier: "USE-202",
            title: "Blocked issue",
            stateName: "Todo",
            stateType: "unstarted",
            blockedBy: [{
              id: "issue-blocker-1",
              identifier: "USE-101",
              title: "Blocker",
              stateName: "In Progress",
              stateType: "started",
            }],
          }),
          setIssueState: async () => {
            throw new Error("setIssueState should not be called for stale local reopen");
          },
        }) as LinearClient,
      },
      pino({ enabled: false }),
    );

    await reconciler.reconcile();

    const issue = db.getIssue("usertold", "issue-blocked-done");
    assert.equal(issue?.factoryState, "delegated");
    assert.equal(issue?.pendingRunType, undefined);
    assert.equal(issue?.currentLinearState, "Todo");
    assert.equal(db.countUnresolvedBlockers("usertold", "issue-blocked-done"), 1);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("reconciler completes trusted no-PR done issues in Linear instead of reopening them", async () => {
  const { baseDir, db } = createDb();
  try {
    const issue = db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-no-pr-complete",
      issueKey: "USE-203",
      delegatedToPatchRelay: true,
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
      summary: "Already complete without a PR.",
    });

    let requestedState: string | undefined;
    const reconciler = new MergedLinearCompletionReconciler(
      db,
      {
        forProject: async () => ({
          getIssue: async () => buildLiveIssue({
            id: "issue-no-pr-complete",
            identifier: "USE-203",
            title: "No PR completion",
            stateName: "In Progress",
            stateType: "started",
          }),
          setIssueState: async (_issueId, state) => {
            requestedState = state;
            return { stateName: state, stateType: "completed" };
          },
        }) as LinearClient,
      },
      pino({ enabled: false }),
    );

    await reconciler.reconcile();

    const refreshed = db.getIssue("usertold", "issue-no-pr-complete");
    assert.equal(requestedState, "Done");
    assert.equal(refreshed?.factoryState, "done");
    assert.equal(refreshed?.currentLinearState, "Done");
    assert.equal(refreshed?.currentLinearStateType, "completed");
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});
