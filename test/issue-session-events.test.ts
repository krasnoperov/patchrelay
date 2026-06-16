import assert from "node:assert/strict";
import { test } from "node:test";
import { deriveSessionWakePlan, type IssueSessionEventRecord } from "../src/issue-session-events.ts";
import type { IssueRecord } from "../src/db-types.ts";

function delegatedEvent(runType: string): IssueSessionEventRecord {
  return {
    id: 1,
    projectId: "proj",
    linearIssueId: "lin-1",
    eventType: "delegated",
    eventJson: JSON.stringify({ runType }),
    createdAt: new Date().toISOString(),
  };
}

test("deriveSessionWakePlan resolves a legacy main_repair payload to implementation", () => {
  // main_repair was removed as a run type; a historical delegated event carrying it
  // must not strand the issue — it falls back to a normal implementation wake.
  const issue = { issueClass: "implementation" } as IssueRecord;
  const plan = deriveSessionWakePlan(issue, [delegatedEvent("main_repair")]);
  assert.equal(plan?.runType, "implementation");
  assert.equal(plan?.wakeReason, "delegated");
});

test("deriveSessionWakePlan keeps a still-valid run type from the delegated payload", () => {
  const issue = { issueClass: "implementation" } as IssueRecord;
  const plan = deriveSessionWakePlan(issue, [delegatedEvent("ci_repair")]);
  assert.equal(plan?.runType, "ci_repair");
});

test("deriveSessionWakePlan ignores stale requested-changes events after the PR head advances", () => {
  const issue = {
    issueClass: "implementation",
    prHeadSha: "new-head",
  } as IssueRecord;
  const plan = deriveSessionWakePlan(issue, [
    event("review_changes_requested", JSON.stringify({
      requestedChangesHeadSha: "old-reviewed-head",
      reviewCommitId: "old-reviewed-head",
      reviewerName: "alv",
    })),
  ]);
  assert.equal(plan, undefined);
});

test("deriveSessionWakePlan downgrades a delegated review_fix payload to implementation when the PR is no longer changes_requested", () => {
  // A delegated event carrying a stale review_fix run type must not produce a
  // review_fix wake the orchestrator would reject as inactive (and then fail
  // to clear, since the triggering event is not a review_changes_requested
  // event) — it would strand the issue in an enqueue→skip loop.
  const issue = { issueClass: "implementation", prReviewState: "approved" } as IssueRecord;
  const plan = deriveSessionWakePlan(issue, [delegatedEvent("review_fix")]);
  assert.equal(plan?.runType, "implementation");
});

test("deriveSessionWakePlan keeps a delegated review_fix payload when the PR is still changes_requested", () => {
  const issue = { issueClass: "implementation", prReviewState: "changes_requested" } as IssueRecord;
  const plan = deriveSessionWakePlan(issue, [delegatedEvent("review_fix")]);
  assert.equal(plan?.runType, "review_fix");
});

test("deriveSessionWakePlan preserves a branch_upkeep payload regardless of review state", () => {
  // branch_upkeep is exempt from the orchestrator's inactive-requested-changes
  // guard and is valid branch maintenance even when not changes_requested, so
  // it must NOT be downgraded.
  const issue = { issueClass: "implementation", prReviewState: "approved" } as IssueRecord;
  const plan = deriveSessionWakePlan(issue, [delegatedEvent("branch_upkeep")]);
  assert.equal(plan?.runType, "branch_upkeep");
});

test("deriveSessionWakePlan downgrades a completion_check_continue review_fix to implementation when the PR is no longer changes_requested", () => {
  // A review_fix run that finished and asked to continue carries runType
  // review_fix in its payload. If the PR review is no longer
  // changes_requested (dismissed/approved/commented), continuing as review_fix
  // would be rejected by the orchestrator as an inactive requested-changes
  // wake and strand the issue — so it must resolve to implementation instead.
  const issue = { issueClass: "implementation", prReviewState: "commented" } as IssueRecord;
  const plan = deriveSessionWakePlan(issue, [
    event("completion_check_continue", JSON.stringify({ runType: "review_fix", summary: "continue" })),
  ]);
  assert.equal(plan?.runType, "implementation");
  assert.equal(plan?.wakeReason, "completion_check_continue");
});

test("deriveSessionWakePlan keeps a completion_check_continue review_fix when the PR is still changes_requested", () => {
  const issue = { issueClass: "implementation", prReviewState: "changes_requested" } as IssueRecord;
  const plan = deriveSessionWakePlan(issue, [
    event("completion_check_continue", JSON.stringify({ runType: "review_fix", summary: "continue" })),
  ]);
  assert.equal(plan?.runType, "review_fix");
});

