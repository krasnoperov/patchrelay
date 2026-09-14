import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MemoryStore } from "../src/memory-store.ts";
import { MergeStewardQueueCommands } from "../src/service-queue.ts";
import type { GitHubPRApi, SpeculativeBranchBuilder } from "../src/interfaces.ts";
import type { GitHubPolicyCache } from "../src/github-policy.ts";
import type { StewardConfig } from "../src/config.ts";
import type { PRStatus } from "../src/types.ts";

const noopLogger = (() => {
  const l: Record<string, unknown> = {};
  for (const m of ["info", "warn", "error", "debug", "fatal", "trace"]) {
    (l as Record<string, () => void>)[m] = () => {};
  }
  l.child = () => l;
  return l as unknown as Parameters<ConstructorParameters<typeof MergeStewardQueueCommands>[5] extends Logger ? never : never>[number];
})() as unknown as ConstructorParameters<typeof MergeStewardQueueCommands>[5];

function fakeGithub(prs: Map<number, PRStatus>): GitHubPRApi {
  return {
    async mergePR() { /* no-op */ },
    async getStatus(prNumber) {
      const pr = prs.get(prNumber);
      if (!pr) throw new Error(`unknown PR ${prNumber}`);
      return pr;
    },
    async listChecks() {
      return [{ name: "ci", conclusion: "success" }];
    },
    async listChecksForRef() {
      return [{ name: "ci", conclusion: "success" }];
    },
    async listLabels(prNumber) {
      return prNumber === 200 && prs.get(prNumber)?.title === "priority child"
        ? ["priority"]
        : [];
    },
    async setLabels() {},
    async listOpenPRs() {
      return [...prs.values()]
        .filter((pr) => !pr.merged)
        .map((pr) => ({
          number: pr.number,
          branch: pr.branch,
          headSha: pr.headSha,
          baseBranch: pr.baseRefName ?? "main",
        }));
    },
    async findPRByBranch() { return null; },
    async deleteBranch() { /* no-op */ },
    async listOpenPRsWithLabel() { return []; },
  };
}

function fakeSpecBuilder(): SpeculativeBranchBuilder {
  return {
    async createWorkspace() { return "workspace"; },
    async buildSpeculative() { return { success: true, sha: "spec" }; },
    async deleteSpeculative() { /* no-op */ },
  };
}

const policy = {
  getRequiredChecks: () => [],
  getRequiredCheckRules: () => [],
  shouldRequireAllChecksOnEmptyRequiredSet: () => false,
} as unknown as GitHubPolicyCache;

const config: StewardConfig = {
  repoId: "repo",
  baseBranch: "main",
  maxRetries: 3,
  flakyRetries: 0,
  pollIntervalMs: 1000,
  excludeBranches: [],
  priorityQueueLabel: "priority",
} as unknown as StewardConfig;

