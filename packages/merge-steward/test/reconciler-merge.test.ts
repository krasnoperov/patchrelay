import assert from "node:assert/strict";
import test from "node:test";
import { MemoryStore } from "../src/memory-store.ts";
import { deletePrBranchAfterGitHubMarksMerged } from "../src/reconciler-merge.ts";
import type { ReconcileContext } from "../src/reconciler.ts";
import type { GitHubPRApi } from "../src/interfaces.ts";
import type { QueueEntry, ReconcileEvent } from "../src/types.ts";
import { createHarness, type Harness } from "./harness.ts";

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
    decidedAt: null,
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

function protectedBranchError(): Error & { stderr: string; exitCode: number } {
  const error = new Error("Command failed: git push origin mq-spec:main") as Error & {
    stderr: string;
    exitCode: number;
  };
  error.stderr = "remote: error: GH006: Protected branch update failed for refs/heads/main. Required status check \"Tests\" is expected.";
  error.exitCode = 1;
  return error;
}

async function runUntilEvent(
  h: Harness,
  predicate: (event: ReconcileEvent) => boolean,
  options: { maxTicks?: number } = {},
): Promise<ReconcileEvent> {
  const maxTicks = options.maxTicks ?? 20;
  for (let i = 0; i < maxTicks; i++) {
    await h.tick();
    const event = h.reconcileEvents.find(predicate);
    if (event) return event;
  }
  throw new Error("event did not occur");
}

test("protected branch push rejection keeps the validated spec and downstream CI", async () => {
  const h = await createHarness({ ciRule: () => "pass", maxRetries: 2, speculativeDepth: 2 });
  await h.enqueue({ number: 1, branch: "feat-a", files: [{ path: "a.ts", content: "a" }] });
  await h.enqueue({ number: 2, branch: "feat-b", files: [{ path: "b.ts", content: "b" }] });

  const originalPush = h.gitSim.push.bind(h.gitSim);
  let mainPushAttempts = 0;
  h.gitSim.push = async (branch?: string, force?: boolean, targetBranch?: string) => {
    if (targetBranch === "main") {
      mainPushAttempts += 1;
      if (mainPushAttempts === 1) {
        throw protectedBranchError();
      }
    }
    await originalPush(branch, force, targetBranch);
  };

  const rejected = await runUntilEvent(h, (event) => event.action === "merge_rejected");
  assert.match(rejected.detail ?? "", /protected_branch/);
  assert.match(rejected.detail ?? "", /GH006/);

  const head = h.entries.find((entry) => entry.prNumber === 1)!;
  const downstream = h.entries.find((entry) => entry.prNumber === 2)!;
  assert.equal(head.status, "merging");
  assert.equal(head.retryAttempts, 1);
  assert.equal(head.specBranch, "mq-spec-qe-1");
  assert.equal(head.ciRunId, "ci-1");
  assert.equal(downstream.status, "validating");
  assert.equal(h.ciSim.runCount, 2);
  assert.equal(h.reconcileEvents.some((event) => event.action === "invalidated"), false);

  await h.tick();

  assert.ok(h.merged.includes(1));
  assert.equal(h.ciSim.runCount, 2, "retrying the push must not rerun speculative CI");
});

test("repeated protected branch push rejection holds instead of evicting as integration conflict", async () => {
  const h = await createHarness({ ciRule: () => "pass", maxRetries: 0, speculativeDepth: 2 });
  await h.enqueue({ number: 1, branch: "feat-a", files: [{ path: "a.ts", content: "a" }] });
  await h.enqueue({ number: 2, branch: "feat-b", files: [{ path: "b.ts", content: "b" }] });

  const originalPush = h.gitSim.push.bind(h.gitSim);
  h.gitSim.push = async (branch?: string, force?: boolean, targetBranch?: string) => {
    if (targetBranch === "main") {
      throw protectedBranchError();
    }
    await originalPush(branch, force, targetBranch);
  };

  await runUntilEvent(h, (event) => event.action === "budget_exhausted");
  await h.tick();
  await h.tick();

  const head = h.entries.find((entry) => entry.prNumber === 1)!;
  assert.equal(head.status, "merging");
  assert.match(head.waitDetail ?? "", /keeping validated spec|protected_branch|GH006/);
  assert.equal(h.evictions.length, 0);
  assert.equal(h.reconcileEvents.some((event) => event.action === "invalidated"), false);
});
