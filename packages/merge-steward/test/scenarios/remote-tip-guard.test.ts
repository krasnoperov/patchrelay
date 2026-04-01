import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { CIRunner, EvictionReporter, GitHubPRApi, GitOperations } from "../../src/interfaces.ts";
import { MemoryStore } from "../../src/memory-store.ts";
import { reconcile, type ReconcileContext } from "../../src/reconciler.ts";
import type { QueueEntry, CheckResult, CIStatus, IncidentRecord, PRStatus, QueueEntryStatus, ReconcileEvent } from "../../src/types.ts";

class FakeGit implements GitOperations {
  private readonly refs = new Map<string, string>();
  private readonly ancestry = new Map<string, boolean>();
  private fetchCount = 0;
  readonly pushes: Array<{ branch: string; force: boolean | undefined }> = [];

  constructor(initialRefs: Record<string, string>, private readonly onFetch?: (count: number, refs: Map<string, string>) => void) {
    for (const [name, sha] of Object.entries(initialRefs)) {
      this.refs.set(name, sha);
    }
  }

  setAncestor(ancestor: string, descendant: string, value: boolean): void {
    this.ancestry.set(`${ancestor}->${descendant}`, value);
  }

  async fetch(): Promise<void> {
    this.fetchCount += 1;
    this.onFetch?.(this.fetchCount, this.refs);
  }

  async headSha(branch: string): Promise<string> {
    const sha = this.refs.get(branch);
    if (!sha) throw new Error(`Unknown ref: ${branch}`);
    return sha;
  }

  async isAncestor(ancestor: string, descendant: string): Promise<boolean> {
    return this.ancestry.get(`${ancestor}->${descendant}`) ?? ancestor === descendant;
  }

  async rebase(branch: string, _onto: string) {
    this.refs.set(branch, "candidate-sha");
    return { success: true as const, newHeadSha: "candidate-sha" };
  }

  async push(branch: string, force?: boolean): Promise<void> {
    this.pushes.push({ branch, force });
    const sha = await this.headSha(branch);
    this.refs.set(`origin/${branch}`, sha);
  }
}

class FakeCI implements CIRunner {
  readonly triggered: Array<{ branch: string; sha: string }> = [];

  async triggerRun(branch: string, sha: string): Promise<string> {
    this.triggered.push({ branch, sha });
    return `ci-${this.triggered.length}`;
  }

  async getStatus(_runId: string): Promise<CIStatus> {
    return "pass";
  }

  async cancelRun(_runId: string): Promise<void> {}
}

class FakeGitHub implements GitHubPRApi {
  async mergePR(_prNumber: number): Promise<void> {}
  async getStatus(prNumber: number): Promise<PRStatus> {
    return { number: prNumber, branch: "feature", headSha: "candidate-sha", mergeable: true, reviewApproved: true, merged: false };
  }
  async listChecks(_prNumber: number): Promise<CheckResult[]> {
    return [];
  }
  async listChecksForRef(_ref: string): Promise<CheckResult[]> {
    return [];
  }
  async listLabels(_prNumber: number): Promise<string[]> {
    return ["queue"];
  }
  async findPRByBranch(_branch: string): Promise<number | null> {
    return 1;
  }
}

class FakeEvictionReporter implements EvictionReporter {
  async reportEviction(_entry: QueueEntry, _incident: IncidentRecord): Promise<void> {}
}

function createEntry(status: QueueEntryStatus = "preparing_head"): QueueEntry {
  return {
    id: "qe-1",
    repoId: "repo-1",
    prNumber: 1,
    branch: "feature",
    headSha: "entry-sha",
    baseSha: "base-sha",
    status,
    position: 1,
    priority: 0,
    generation: 0,
    ciRunId: null,
    ciRetries: 0,
    retryAttempts: 0,
    maxRetries: 3,
    lastFailedBaseSha: null,
    issueKey: null,
    specBranch: null,
    specSha: null,
    specBasedOn: null,
    enqueuedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function createContext(git: GitOperations, store: MemoryStore, ci: CIRunner, onEvent: (event: ReconcileEvent) => void): ReconcileContext {
  return {
    store,
    repoId: "repo-1",
    baseBranch: "main",
    remotePrefix: "origin/",
    git,
    ci,
    github: new FakeGitHub(),
    eviction: new FakeEvictionReporter(),
    specBuilder: null,
    speculativeDepth: 1,
    flakyRetries: 0,
    onEvent,
  };
}

describe("remote tip guard", () => {
  it("requeues instead of force-pushing over a newer remote head", async () => {
    const store = new MemoryStore();
    store.insert(createEntry());

    const git = new FakeGit(
      {
        "feature": "entry-sha",
        "origin/feature": "entry-sha",
        "origin/main": "base-sha",
      },
      (count, refs) => {
        if (count === 2) refs.set("origin/feature", "remote-new-sha");
      },
    );
    git.setAncestor("remote-new-sha", "candidate-sha", false);

    const ci = new FakeCI();
    const events: ReconcileEvent[] = [];
    await reconcile(createContext(git, store, ci, (event) => events.push(event)));

    const entry = store.getEntry("qe-1");
    assert.ok(entry);
    assert.strictEqual(entry.status, "queued");
    assert.strictEqual(entry.headSha, "remote-new-sha");
    assert.strictEqual(entry.generation, 1);
    assert.deepStrictEqual(git.pushes, []);
    assert.deepStrictEqual(ci.triggered, []);
    assert.ok(events.some((event) => event.action === "branch_mismatch" && event.detail?.includes("remote advanced during rebase")));
  });

  it("requeues instead of force-pushing a stale local branch over the same remote tip", async () => {
    const store = new MemoryStore();
    store.insert(createEntry());

    const git = new FakeGit({
      "feature": "entry-sha",
      "origin/feature": "entry-sha",
      "origin/main": "base-sha",
    });
    git.setAncestor("entry-sha", "candidate-sha", false);

    const ci = new FakeCI();
    const events: ReconcileEvent[] = [];
    await reconcile(createContext(git, store, ci, (event) => events.push(event)));

    const entry = store.getEntry("qe-1");
    assert.ok(entry);
    assert.strictEqual(entry.status, "queued");
    assert.strictEqual(entry.headSha, "entry-sha");
    assert.strictEqual(entry.generation, 0);
    assert.deepStrictEqual(git.pushes, []);
    assert.deepStrictEqual(ci.triggered, []);
    assert.ok(events.some((event) => event.action === "branch_mismatch" && event.detail?.includes("candidate diverged from remote head")));
  });

  it("continues when the refreshed remote head is already contained in the candidate", async () => {
    const store = new MemoryStore();
    store.insert(createEntry());

    const git = new FakeGit(
      {
        "feature": "entry-sha",
        "origin/feature": "entry-sha",
        "origin/main": "base-sha",
      },
      (count, refs) => {
        if (count === 2) refs.set("origin/feature", "candidate-sha");
      },
    );

    const ci = new FakeCI();
    await reconcile(createContext(git, store, ci, () => {}));

    const entry = store.getEntry("qe-1");
    assert.ok(entry);
    assert.strictEqual(entry.status, "validating");
    assert.strictEqual(entry.headSha, "candidate-sha");
    assert.strictEqual(ci.triggered.length, 1);
    assert.deepStrictEqual(git.pushes, [{ branch: "feature", force: true }]);
  });
});
