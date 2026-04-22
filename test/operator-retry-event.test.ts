import assert from "node:assert/strict";
import test from "node:test";
import { buildOperatorRetryEvent } from "../src/operator-retry-event.ts";
import type { IssueRecord } from "../src/db-types.ts";

function createIssue(overrides: Partial<IssueRecord> = {}): IssueRecord {
  return {
    id: 1,
    projectId: "usertold",
    linearIssueId: "issue-1",
    delegatedToPatchRelay: true,
    issueKey: "USE-1",
    factoryState: "failed",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as IssueRecord;
}

test("buildOperatorRetryEvent preserves queue incident and failure context for queue repair", () => {
  const event = buildOperatorRetryEvent(createIssue({
    linearIssueId: "issue-queue",
    prHeadSha: "head-123",
    lastQueueIncidentJson: JSON.stringify({ queuePosition: 3, incident: "evicted" }),
    lastGitHubFailureContextJson: JSON.stringify({ checkName: "merge-steward", summary: "Evicted from queue" }),
  }), "queue_repair");

  assert.equal(event.eventType, "merge_steward_incident");
  assert.equal(event.dedupeKey, "operator_retry:queue_repair:issue-queue:head-123");
  const payload = JSON.parse(event.eventJson) as Record<string, unknown>;
  assert.equal(payload.queuePosition, 3);
  assert.equal(payload.incident, "evicted");
  assert.equal(payload.checkName, "merge-steward");
  assert.equal(payload.summary, "Evicted from queue");
  assert.equal(payload.source, "operator_retry");
});

test("buildOperatorRetryEvent emits settled_red_ci for ci repair", () => {
  const event = buildOperatorRetryEvent(createIssue({
    linearIssueId: "issue-ci",
    lastGitHubFailureSignature: "sig-1",
    lastGitHubFailureContextJson: JSON.stringify({ checkName: "verify", stepName: "unit", summary: "unit tests failed" }),
  }), "ci_repair");

  assert.equal(event.eventType, "settled_red_ci");
  assert.equal(event.dedupeKey, "operator_retry:ci_repair:issue-ci:sig-1");
  const payload = JSON.parse(event.eventJson) as Record<string, unknown>;
  assert.equal(payload.checkName, "verify");
  assert.equal(payload.stepName, "unit");
  assert.equal(payload.summary, "unit tests failed");
  assert.equal(payload.source, "operator_retry");
});

test("buildOperatorRetryEvent marks branch upkeep retries explicitly", () => {
  const event = buildOperatorRetryEvent(createIssue({
    linearIssueId: "issue-review",
    prHeadSha: "head-review",
  }), "branch_upkeep");

  assert.equal(event.eventType, "review_changes_requested");
  assert.equal(event.dedupeKey, "operator_retry:branch_upkeep:issue-review:head-review");
  const payload = JSON.parse(event.eventJson) as Record<string, unknown>;
  assert.equal(payload.branchUpkeepRequired, true);
  assert.equal(payload.wakeReason, "branch_upkeep");
  assert.equal(payload.source, "operator_retry");
});

test("buildOperatorRetryEvent keeps review-fix retries generic so live review context can be rehydrated", () => {
  const event = buildOperatorRetryEvent(createIssue({
    linearIssueId: "issue-review-fix",
    prHeadSha: "head-review-fix",
  }), "review_fix");

  assert.equal(event.eventType, "review_changes_requested");
  assert.equal(event.dedupeKey, "operator_retry:review_fix:issue-review-fix:head-review-fix");
  const payload = JSON.parse(event.eventJson) as Record<string, unknown>;
  assert.equal(payload.promptContext, "operator retry requested retry of review-fix work.");
  assert.equal("reviewBody" in payload, false);
});