describe("stack-aware admission", () => {
  it("admits a PR opened against the repo default branch immediately", async () => {
    const store = new MemoryStore();
    const queue = new MergeStewardQueueCommands(
      config,
      policy,
      store,
      fakeGithub(new Map([[100, basePr({ number: 100, branch: "feat-a", baseRefName: "main" })]])),
      fakeSpecBuilder(),
      noopLogger,
    );

    const admitted = await queue.tryAdmit(100, "feat-a", "head-100");
    assert.equal(admitted, true);
    const entry = store.getEntryByPR("repo", 100);
    assert.ok(entry);
    assert.equal(entry!.baseRefName, "main");
  });

  it("defers admission for a stacked PR whose parent is not yet in the queue", async () => {
    const store = new MemoryStore();
    const queue = new MergeStewardQueueCommands(
      config,
      policy,
      store,
      fakeGithub(new Map([[200, basePr({ number: 200, branch: "feat-b", baseRefName: "feat-a" })]])),
      fakeSpecBuilder(),
      noopLogger,
    );

    const admitted = await queue.tryAdmit(200, "feat-b", "head-200");
    assert.equal(admitted, false, "stacked PR should defer admission");
    assert.equal(store.getEntryByPR("repo", 200), undefined);
  });

  it("admits a stacked PR once the parent is in the queue, ordered behind it", async () => {
    const store = new MemoryStore();
    const queue = new MergeStewardQueueCommands(
      config,
      policy,
      store,
      fakeGithub(new Map([
        [100, basePr({ number: 100, branch: "feat-a", baseRefName: "main" })],
        [200, basePr({ number: 200, branch: "feat-b", baseRefName: "feat-a" })],
      ])),
      fakeSpecBuilder(),
      noopLogger,
    );

    const parentAdmitted = await queue.tryAdmit(100, "feat-a", "head-100");
    assert.equal(parentAdmitted, true);
    const childAdmitted = await queue.tryAdmit(200, "feat-b", "head-200");
    assert.equal(childAdmitted, true);

    const parent = store.getEntryByPR("repo", 100);
    const child = store.getEntryByPR("repo", 200);
    assert.ok(parent);
    assert.ok(child);
    assert.equal(child!.baseRefName, "feat-a");
    assert.ok(child!.position > parent!.position, "child must be ordered after parent (not necessarily adjacent)");
  });

  it("preserves parent-before-child ordering even when an unrelated sibling PR is admitted in between", async () => {
    const store = new MemoryStore();
    const queue = new MergeStewardQueueCommands(
      config,
      policy,
      store,
      fakeGithub(new Map([
        [100, basePr({ number: 100, branch: "feat-a", baseRefName: "main" })],
        [150, basePr({ number: 150, branch: "feat-sibling", baseRefName: "main" })],
        [200, basePr({ number: 200, branch: "feat-b", baseRefName: "feat-a" })],
      ])),
      fakeSpecBuilder(),
      noopLogger,
    );

    assert.equal(await queue.tryAdmit(100, "feat-a", "head-100"), true);
    assert.equal(await queue.tryAdmit(150, "feat-sibling", "head-150"), true);
    assert.equal(await queue.tryAdmit(200, "feat-b", "head-200"), true);

    const parent = store.getEntryByPR("repo", 100)!;
    const sibling = store.getEntryByPR("repo", 150)!;
    const child = store.getEntryByPR("repo", 200)!;
    assert.ok(parent.position < child.position, "parent must precede child");
    assert.ok(sibling.position < child.position, "sibling sits between parent and child by enqueue order");
    assert.ok(parent.position < sibling.position, "sibling was admitted after parent");
  });

  it("does not let a presentation label reorder an active stack", async () => {
    const store = new MemoryStore();
    const queue = new MergeStewardQueueCommands(
      config,
      policy,
      store,
      fakeGithub(new Map([
        [100, basePr({ number: 100, branch: "feat-a", baseRefName: "main" })],
        [150, basePr({ number: 150, branch: "feat-sibling", baseRefName: "main" })],
        [200, basePr({
          number: 200,
          branch: "feat-b",
          baseRefName: "feat-a",
          title: "priority child",
        })],
      ])),
      fakeSpecBuilder(),
      noopLogger,
    );

    assert.equal(await queue.tryAdmit(100, "feat-a", "head-100"), true);
    assert.equal(await queue.tryAdmit(150, "feat-sibling", "head-150"), true);
    assert.equal(await queue.tryAdmit(200, "feat-b", "head-200"), true);

    const ordered = store.listActive("repo");
    assert.deepEqual(
      ordered.map((entry) => entry.prNumber),
      [100, 150, 200],
      "labels do not change the admission order",
    );
  });
});

describe("re-admission after an environmental eviction", () => {
  function evictedQueue() {
    const store = new MemoryStore();
    const queue = new MergeStewardQueueCommands(
      config,
      policy,
      store,
      fakeGithub(new Map([[100, basePr({ number: 100, branch: "feat-a", baseRefName: "main" })]])),
      fakeSpecBuilder(),
      noopLogger,
    );
    return { store, queue };
  }

  async function evictAdmitted(
    store: MemoryStore,
    queue: MergeStewardQueueCommands,
    failureClass: "policy_blocked" | "integration_conflict",
  ) {
    await queue.tryAdmit(100, "feat-a", "head-100");
    const entry = store.getEntryByPR("repo", 100)!;
    store.insertIncident({
      id: `incident-${failureClass}`,
      entryId: entry.id,
      at: new Date().toISOString(),
      failureClass,
      context: {
        version: 1,
        failureClass,
        baseSha: "main",
        prHeadSha: entry.headSha,
        queuePosition: entry.position,
        baseBranch: "main",
        branch: entry.branch,
        issueKey: null,
        retryHistory: [],
      },
      outcome: "open",
    });
    store.transition(entry.id, "evicted", {}, `evicted: ${failureClass}`);
  }

  it("offers a policy-blocked head again on the startup scan", async () => {
    const { store, queue } = evictedQueue();
    await evictAdmitted(store, queue, "policy_blocked");

    // A webhook is no reason to re-litigate a policy decision.
    assert.equal(await queue.tryAdmit(100, "feat-a", "head-100"), false);

    // A restart is: the policy that evicted it may not be the policy now.
    const { admitted } = await queue.scanEligibleOpenPrs();
    assert.equal(admitted, 1, "the same head is admitted again without a new push");
    assert.equal(store.getEntryByPR("repo", 100)?.status, "queued");
  });

  it("still holds a head evicted for something only a new push can fix", async () => {
    const { store, queue } = evictedQueue();
    await evictAdmitted(store, queue, "integration_conflict");

    const { admitted } = await queue.scanEligibleOpenPrs();
    assert.equal(admitted, 0, "a conflicting head unchanged would only conflict again");
    assert.equal(store.getEntryByPR("repo", 100), undefined);
  });
});

function basePr(overrides: Partial<PRStatus> & { number: number; branch: string }): PRStatus {
  return {
    number: overrides.number,
    branch: overrides.branch,
    headSha: `head-${overrides.number}`,
    mergeable: true,
    reviewDecision: "APPROVED",
    reviewApproved: true,
    merged: false,
    ...overrides,
  };
}
