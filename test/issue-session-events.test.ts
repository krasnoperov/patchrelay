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
