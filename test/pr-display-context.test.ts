import assert from "node:assert/strict";
import test from "node:test";
import { derivePrDisplayContext } from "../src/pr-display-context.ts";

test("derivePrDisplayContext classifies open, merged, and replacement states deterministically", () => {
  assert.deepEqual(
    derivePrDisplayContext({
      prNumber: 12,
      prState: "open",
      workflowOutcome: undefined,
      delegatedToPatchRelay: true,
    }),
    { kind: "active_pr", prNumber: 12 },
  );

  assert.deepEqual(
    derivePrDisplayContext({
      prNumber: 13,
      prState: "merged",
      workflowOutcome: "completed",
      delegatedToPatchRelay: true,
    }),
    { kind: "merged_pr", prNumber: 13 },
  );

  assert.deepEqual(
    derivePrDisplayContext({
      prNumber: 14,
      prState: "closed",
      workflowOutcome: undefined,
      delegatedToPatchRelay: true,
    }),
    { kind: "closed_replacement_pending", prNumber: 14 },
  );

  assert.deepEqual(
    derivePrDisplayContext({
      prNumber: 15,
      prState: "closed",
      workflowOutcome: undefined,
      delegatedToPatchRelay: false,
    }),
    { kind: "closed_pr_paused", prNumber: 15 },
  );

  assert.deepEqual(
    derivePrDisplayContext({
      prNumber: 16,
      prState: "closed",
      workflowOutcome: "completed",
      delegatedToPatchRelay: true,
    }),
    { kind: "closed_historical_pr", prNumber: 16 },
  );
});
