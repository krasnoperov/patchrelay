import assert from "node:assert/strict";
import test from "node:test";
import { buildEntryStateGraph, buildExternalRepairObservations } from "../src/watch/state-visualization.ts";
import type { QueueEntryDetail } from "../src/types.ts";

function makeDetail(overrides?: Partial<QueueEntryDetail>): QueueEntryDetail {
  return {
    entry: {
      id: "entry-1",
      repoId: "repo-1",
      prNumber: 41,
      branch: "feat/state-graph",
      headSha: "abcdef123456",
      baseSha: "base123456789",
      status: "queued",
      position: 2,
      priority: 0,
      generation: 0,
      ciRunId: null,
      ciRetries: 0,
      retryAttempts: 0,
      maxRetries: 2,
      lastFailedBaseSha: null,
      issueKey: "USE-41",
      enqueuedAt: "2026-03-28T12:00:00.000Z",
      updatedAt: "2026-03-28T12:05:00.000Z",
    },
    events: [
      {
        entryId: "entry-1",
        at: "2026-03-28T12:00:00.000Z",
        fromStatus: null,
        toStatus: "queued",
      },
    ],
    incidents: [],
    ...overrides,
  };
}

test("merge-steward entry graph tracks visited nodes from events", () => {
  const detail = makeDetail({
    entry: {
      ...makeDetail().entry,
      status: "validating",
    },
    events: [
      {
        entryId: "entry-1",
        at: "2026-03-28T12:00:00.000Z",
        fromStatus: null,
        toStatus: "queued",
      },
      {
        entryId: "entry-1",
        at: "2026-03-28T12:01:00.000Z",
        fromStatus: "queued",
        toStatus: "preparing_head",
      },
      {
        entryId: "entry-1",
        at: "2026-03-28T12:02:00.000Z",
        fromStatus: "preparing_head",
        toStatus: "validating",
      },
    ],
  });

  const graph = buildEntryStateGraph(detail);

  assert.equal(graph.main.find((node) => node.state === "validating")?.status, "current");
  assert.equal(graph.main.find((node) => node.state === "queued")?.status, "visited");
  assert.equal(graph.main.find((node) => node.state === "merging")?.status, "upcoming");
});

test("merge-steward observations explain queue position for non-head entries", () => {
  const detail = makeDetail();
  const observations = buildExternalRepairObservations(detail, {
    isHead: false,
    activeIndex: 2,
    activeCount: 4,
    headPrNumber: 40,
    queueBlock: null,
  });

  assert.match(observations[0]?.text ?? "", /Position 2 of 4/);
});

test("merge-steward observations explain eviction and repair expectation", () => {
  const detail = makeDetail({
    entry: {
      ...makeDetail().entry,
      status: "evicted",
      lastFailedBaseSha: "deadbeef1234",
    },
    incidents: [{
      id: "incident-1",
      entryId: "entry-1",
      at: "2026-03-28T12:10:00.000Z",
      failureClass: "integration_conflict",
      outcome: "open",
      context: {
        version: 1,
        failureClass: "integration_conflict",
        baseSha: "deadbeef1234",
        prHeadSha: "abcdef123456",
        queuePosition: 2,
        retryHistory: [],
      },
    }],
  });

  const observations = buildExternalRepairObservations(detail, {
    isHead: false,
    activeIndex: null,
    activeCount: 0,
    headPrNumber: null,
    queueBlock: null,
  });

  assert.match(observations[0]?.text ?? "", /needs repair/i);
  assert.match(observations[1]?.text ?? "", /integration_conflict/);
  assert.match(observations[2]?.text ?? "", /Conflicts with main/);
});

test("merge-steward observations explain when the head is blocked by unhealthy main", () => {
  const detail = makeDetail({
    entry: {
      ...makeDetail().entry,
      status: "preparing_head",
    },
  });

  const observations = buildExternalRepairObservations(detail, {
    isHead: true,
    activeIndex: 1,
    activeCount: 2,
    headPrNumber: 41,
    queueBlock: {
      reason: "main_broken",
      entryId: "entry-1",
      headPrNumber: 41,
      baseBranch: "main",
      baseSha: "abc123def456",
      observedAt: "2026-03-28T12:06:00.000Z",
      failingChecks: [{ name: "Tests", conclusion: "failure" }],
      pendingChecks: [],
      missingRequiredChecks: [],
    },
  });

  assert.match(observations[0]?.text ?? "", /main is unhealthy/i);
  assert.match(observations[0]?.text ?? "", /Tests/);
});

test("merge-steward observations explain when the head is waiting for main verification", () => {
  const detail = makeDetail({
    entry: {
      ...makeDetail().entry,
      status: "preparing_head",
    },
  });

  const observations = buildExternalRepairObservations(detail, {
    isHead: true,
    activeIndex: 1,
    activeCount: 2,
    headPrNumber: 41,
    queueBlock: {
      reason: "main_broken",
      entryId: "entry-1",
      headPrNumber: 41,
      baseBranch: "main",
      baseSha: "abc123def456",
      observedAt: "2026-03-28T12:06:00.000Z",
      failingChecks: [],
      pendingChecks: [{ name: "verify", conclusion: "pending" }],
      missingRequiredChecks: [],
    },
  });

  assert.match(observations[0]?.text ?? "", /still verifying/i);
  assert.match(observations[0]?.text ?? "", /verify/);
});

test("merge-steward observations explain when main is missing a required check", () => {
  const detail = makeDetail({
    entry: {
      ...makeDetail().entry,
      status: "preparing_head",
    },
  });

  const observations = buildExternalRepairObservations(detail, {
    isHead: true,
    activeIndex: 1,
    activeCount: 2,
    headPrNumber: 41,
    queueBlock: {
      reason: "main_broken",
      entryId: "entry-1",
      headPrNumber: 41,
      baseBranch: "main",
      baseSha: "abc123def456",
      observedAt: "2026-03-28T12:06:00.000Z",
      failingChecks: [],
      pendingChecks: [],
      missingRequiredChecks: ["Tests"],
    },
  });

  assert.match(observations[0]?.text ?? "", /missing required checks/i);
  assert.match(observations[0]?.text ?? "", /Tests/);
  assert.match(observations[0]?.text ?? "", /operator action/i);
});
