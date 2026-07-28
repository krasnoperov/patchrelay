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
    candidateRef: null,
    candidateSha: null,
    candidateBasedOn: null,
    postMergeStatus: "pass",
    postMergeSha: "spec",
    postMergeSummary: "all required checks passed",
    postMergeCheckedAt: new Date().toISOString(),
    waitDetail: null,
    prTitle: "Feature",
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

test("protected branch push rejection keeps the exact head candidate and downstream CI", async () => {
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
  assert.equal(head.candidateKind, "head");
  assert.equal(head.candidateRef, null);
  assert.equal(head.candidateSha, head.headSha);
  assert.equal(head.ciRunId, null);
  assert.equal(downstream.status, "validating");
  assert.equal(h.ciSim.runCount, 1);
  assert.equal(h.reconcileEvents.some((event) => event.action === "invalidated"), false);

  await h.tick();

  assert.ok(h.merged.includes(1));
  assert.equal(h.ciSim.runCount, 1, "retrying the push must not rerun candidate CI");
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
  assert.match(head.waitDetail ?? "", /keeping validated candidate|protected_branch|GH006/);
  assert.equal(h.evictions.length, 0);
  assert.equal(h.reconcileEvents.some((event) => event.action === "invalidated"), false);
});

for (const mutation of ["approval", "head", "closure"] as const) {
  test(`integration candidate does not land when PR ${mutation} changes during final revalidation`, async () => {
    const h = await createHarness({ ciRule: () => "pass" });
    await h.enqueue({
      number: 20,
      branch: "feat-integration-race",
      files: [{ path: "feature.ts", content: "feature" }],
    });
    await h.advanceMain();

    await runUntilEvent(h, (event) =>
      event.prNumber === 20
      && event.action === "ci_passed"
      && event.candidateKind === "integration");
    const before = h.entries[0]!;
    assert.equal(before.status, "merging");
    assert.equal(before.candidateKind, "integration");

    const originalGetStatus = h.githubSim.getStatus.bind(h.githubSim);
    let calls = 0;
    h.githubSim.getStatus = async (prNumber: number) => {
      calls += 1;
      // sanitize + initial merge gate read first. Mutate immediately before
      // the common late PR-truth read that follows policy/check/ancestry.
      if (calls === 3) {
        if (mutation === "approval") {
          h.githubSim.setReviewApproved(prNumber, false);
        } else if (mutation === "head") {
          h.githubSim.updateSha(prNumber, "force-pushed-head");
        } else {
          h.githubSim.closePR(prNumber);
        }
      }
      return await originalGetStatus(prNumber);
    };

    await h.tick();

    assert.deepEqual(h.merged, []);
    const after = h.entries[0]!;
    if (mutation === "approval") {
      assert.equal(after.status, "merging");
      assert.match(after.waitDetail ?? "", /approval|review/i);
      assert.equal(after.candidateSha, before.candidateSha, "approval waits retain the exact tested candidate");
    } else if (mutation === "head") {
      assert.equal(after.status, "queued");
      assert.equal(after.headSha, "force-pushed-head");
      assert.equal(after.candidateSha, null);
    } else {
      assert.equal(after.status, "dequeued");
      assert.equal(after.candidateRef, null);
    }
  });
}

for (const failure of [
  {
    name: "authentication failure",
    error: Object.assign(new Error("Authentication failed"), {
      stderr: "remote: Permission denied: write access not granted",
      exitCode: 128,
    }),
    kind: "auth_or_permission",
  },
  {
    name: "GitHub App workflow permission failure",
    error: Object.assign(new Error("push rejected"), {
      stderr: "refusing to allow a GitHub App to create or update workflow without workflows permission",
      exitCode: 1,
    }),
    kind: "workflow_permission",
  },
  {
    name: "push timeout",
    error: Object.assign(new Error("git push timed out"), {
      timedOut: true,
      signal: "SIGTERM" as const,
    }),
    kind: "timeout",
  },
]) {
  test(`${failure.name} never changes candidate identity or lands unverified code`, async () => {
    const h = await createHarness({ ciRule: () => "pass", maxRetries: 1 });
    const inserted = await h.enqueue({
      number: 10,
      branch: "feat-safe-push",
      files: [{ path: "safe.ts", content: "safe" }],
    });
    const originalPush = h.gitSim.push.bind(h.gitSim);
    let reject = true;
    h.gitSim.push = async (source?: string, force?: boolean, target?: string) => {
      if (target === "main" && reject) throw failure.error;
      await originalPush(source, force, target);
    };

    const rejected = await runUntilEvent(h, (event) => event.action === "merge_rejected");
    const held = h.entries[0]!;
    assert.match(rejected.detail ?? "", new RegExp(failure.kind));
    assert.equal(held.status, "merging");
    assert.equal(held.candidateSha, inserted.headSha);
    assert.deepEqual(h.merged, []);

    reject = false;
    await h.runUntilStable();
    assert.deepEqual(h.merged, [10]);
  });
}
