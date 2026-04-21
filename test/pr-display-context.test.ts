import assert from "node:assert/strict";
import test from "node:test";
import { derivePrDisplayContext } from "../src/pr-display-context.ts";

test("derivePrDisplayContext classifies open, merged, and replacement states deterministically", () => {
  assert.deepEqual(
    derivePrDisplayContext({
      prNumber: 12,
      prState: "open",
      factoryState: "pr_open",
      delegatedToPatchRelay: true,
    }),
    { kind: "active_pr", prNumber: 12 },
  );

  assert.deepEqual(
    derivePrDisplayContext({
      prNumber: 13,
      prState: "merged",
      factoryState: "done",
      delegatedToPatchRelay: true,
    }),
    { kind: "merged_pr", prNumber: 13 },
  );

  assert.deepEqual(
    derivePrDisplayContext({
      prNumber: 14,
      prState: "closed",
      factoryState: "implementing",
      delegatedToPatchRelay: true,
    }),
    { kind: "closed_replacement_pending", prNumber: 14 },
  );

  assert.deepEqual(
    derivePrDisplayContext({
      prNumber: 15,
      prState: "closed",
      factoryState: "implementing",
      delegatedToPatchRelay: false,
    }),
    { kind: "closed_pr_paused", prNumber: 15 },
  );

  assert.deepEqual(
    derivePrDisplayContext({
      prNumber: 16,
      prState: "closed",
      factoryState: "done",
      delegatedToPatchRelay: true,
    }),
    { kind: "closed_historical_pr", prNumber: 16 },
  );
});