// ─── D2 parse boundary: typed payload union ────────────────────────────

import {
  IssueSessionEventPayloadError,
  parseIssueSessionEvent,
  parseIssueSessionEventOrWarn,
} from "../src/issue-session-events.ts";

function event(
  eventType: IssueSessionEventRecord["eventType"],
  eventJson?: string,
  id = 1,
): IssueSessionEventRecord {
  return {
    id,
    projectId: "proj",
    linearIssueId: "lin-1",
    eventType,
    ...(eventJson !== undefined ? { eventJson } : {}),
    createdAt: new Date().toISOString(),
  };
}

test("parseIssueSessionEvent returns the typed payload for a valid wake event", () => {
  const typed = parseIssueSessionEvent(event("review_changes_requested", JSON.stringify({
    requestedChangesCoalesceKey: "key",
    branchUpkeepRequired: true,
    reviewerName: "alv",
  })));
  assert.equal(typed.eventType, "review_changes_requested");
  if (typed.eventType !== "review_changes_requested") throw new Error("unreachable");
  assert.equal(typed.payload?.branchUpkeepRequired, true);
  assert.equal(typed.payload?.reviewerName, "alv");
});

test("parseIssueSessionEvent returns undefined payload when eventJson is absent", () => {
  const typed = parseIssueSessionEvent(event("delegated"));
  assert.equal(typed.eventType, "delegated");
  assert.equal(typed.payload, undefined);
});

test("parseIssueSessionEvent fails loudly on malformed payload JSON", () => {
  assert.throws(
    () => parseIssueSessionEvent(event("settled_red_ci", "{broken")),
    IssueSessionEventPayloadError,
  );
  assert.throws(
    () => parseIssueSessionEvent(event("settled_red_ci", "[1]")),
    /expected a JSON object/,
  );
});

test("parseIssueSessionEvent fails loudly on a mistyped payload field", () => {
  assert.throws(
    () => parseIssueSessionEvent(event("prompt_delivered", JSON.stringify({ runId: "not-a-number" }))),
    IssueSessionEventPayloadError,
  );
  assert.throws(
    () => parseIssueSessionEvent(event("operator_closed", JSON.stringify({ terminalState: "exploded" }))),
    /terminalState/,
  );
});

test("parseIssueSessionEventOrWarn degrades a bad payload to undefined with a warning", () => {
  const warnings: string[] = [];
  const typed = parseIssueSessionEventOrWarn(event("merge_steward_incident", "{broken"), (m) => warnings.push(m));
  assert.equal(typed?.eventType, "merge_steward_incident");
  assert.equal(typed?.payload, undefined);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /merge_steward_incident/);
});

test("parseIssueSessionEventOrWarn drops events with an unknown stored event type", () => {
  const warnings: string[] = [];
  const unknown = {
    ...event("delegated"),
    eventType: "removed_legacy_event_type" as IssueSessionEventRecord["eventType"],
  };
  const typed = parseIssueSessionEventOrWarn(unknown, (m) => warnings.push(m));
  assert.equal(typed, undefined);
  assert.equal(warnings.length, 1);
});

test("deriveSessionWakePlan degrades a malformed wake payload instead of wedging the issue", () => {
  const issue = { issueClass: "implementation" } as IssueRecord;
  const errors: string[] = [];
  const plan = deriveSessionWakePlan(
    issue,
    [event("settled_red_ci", "{broken", 7)],
    (_event, message) => errors.push(message),
  );
  assert.equal(plan?.runType, "ci_repair");
  assert.deepEqual(plan?.eventIds, [7]);
  assert.equal(errors.length, 1);
});

test("deriveSessionWakePlan builds follow-ups from typed input-message payloads", () => {
  const issue = { issueClass: "implementation" } as IssueRecord;
  const plan = deriveSessionWakePlan(issue, [
    event("delegated", undefined, 1),
    event("direct_reply", JSON.stringify({ text: "please also fix the docs", author: "alv" }), 2),
  ]);
  assert.equal(plan?.runType, "implementation");
  assert.equal(plan?.context.directReplyMode, true);
  assert.deepEqual(plan?.context.followUps, [
    { type: "direct_reply", text: "please also fix the docs", author: "alv" },
  ]);
  assert.equal(plan?.context.followUpCount, 1);
});
