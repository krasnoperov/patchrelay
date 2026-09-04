import assert from "node:assert/strict";
import test from "node:test";
import {
  buildFactoryProjects,
  type FactoryIssue,
  type QueueObservation,
} from "../src/factory/model.ts";
import { createFactorySnapshotReader } from "../src/factory/snapshot.ts";

const projects = [
  { id: "factory", github: { repoFullName: "org/factory" } },
  { id: "empty" },
];
function issue(fields: Partial<FactoryIssue> = {}): FactoryIssue {
  return {
    projectId: "factory",
    issueKey: "FAC-1",
    title: "Real work",
    phase: "implementing",
    delegatedToPatchRelay: true,
    blockedByCount: 0,
    blockedByKeys: [],
    readyForExecution: true,
    updatedAt: "2026-09-05T12:00:00Z",
    ...fields,
  };
}
const queue: QueueObservation = {
  repo: "org/factory",
  prNumber: 9,
  headSha: "current",
  status: "validating",
  position: 7,
  updatedAt: "2026-09-05T12:00:00Z",
};
function task(
  fields: Partial<FactoryIssue> = {},
  queues: QueueObservation[] = [],
) {
  return buildFactoryProjects(projects, [issue(fields)], queues).find(
    (p) => p.id === "factory",
  )!.tasks[0]!;
}

test("factory preserves empty projects and places issue phases without calling no-PR completion a merge", () => {
  assert.equal(buildFactoryProjects(projects, [issue()]).length, 2);
  assert.equal(task().station, "implementation");
  assert.equal(task({ phase: "pr_open", prNumber: 9 }).station, "review");
  assert.equal(task({ phase: "awaiting_queue", prNumber: 9 }).station, "queue");
  assert.equal(task({ phase: "done" }).station, "intake");
  assert.equal(task({ phase: "done" }).signal, "complete");
  assert.equal(task({ phase: "deploying", prState: "merged" }).station, "main");
  assert.equal(
    task({ phase: "deploying", prState: "merged" }).phase,
    "deploying",
  );
});

test("queue positions come only from the observed current head", () => {
  const fields = { phase: "awaiting_queue", prNumber: 9, prHeadSha: "current" };
  assert.equal(task(fields).queue, undefined);
  assert.equal(task(fields, [queue]).queue?.position, 7);
  assert.equal(task(fields, [queue]).signal, "active");
  assert.equal(
    task({ ...fields, prHeadSha: "new-head" }, [queue]).queue,
    undefined,
  );
  assert.equal(
    task({ phase: "awaiting_queue", prNumber: 9 }, [queue]).queue,
    undefined,
  );
});

test("requested changes keeps repair in implementation and the native phase stays separate", () => {
  const result = task(
    {
      phase: "changes_requested",
      prNumber: 9,
      prHeadSha: "current",
      activeRunType: "review_fix",
    },
    [queue],
  );
  assert.equal(result.station, "implementation");
  assert.equal(result.repairing, true);
  assert.equal(result.signal, "attention");
  assert.equal(result.phase, "changes_requested");
  assert.equal(result.queue?.status, "validating");
});

test("paused PRs keep their review station and do not claim active agent work", () => {
  const result = task({
    phase: "paused",
    prNumber: 9,
    delegatedToPatchRelay: false,
    activeRunType: "implementation",
  });
  assert.equal(result.station, "review");
  assert.equal(result.paused, true);
  assert.equal(result.signal, "waiting");
});

test("evicted and dequeued entries need attention; post-merge failure is not hidden", () => {
  for (const status of ["evicted", "dequeued"]) {
    assert.equal(
      task({ phase: "awaiting_queue", prNumber: 9, prHeadSha: "current" }, [
        { ...queue, status },
      ]).signal,
      "attention",
    );
  }
  const merged = task(
    { phase: "failed", prState: "merged", prNumber: 9, prHeadSha: "current" },
    [{ ...queue, status: "merged" }],
  );
  assert.equal(merged.station, "main");
  assert.equal(merged.signal, "attention");
});

test("queue-only repositories and PRs appear once, using their newest observation", () => {
  const world = buildFactoryProjects(
    [],
    [],
    [
      queue,
      { ...queue, repo: "org/another" },
      { ...queue, status: "merged", updatedAt: "2026-09-05T13:00:00Z" },
    ],
  );
  assert.equal(world.length, 2);
  const factory = world.find((p) => p.repo === "org/factory")!;
  assert.equal(factory.tasks.length, 1);
  assert.equal(factory.tasks[0]!.station, "main");
});

