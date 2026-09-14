import assert from "node:assert/strict";
import test from "node:test";
import { buildAttemptRefundFields, buildAttemptStartFields } from "../src/run-attempt-accounting.ts";

const counters = {
  ciRepairAttempts: 2,
  queueRepairAttempts: 3,
  reviewFixAttempts: 4,
};

test("repair attempt start records budget and failure provenance together", () => {
  const fields = buildAttemptStartFields("integration_repair", counters, {
    failureHeadSha: "candidate-sha",
    failureSignature: "integration:candidate-sha:conflict",
  });

  assert.equal(fields.queueRepairAttempts, 4);
  assert.equal(fields.lastAttemptedFailureHeadSha, "candidate-sha");
  assert.equal(fields.lastAttemptedFailureSignature, "integration:candidate-sha:conflict");
  assert.ok(fields.lastAttemptedFailureAt);
});

test("pre-turn refund restores the budget and clears failure provenance", () => {
  assert.deepEqual(buildAttemptRefundFields("ci_repair", counters), {
    ciRepairAttempts: 1,
    lastAttemptedFailureHeadSha: null,
    lastAttemptedFailureSignature: null,
    lastAttemptedFailureAt: null,
  });
});

test("implementation claims do not participate in repair accounting", () => {
  assert.deepEqual(buildAttemptStartFields("implementation", counters), {});
  assert.deepEqual(buildAttemptRefundFields("implementation", counters), {});
});
