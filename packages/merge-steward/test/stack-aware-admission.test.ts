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
    async listLabels() { return []; },
    async listOpenPRs() { return []; },
    async findPRByBranch() { return null; },
    async deleteBranch() { /* no-op */ },
    async listOpenPRsWithLabel() { return []; },
  };
}

function fakeSpecBuilder(): SpeculativeBranchBuilder {
  return {
    async buildSpeculative() { return { success: true, sha: "spec" }; },
    async deleteSpeculative() { /* no-op */ },
  };
}

const policy = {
  getRequiredChecks: () => [],
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

describe("plan §8.4 stack-aware admission", () => {
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

    const admitted = await queue.tryAdmit(100, "feat-a", "head-a");
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

    const admitted = await queue.tryAdmit(200, "feat-b", "head-b");
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

    const parentAdmitted = await queue.tryAdmit(100, "feat-a", "head-a");
    assert.equal(parentAdmitted, true);
    const childAdmitted = await queue.tryAdmit(200, "feat-b", "head-b");
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

    assert.equal(await queue.tryAdmit(100, "feat-a", "head-a"), true);
    assert.equal(await queue.tryAdmit(150, "feat-sibling", "head-sibling"), true);
    assert.equal(await queue.tryAdmit(200, "feat-b", "head-b"), true);

    const parent = store.getEntryByPR("repo", 100)!;
    const sibling = store.getEntryByPR("repo", 150)!;
    const child = store.getEntryByPR("repo", 200)!;
    assert.ok(parent.position < child.position, "parent must precede child");
    assert.ok(sibling.position < child.position, "sibling sits between parent and child by enqueue order");
    assert.ok(parent.position < sibling.position, "sibling was admitted after parent");
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
