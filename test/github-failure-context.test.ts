import assert from "node:assert/strict";
import test from "node:test";
import {
  pickFailureSummary,
  pickPreferredFailureAnnotation,
} from "../src/github-failure-context.ts";

test("pickPreferredFailureAnnotation ignores low-signal workflow annotations", () => {
  assert.equal(
    pickPreferredFailureAnnotation([
      "Node.js 20 is deprecated. The following actions target Node.js 20 but are being forced to run on Node.js 24: actions/setup-node@v4 (.github)",
      "Process completed with exit code 1.: (.github)",
    ]),
    undefined,
  );
});

test("pickPreferredFailureAnnotation prefers application-level failures over workflow noise", () => {
  assert.equal(
    pickPreferredFailureAnnotation([
      "Node.js 20 is deprecated. The following actions target Node.js 20 but are being forced to run on Node.js 24: actions/setup-node@v4 (.github)",
      "AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: (src/frontend/app/gameLauncher.test.ts)",
    ]),
    "AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: (src/frontend/app/gameLauncher.test.ts)",
  );
});

test("pickFailureSummary falls back to failed step when only low-signal annotations exist", () => {
  assert.equal(
    pickFailureSummary({
      annotations: [
        "Node.js 20 is deprecated. The following actions target Node.js 20 but are being forced to run on Node.js 24: actions/setup-node@v4 (.github)",
        "Process completed with exit code 1.: (.github)",
      ],
      workflowStepName: "Run unit tests",
    }),
    "Failed step: Run unit tests",
  );
});
