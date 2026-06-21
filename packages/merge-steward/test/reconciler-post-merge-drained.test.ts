import assert from "node:assert/strict";
import test from "node:test";
import { MemoryStore } from "../src/memory-store.ts";
import { reconcile, type ReconcileContext } from "../src/reconciler.ts";
import type { CheckResult, QueueEntry, ReconcileEvent } from "../src/types.ts";

function mergedPendingEntry(overrides: Partial<QueueEntry> = {}): QueueEntry {
  return {
    id: "entry-1",
    repoId: "repo",
    prNumber: 10,
    branch: "feature",
    headSha: "branch-head",
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
    postMergeStatus: "pending",
    postMergeSha: "branch-head",
    postMergeSummary: "external merge detected, verification pending",
    postMergeCheckedAt: new Date(Date.now() - 6 * 60 * 60_000).toISOString(),
    waitDetail: null,
    prTitle: "Feature",
    headPatchId: null,
    specTreeId: null,
    enqueuedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function buildContext(store: MemoryStore, checks: CheckResult[], events: ReconcileEvent[]): ReconcileContext {
  const labels = new Map<number, string[]>([[10, ["queue", "queue:testing"]]]);
  return {
    store,
    repoId: "repo",
    baseBranch: "main",
    remotePrefix: "",
    git: {} as ReconcileContext["git"],
    ci: {} as ReconcileContext["ci"],
    github: {
      async listChecksForRef() { return checks; },
      async listLabels(prNumber: number) { return [...(labels.get(prNumber) ?? [])]; },
      async setLabels(prNumber: number, opts: { add?: string[]; remove?: string[] }) {
        const current = labels.get(prNumber) ?? [];
        const removed = current.filter((label) => !(opts.remove ?? []).includes(label));
        for (const label of opts.add ?? []) {
          if (!removed.includes(label)) removed.push(label);
        }
        labels.set(prNumber, removed);
      },
    } as unknown as ReconcileContext["github"],
    eviction: {} as ReconcileContext["eviction"],
    specBuilder: {} as ReconcileContext["specBuilder"],
    speculativeDepth: 1,
    flakyRetries: 0,
    policy: {
      getRequiredChecks: () => ["Tests"],
      shouldRequireAllChecksOnEmptyRequiredSet: () => false,
    } as unknown as ReconcileContext["policy"],
    queueStateLabels: { testing: "queue:testing", merging: "queue:merging" },
    onEvent: (event) => events.push(event),
  };
}

// Regression: a drained active queue used to early-return before the
// post-merge sweep, so an externally-merged PR sitting at post-merge "pending"
// (its required check is actually green) never resolved.
test("post-merge verification still runs when the active queue is empty", async () => {
  const store = new MemoryStore();
  store.insert(mergedPendingEntry());
  assert.equal(store.listActive("repo").length, 0, "precondition: no active entries");

  const events: ReconcileEvent[] = [];
  await reconcile(buildContext(store, [{ name: "Tests", conclusion: "success" }], events));

  const resolved = store.getEntry("entry-1");
  assert.equal(resolved?.postMergeStatus, "pass");
  assert.equal(resolved?.postMergeSummary, "all required checks passed");
  assert.equal(events.at(-1)?.action, "queue_label_synced");
});

test("decidedAt is stamped on the first terminal transition and never bumped", () => {
  const store = new MemoryStore();
  store.insert(mergedPendingEntry({ id: "e", status: "queued", decidedAt: null }));
  assert.equal(store.getEntry("e")?.decidedAt, null);

  store.transition("e", "merged");
  const firstDecidedAt = store.getEntry("e")?.decidedAt;
  assert.ok(firstDecidedAt, "decidedAt set when the entry first becomes terminal");

  // A post-merge re-check transitions to "merged" again; decidedAt must hold.
  store.transition("e", "merged", { postMergeCheckedAt: new Date().toISOString() });
  assert.equal(store.getEntry("e")?.decidedAt, firstDecidedAt);
});

test("listPostMergePending returns only unresolved merged entries", () => {
  const store = new MemoryStore();
  store.insert(mergedPendingEntry({ id: "pending", prNumber: 10, postMergeStatus: "pending" }));
  store.insert(mergedPendingEntry({ id: "passed", prNumber: 11, position: 2, postMergeStatus: "pass" }));
  store.insert(mergedPendingEntry({ id: "failed", prNumber: 12, position: 3, postMergeStatus: "fail" }));
  store.insert(mergedPendingEntry({ id: "active", prNumber: 13, position: 4, status: "validating", postMergeStatus: null }));

  assert.deepEqual(store.listPostMergePending("repo").map((e) => e.id), ["pending"]);
});
