import assert from "node:assert/strict";
import test from "node:test";
import { createFactoryGitHubReader, type FactoryPullRequest } from "../src/factory/github.ts";
import { buildCurrentFactoryProjects } from "../src/factory/current-work.ts";
import type { FactoryIssue } from "../src/factory/model.ts";

const now = Date.parse("2026-09-05T12:00:00Z");
const repo = "org/app";
const configs = [{ id: "app", github: { repoFullName: repo } }];
const pr = (number: number, fields: Partial<FactoryPullRequest> = {}): FactoryPullRequest => ({ number, title: `Work ${number}`, state: "open", head: { sha: "current" }, draft: false, updated_at: "2026-09-05T10:00:00Z", merged_at: null, ...fields });
const issue = (fields: Partial<FactoryIssue> = {}): FactoryIssue => ({ projectId: "app", issueKey: "APP-1", phase: "implementing", delegatedToPatchRelay: true, blockedByCount: 0, blockedByKeys: [], readyForExecution: true, updatedAt: "2026-09-05T10:00:00Z", ...fields });

test("current work retains old open PRs, recent merges, and active implementation; omits closed and historical work", () => {
  const prs = [pr(1, { state: "closed", merged_at: "2020-01-01T00:00:00Z" }), pr(1285, { state: "closed" }), pr(5, { updated_at: "2020-01-01T00:00:00Z" }), pr(6, { state: "closed", merged_at: "2026-09-04T00:00:00Z" })];
  const queues = [1, 1285, 5, 6].map(prNumber => ({ repo, prNumber, headSha: "old", status: "evicted", position: prNumber, updatedAt: "2026-09-05T10:00:00Z" }));
  const world = buildCurrentFactoryProjects(configs, [issue({ updatedAt: "2020-01-01T00:00:00Z", activeRunType: "implementation" }), issue({ issueKey: "APP-2", phase: "done" }), issue({ issueKey: "APP-3", phase: "failed", updatedAt: "2020-01-01T00:00:00Z" })], queues, [], [{ repo, available: true, prs }], now);
  const tasks = world[0]!.tasks;
  assert.deepEqual(tasks.filter(t => t.prNumber).map(t => t.prNumber).sort(), [5, 6]);
  assert.equal(tasks.find(t => t.prNumber === 5)!.signal, "waiting");
  assert.equal(tasks.find(t => t.prNumber === 5)!.queue, undefined);
  assert.equal(tasks.find(t => t.prNumber === 6)!.station, "main");
  assert.equal(tasks.find(t => t.prNumber === 6)!.signal, "complete");
  assert.deepEqual(tasks.filter(t => t.issueKey).map(t => t.issueKey), ["APP-1"]);
});

test("current GitHub head clears stale repair state, while matching queue and review observations remain actionable", () => {
  const queues = [{ repo, prNumber: 2, headSha: "current", status: "queued", position: 500, updatedAt: "2026-09-05T10:00:00Z" }];
  const reviews = [{ repo, prNumber: 2, headSha: "current", status: "completed", conclusion: "declined", updatedAt: "2026-09-05T10:00:00Z" }];
  const tasks = buildCurrentFactoryProjects(configs, [issue({ prNumber: 3, prHeadSha: "old", phase: "changes_requested", statusNote: "Old repair" })], queues, reviews, [{ repo, available: true, prs: [pr(2), pr(3)] }], now)[0]!.tasks;
  assert.equal(tasks.find(t => t.prNumber === 2)!.signal, "attention");
  assert.equal(tasks.find(t => t.prNumber === 2)!.queue?.position, 1);
  assert.equal(tasks.find(t => t.prNumber === 3)!.signal, "waiting");
  assert.equal(tasks.find(t => t.prNumber === 3)!.repairing, false);
  assert.equal(tasks.find(t => t.prNumber === 3)!.note, undefined);
});

test("unavailable GitHub repositories do not turn historical observations into current alerts", () => {
  const tasks = buildCurrentFactoryProjects(configs, [issue({ prNumber: 1285, prState: "open" })], [{ repo, prNumber: 1285, headSha: "old", status: "evicted", position: 1, updatedAt: "2026-09-05T00:00:00Z" }], [], [{ repo, available: false, prs: [] }], now)[0]!.tasks;
  assert.equal(tasks.length, 0);
});

test("GitHub reader paginates old open PRs, bounds closed history by date, and caches reads", async () => {
  const calls: string[] = [];
  const read = createFactoryGitHubReader(async (_cmd, args) => {
    const path = args[1]!;
    calls.push(path);
    const open = path.includes("state=open");
    const pageOne = new URLSearchParams(path.split("?")[1]).get("page") === "1";
    const rows = open
      ? pageOne ? Array.from({ length: 100 }, (_, i) => pr(i + 1)) : [pr(101, { updated_at: "2020-01-01T00:00:00Z" })]
      : Array.from({ length: 100 }, (_, i) => pr(i + 200, { state: "closed", updated_at: "2020-01-01T00:00:00Z", merged_at: "2020-01-01T00:00:00Z" }));
    return { exitCode: 0, stderr: "", stdout: JSON.stringify(rows) };
  }, () => now);
  const result = await read([repo]);
  assert.equal(result[0]!.available, true);
  assert.equal(result[0]!.prs.length, 101);
  await read([repo]);
  assert.equal(calls.length, 3);
});

test("GitHub reader retries after its cache expires and reports failures without stale data", async () => {
  let clock = now;
  let fail = false;
  const read = createFactoryGitHubReader(async () => {
    if (fail) throw new Error("private credential context");
    return { exitCode: 0, stderr: "", stdout: "[]" };
  }, () => clock);
  assert.equal((await read([repo]))[0]!.available, true);
  fail = true;
  clock += 60_001;
  const failed = (await read([repo]))[0]!;
  assert.equal(failed.available, false);
  assert.deepEqual(failed.prs, []);
  assert.doesNotMatch(JSON.stringify(failed), /credential/);
});
