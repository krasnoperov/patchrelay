import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MemoryStore } from "../../src/memory-store.ts";
import { prepareEntry } from "../../src/reconciler-prepare.ts";
import type { ReconcileContext } from "../../src/reconciler.ts";
import type {
  GitOperations,
  CIRunner,
  GitHubPRApi,
  EvictionReporter,
  SpeculativeBranchBuilder,
} from "../../src/interfaces.ts";
import type { QueueEntry, ReconcileEvent } from "../../src/types.ts";
import type { GitHubPolicyCache } from "../../src/github-policy.ts";

// Plan §5.3: focused unit test for the patch-id-aware updateHead
// short-circuit. The reconciler-prepare path detects branch_mismatch,
// then attempts the rebuild. We construct a minimal context with
// stub git/CI/store and assert the short-circuit fires when patch-id
// and spec tree match, and falls through to the standard updateHead
// path when they don't.

function makeEntry(overrides: Partial<QueueEntry> = {}): QueueEntry {
  return {
    id: "qe-1",
    repoId: "repo",
    prNumber: 42,
    branch: "feat/x",
    headSha: "old-head",
    baseSha: "base-old",
    status: "validating",
    position: 1,
    priority: 0,
    generation: 0,
    ciRunId: "ci-old",
    ciRetries: 0,
    retryAttempts: 0,
    maxRetries: 3,
    lastFailedBaseSha: null,
    issueKey: null,
    specBranch: "mq-spec-qe-1",
    specSha: "spec-old",
    specBasedOn: null,
    waitDetail: null,
    postMergeStatus: null,
    postMergeSha: null,
    postMergeSummary: null,
    postMergeCheckedAt: null,
    headPatchId: "patchid-stable",
    specTreeId: "tree-stable",
    enqueuedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

interface StubProbeOptions {
  newHead: string;
  baseSha: string;
  patchId?: string;
  treeId?: string;
  newSpecSha?: string;
}

function stubGit(options: StubProbeOptions): GitOperations {
  const calls: string[] = [];
  const ops: GitOperations & { calls: string[] } = {
    calls,
    async fetch() { calls.push("fetch"); },
    async headSha(branch) {
      if (branch === "main" || branch === "main-ref") return options.baseSha;
      return options.newHead;
    },
    async isAncestor() { return false; },
    async push(branch) { calls.push(`push:${branch}`); },
    async patchIdAgainst() { return options.patchId; },
    async integrationTreeId() { return options.treeId; },
    async treeId() { return options.treeId; },
    async commitTree(tree, parents) {
      calls.push(`commitTree:${tree}:${parents.join(",")}`);
      return options.newSpecSha;
    },
    async pushCommit(sha, branch) {
      calls.push(`pushCommit:${sha}->${branch}`);
    },
  };
  return ops;
}

function stubCi(): CIRunner {
  const calls: string[] = [];
  let counter = 0;
  return {
    async triggerRun() {
      counter += 1;
      calls.push(`trigger-${counter}`);
      return `ci-new-${counter}`;
    },
    async getStatus() { return "pass"; },
    async cancelRun() { /* no-op */ },
  } as CIRunner;
}

function stubGitHub(): GitHubPRApi {
  return {
    async mergePR() { /* no-op */ },
    async getStatus() { throw new Error("not used"); },
    async listChecks() { return []; },
    async listChecksForRef() { return []; },
    async listLabels() { return []; },
    async setLabels() {},
    async listOpenPRs() { return []; },
    async findPRByBranch() { return null; },
    async deleteBranch() { /* no-op */ },
    async listOpenPRsWithLabel() { return []; },
  };
}

function stubEviction(): EvictionReporter & { specReadyEvents: Array<{ specSha: string }> } {
  const specReadyEvents: Array<{ specSha: string }> = [];
  return {
    async reportEviction() { /* no-op */ },
    async reportSpecReady(_entry, _branch, specSha) {
      specReadyEvents.push({ specSha });
    },
    specReadyEvents,
  };
}

function stubSpecBuilder(): SpeculativeBranchBuilder {
  return {
    async buildSpeculative() { return { success: true, sha: "fresh-spec" }; },
    async deleteSpeculative() { /* no-op */ },
  };
}

const policy = {
  getRequiredChecks: () => [],
  refreshOnIssue: async () => ({ attempted: false, changed: false, requiredChecks: [], previousRequiredChecks: [] }),
} as unknown as GitHubPolicyCache;

function buildContext(opts: {
  store: MemoryStore;
  git: GitOperations;
  ci: CIRunner;
  github: GitHubPRApi;
  eviction: EvictionReporter;
  events: ReconcileEvent[];
}): ReconcileContext {
  return {
    store: opts.store,
    repoId: "repo",
    baseBranch: "main",
    remotePrefix: "",
    git: opts.git,
    ci: opts.ci,
    github: opts.github,
    eviction: opts.eviction,
    specBuilder: stubSpecBuilder(),
    speculativeDepth: 1,
    flakyRetries: 0,
    policy,
    onEvent: (event) => opts.events.push(event),
  };
}

describe("plan §5.3 patch-id-aware updateHead short-circuit", () => {
  it("rebuilds same-tree spec commit when patch-id and tree match", async () => {
    const store = new MemoryStore();
    const entry = makeEntry();
    store.insert(entry);

    const events: ReconcileEvent[] = [];
    const eviction = stubEviction();
    const ctx = buildContext({
      store,
      git: stubGit({
        newHead: "new-head",
        baseSha: "base-old",
        patchId: "patchid-stable",
        treeId: "tree-stable",
        newSpecSha: "spec-new",
      }),
      ci: stubCi(),
      github: stubGitHub(),
      eviction,
      events,
    });

    await prepareEntry(ctx, entry, true, null);

    const updated = store.getEntry(entry.id)!;
    assert.equal(updated.headSha, "new-head");
    assert.equal(updated.specSha, "spec-new");
    assert.equal(updated.specBranch, "mq-spec-qe-1", "spec branch preserved");
    assert.equal(updated.status, "validating");
    assert.equal(updated.headPatchId, "patchid-stable");
    assert.equal(updated.specTreeId, "tree-stable");
    assert.equal(updated.ciRunId, "ci-new-1", "CI re-triggered on new spec sha");

    const actions = events.map((e) => e.action);
    assert.ok(actions.includes("branch_mismatch"));
    assert.ok(actions.includes("spec_build_succeeded"));
    assert.ok(actions.includes("ci_triggered"));
    assert.equal(eviction.specReadyEvents.length, 1, "spec-ready re-emitted");
  });

  it("falls back to full updateHead when patch-id differs", async () => {
    const store = new MemoryStore();
    const entry = makeEntry();
    store.insert(entry);

    const events: ReconcileEvent[] = [];
    const ctx = buildContext({
      store,
      git: stubGit({
        newHead: "new-head",
        baseSha: "base-old",
        patchId: "patchid-changed",
        treeId: "tree-stable",
        newSpecSha: "should-not-build",
      }),
      ci: stubCi(),
      github: stubGitHub(),
      eviction: stubEviction(),
      events,
    });

    await prepareEntry(ctx, entry, true, null);

    const updated = store.getEntry(entry.id)!;
    assert.equal(updated.headSha, "new-head");
    assert.equal(updated.status, "queued", "should fall back to standard updateHead");
    assert.equal(updated.specSha, null, "spec cleared on full updateHead");
    assert.equal(updated.headPatchId, null, "cached identity cleared");
  });

  it("falls back when spec tree id differs", async () => {
    const store = new MemoryStore();
    const entry = makeEntry();
    store.insert(entry);

    const events: ReconcileEvent[] = [];
    const ctx = buildContext({
      store,
      git: stubGit({
        newHead: "new-head",
        baseSha: "base-old",
        patchId: "patchid-stable",
        treeId: "tree-different",
        newSpecSha: "should-not-build",
      }),
      ci: stubCi(),
      github: stubGitHub(),
      eviction: stubEviction(),
      events,
    });

    await prepareEntry(ctx, entry, true, null);

    const updated = store.getEntry(entry.id)!;
    assert.equal(updated.status, "queued", "should fall back when tree differs");
  });

  it("falls back when cached identity is missing (legacy entry)", async () => {
    const store = new MemoryStore();
    const entry = makeEntry({ headPatchId: null, specTreeId: null });
    store.insert(entry);

    const events: ReconcileEvent[] = [];
    const ctx = buildContext({
      store,
      git: stubGit({
        newHead: "new-head",
        baseSha: "base-old",
        patchId: "patchid-stable",
        treeId: "tree-stable",
        newSpecSha: "should-not-build",
      }),
      ci: stubCi(),
      github: stubGitHub(),
      eviction: stubEviction(),
      events,
    });

    await prepareEntry(ctx, entry, true, null);

    assert.equal(store.getEntry(entry.id)!.status, "queued");
  });
});