test("a previous head's approval cannot replace current review state", () => {
  const world = buildFactoryProjects(
    projects,
    [issue({ prNumber: 9, prHeadSha: "new", prReviewState: "pending" })],
    [],
    [
      {
        repo: "org/factory",
        prNumber: 9,
        headSha: "old",
        status: "completed",
        conclusion: "approved",
        updatedAt: "2026-09-05T13:00:00Z",
      },
    ],
  );
  assert.equal(
    world.find((p) => p.id === "factory")!.tasks[0]!.review,
    "pending",
  );
});

test("review-only repositories are visible and running reviews activate their station", () => {
  const reviews = [
    {
      repo: "org/review-only",
      prNumber: 11,
      headSha: "head",
      status: "running",
      updatedAt: "2026-09-05T13:00:00Z",
    },
  ];
  const external = buildFactoryProjects([], [], [], reviews)[0]!.tasks[0]!;
  assert.equal(external.station, "review");
  assert.equal(external.signal, "active");
  const tracked = buildFactoryProjects(
    projects,
    [issue({ phase: "pr_open", prNumber: 11, prHeadSha: "head" })],
    [],
    [{ ...reviews[0]!, repo: "org/factory" }],
  );
  assert.equal(
    tracked.find((p) => p.id === "factory")!.tasks[0]!.signal,
    "active",
  );
});

test("snapshot uses discovered repo IDs, preserves working queues during partial failures, and drops stale reviews", async () => {
  const paths: string[] = [];
  const read = createFactorySnapshotReader(
    { projects } as never,
    {
      listTrackedIssues: () => [
        issue({
          phase: "pr_open",
          prNumber: 9,
          prHeadSha: "current",
          prReviewState: "pending",
        }),
      ],
      getReadiness: () => ({ ready: true, linearConnected: true }) as never,
    },
    {
      mergeStewardUrl: "http://queue.local",
      reviewQuillUrl: "http://review.local",
    },
    (async (url) => {
      const path = new URL(String(url)).pathname;
      paths.push(path);
      if (path === "/health")
        return Response.json({
          repos: [
            { repoId: "custom-id", repoFullName: "org/factory" },
            { repoId: "broken", repoFullName: "org/broken" },
          ],
        });
      if (path === "/repos/custom-id/queue/watch")
        return Response.json({
          entries: [{ ...queue, prTitle: "Queued work" }],
        });
      if (path === "/watch")
        return Response.json({
          attempts: [
            {
              repoFullName: "org/factory",
              prNumber: 9,
              headSha: "current",
              status: "completed",
              conclusion: "approved",
              stale: true,
              updatedAt: queue.updatedAt,
            },
          ],
        });
      return new Response("Unavailable", { status: 503 });
    }) as typeof fetch,
  );
  const snapshot = await read();
  assert.ok(paths.includes("/repos/custom-id/queue/watch"));
  assert.equal(
    snapshot.sources.find((s) => s.id === "queue")!.state,
    "unavailable",
  );
  const current = snapshot.projects.find((p) => p.id === "factory")!.tasks[0]!;
  assert.equal(current.queue?.position, 7);
  assert.equal(current.review, "pending");
});

test("snapshot sources fail independently, deduplicate concurrent reads, and never expose configuration", async () => {
  let calls = 0;
  const read = createFactorySnapshotReader(
    { projects } as never,
    {
      listTrackedIssues: () => [issue()],
      getReadiness: () => ({ ready: true, linearConnected: true }) as never,
    },
    {
      mergeStewardUrl: "http://queue.local",
      reviewQuillUrl: "http://review.local",
    },
    (async (url) => {
      calls++;
      if (String(url).includes("queue.local"))
        throw new Error("private internal detail");
      return new Response(JSON.stringify({ attempts: [] }));
    }) as typeof fetch,
  );
  const [a, b] = await Promise.all([read(), read()]);
  assert.equal(a, b);
  assert.equal(calls, 2);
  assert.equal(a.sources.find((s) => s.id === "queue")!.state, "unavailable");
  assert.equal(a.sources.find((s) => s.id === "review")!.state, "connected");
  assert.equal(a.projects.find((p) => p.id === "factory")!.tasks.length, 1);
  assert.doesNotMatch(
    JSON.stringify(a),
    /private internal|queue.local|review.local/,
  );
});
