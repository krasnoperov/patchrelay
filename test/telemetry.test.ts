import assert from "node:assert/strict";
import test from "node:test";
import { OperatorEventFeed } from "../src/operator-feed.ts";
import {
  FanoutPatchRelayTelemetry,
  LoggerTelemetrySink,
  MemoryPatchRelayTelemetry,
  OperatorFeedTelemetrySink,
  type PatchRelayTelemetry,
} from "../src/telemetry.ts";

test("telemetry fanout keeps workflow-safe delivery when one sink throws", () => {
  const memory = new MemoryPatchRelayTelemetry();
  const throwing: PatchRelayTelemetry = {
    emit: () => {
      throw new Error("sink failed");
    },
  };
  const telemetry = new FanoutPatchRelayTelemetry([throwing, memory]);

  assert.doesNotThrow(() => telemetry.emit({
    type: "wake.suppressed",
    projectId: "proj",
    linearIssueId: "issue-1",
    reason: "blocked",
    blockerCount: 1,
  }));
  assert.equal(memory.list("wake.suppressed").length, 1);
});

test("operator feed telemetry sink publishes only curated human-facing events", () => {
  const feed = new OperatorEventFeed();
  const sink = new OperatorFeedTelemetrySink(feed);

  sink.emit({
    type: "projection.invalidated",
    projectId: "proj",
    linearIssueId: "issue-1",
    reason: "dependency_blocker_changed",
    affectedCount: 1,
  });
  sink.emit({
    type: "lease.acquired",
    projectId: "proj",
    linearIssueId: "issue-1",
    leaseId: "lease-1",
  });
  sink.emit({
    type: "dependency.dependent_unblocked",
    projectId: "proj",
    linearIssueId: "issue-1",
    issueKey: "PRJ-1",
    blockerLinearIssueId: "blocker-1",
    dispatchedRunType: "review_fix",
  });

  const events = feed.list({ limit: 10 });
  assert.equal(events.length, 1);
  assert.equal(events[0]?.status, "dependency_unblocked");
  assert.equal(events[0]?.issueKey, "PRJ-1");
  assert.equal(events[0]?.stage, "review_fix");
});

test("logger telemetry sink emits machine-readable event fields", () => {
  const records: Array<Record<string, unknown>> = [];
  const logger = {
    info(record: Record<string, unknown>) {
      records.push(record);
    },
  };
  const sink = new LoggerTelemetrySink(logger as never);

  sink.emit({
    type: "run.skipped",
    projectId: "proj",
    linearIssueId: "issue-1",
    issueKey: "PRJ-1",
    reason: "lease_acquire_failed",
  });

  assert.equal(records.length, 1);
  assert.equal(records[0]?.telemetryEvent, "run.skipped");
  assert.equal(records[0]?.reason, "lease_acquire_failed");
  assert.equal(records[0]?.issueKey, "PRJ-1");
});
