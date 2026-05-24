import assert from "node:assert/strict";
import test from "node:test";
import { MemoryStore } from "../src/memory-store.ts";
import { GitHubSim } from "../src/sim/github-sim.ts";
import { syncQueueStateLabels } from "../src/reconciler-queue-labels.ts";
import type { ReconcileContext } from "../src/reconciler.ts";
import type { QueueEntry, QueueStatus, ReconcileEvent } from "../src/types.ts";

const LABELS = { testing: "queue:testing", merging: "queue:merging" };

function ctxWith(github: GitHubSim, events: ReconcileEvent[], enabled = true): ReconcileContext {
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
    queueStateLabels: enabled ? LABELS : undefined,
    onEvent: (event) => events.push(event),
  };
}

function entry(status: QueueStatus): QueueEntry {
  return { id: "e1", repoId: "repo", prNumber: 7, branch: "feat", status } as QueueEntry;
}

test("validating applies the testing label", async () => {
  const github = new GitHubSim();
  github.addPR({ number: 7, branch: "feat", headSha: "h" });
  const events: ReconcileEvent[] = [];

  await syncQueueStateLabels(ctxWith(github, events), entry("validating"));

  assert.deepEqual(await github.listLabels(7), ["queue:testing"]);
  assert.equal(events.at(-1)?.action, "queue_label_synced");
});

test("merging swaps testing for the merging label", async () => {
  const github = new GitHubSim();
  github.addPR({ number: 7, branch: "feat", headSha: "h", labels: ["queue:testing", "queue"] });
  const events: ReconcileEvent[] = [];

  await syncQueueStateLabels(ctxWith(github, events), entry("merging"));

  const labels = await github.listLabels(7);
  assert.ok(labels.includes("queue:merging"), "adds merging");
  assert.ok(!labels.includes("queue:testing"), "removes testing");
  assert.ok(labels.includes("queue"), "leaves unmanaged labels alone");
});

test("terminal/other phases clear both managed labels", async () => {
  const github = new GitHubSim();
  github.addPR({ number: 7, branch: "feat", headSha: "h", labels: ["queue:merging", "queue"] });
  const events: ReconcileEvent[] = [];

  await syncQueueStateLabels(ctxWith(github, events), entry("merged"));

  assert.deepEqual(await github.listLabels(7), ["queue"]);
});

test("idempotent: no second edit and no event when already correct", async () => {
  const github = new GitHubSim();
  github.addPR({ number: 7, branch: "feat", headSha: "h", labels: ["queue:testing"] });
  const events: ReconcileEvent[] = [];

  await syncQueueStateLabels(ctxWith(github, events), entry("validating"));

  assert.equal(events.length, 0, "no delta → no edit, no event");
});

test("disabled when queueStateLabels is unset", async () => {
  const github = new GitHubSim();
  github.addPR({ number: 7, branch: "feat", headSha: "h", labels: ["queue:testing"] });
  const events: ReconcileEvent[] = [];

  await syncQueueStateLabels(ctxWith(github, events, false), entry("merging"));

  assert.deepEqual(await github.listLabels(7), ["queue:testing"], "untouched");
  assert.equal(events.length, 0);
});
