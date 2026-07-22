import assert from "node:assert/strict";
import test from "node:test";
import type { IssueRecord } from "../src/db-types.ts";
import { deriveIssuePhase, type IssuePhaseInput } from "../src/issue-phase.ts";

function facts(overrides: Partial<IssueRecord> & Partial<IssuePhaseInput> = {}): IssuePhaseInput {
  return {
    delegatedToPatchRelay: true,
    ...overrides,
  };
}

test("terminal workflow facts outrank mutable external state", () => {
  assert.equal(deriveIssuePhase(facts({ workflowOutcome: "completed", prState: "open" })), "done");
  assert.equal(deriveIssuePhase(facts({ workflowOutcome: "failed", prReviewState: "approved" })), "failed");
  assert.equal(deriveIssuePhase(facts({ workflowOutcome: "escalated", activeRunType: "implementation" })), "escalated");
});

test("outstanding input is a durable fact rather than a lifecycle state", () => {
  assert.equal(deriveIssuePhase(facts({ inputRequestKind: "completion_check_question" })), "awaiting_input");
});

test("active and runnable work derive repair phases", () => {
  assert.equal(deriveIssuePhase(facts({ activeRunType: "ci_repair" })), "repairing_ci");
  assert.equal(deriveIssuePhase(facts({ runnableTaskRunType: "queue_repair" })), "repairing_queue");
  assert.equal(deriveIssuePhase(facts({ activeRunType: "review_fix" })), "changes_requested");
});

test("PR facts derive downstream phases", () => {
  const openPr = { prNumber: 12, prState: "open" } as const;
  assert.equal(deriveIssuePhase(facts(openPr)), "pr_open");
  assert.equal(deriveIssuePhase(facts({ ...openPr, prReviewState: "approved" })), "awaiting_queue");
  assert.equal(deriveIssuePhase(facts({ ...openPr, prReviewState: "changes_requested" })), "changes_requested");
  assert.equal(deriveIssuePhase(facts({ prNumber: 12, prState: "merged", deployStartedAt: "2026-07-22T00:00:00Z" })), "deploying");
});

test("delegation and absence of artifacts derive local phases", () => {
  assert.equal(deriveIssuePhase(facts()), "delegated");
  assert.equal(deriveIssuePhase(facts({ activeRunType: "implementation" })), "implementing");
  assert.equal(deriveIssuePhase(facts({ delegatedToPatchRelay: false })), "paused");
});
