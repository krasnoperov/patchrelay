import assert from "node:assert/strict";
import test from "node:test";
import { MemoryStore } from "../src/memory-store.ts";
import { deletePrBranchAfterGitHubMarksMerged } from "../src/reconciler-merge.ts";
import type { ReconcileContext } from "../src/reconciler.ts";
import type { GitHubPRApi } from "../src/interfaces.ts";
import type { QueueEntry, ReconcileEvent } from "../src/types.ts";

function makeEntry(): QueueEntry {
  return {
    id: "entry-1",
    repoId: "repo",
    prNumber: 764,
    branch: "feature",
    headSha: "head",
    baseSha: "base",
    status: "merged",
    position: 1,
    priority: 0,
    generation: 0,
    ciRunId: null,
    ciRetries: 0,
    retryAttempts: 0,
    maxRetries: 2,
    lastFailedBaseSha: null,
    issueKey: null,
    specBranch: null,
    specSha: null,
    specBasedOn: null,
    postMergeStatus: "pass",
    postMergeSha: "spec",
    postMergeSummary: "all required checks passed",
    postMergeCheckedAt: new Date().toISOString(),
    waitDetail: null,
    prTitle: "Feature",
    headPatchId: null,
    specTreeId: null,
    enqueuedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function buildContext(github: GitHubPRApi, events: ReconcileEvent[]): ReconcileContext {
  return {
    store: new MemoryStore(),
    repoId: "repo",
    baseBranch: "main",
    remotePrefix: "",
    git: {} as ReconcileContext["git"],
    ci: {} as ReconcileContext["ci"],
    github,
    eviction: {} as ReconcileContext["eviction"],
    specBuilder: {} as ReconcileContext["specBuilder"],
    speculativeDepth: 1,
    flakyRetries: 0,
    policy: {} as ReconcileContext["policy"],
    onEvent: (event) => events.push(event),
  };
}

test("branch cleanup is deferred until GitHub classifies the fast-forwarded PR as merged", async () => {
  let deleteCalls = 0;
  const events: ReconcileEvent[] = [];
  const github = {
    async getStatus() {
      return {
        number: 764,
        branch: "feature",
        headSha: "head",
        mergeable: false,
        reviewApproved: true,
        merged: false,
      };
    },
    async deleteBranch() {
      deleteCalls += 1;
    },
  } as GitHubPRApi;

  const entry = makeEntry();
  await deletePrBranchAfterGitHubMarksMerged(buildContext(github, events), entry, {
    attempts: 1,
    delayMs: 0,
  });

  assert.equal(deleteCalls, 0);
  assert.equal(events.at(-1)?.action, "pr_branch_cleanup_deferred");
});

test("branch cleanup runs after GitHub reports the PR as merged", async () => {
  let deleteCalls = 0;
  const events: ReconcileEvent[] = [];
  const github = {
    async getStatus() {
      return {
        number: 764,
        branch: "feature",
        headSha: "head",
        mergeable: false,
        reviewApproved: true,
        merged: true,
      };
    },
    async deleteBranch() {
      deleteCalls += 1;
    },
  } as GitHubPRApi;

  const entry = makeEntry();
  await deletePrBranchAfterGitHubMarksMerged(buildContext(github, events), entry, {
    attempts: 1,
    delayMs: 0,
  });

  assert.equal(deleteCalls, 1);
  assert.equal(events.length, 0);
});
