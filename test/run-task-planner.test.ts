import assert from "node:assert/strict";
import test from "node:test";
import { buildRequestedChangesLoopEscalationReason } from "../src/run-task-planner.ts";

test("requested-changes loop escalation gives the operator actionable next steps", () => {
  assert.equal(
    buildRequestedChangesLoopEscalationReason(10, 3),
    "Repeated/systemic requested-changes review loop after 10 repair attempts (configured limit: 3). Next action: consolidate the accumulated review history and audit the violated invariants, or split an oversized PR before requesting another review.",
  );
});
