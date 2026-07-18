import assert from "node:assert/strict";
import test from "node:test";
import { REVIEW_VERDICT_JSON_SCHEMA } from "../src/review-verdict-schema.ts";
import { normalizeVerdict } from "../src/review-runner.ts";

test("ReviewVerdict JSON schema is strict and requires the canonical shape", () => {
  assert.equal(REVIEW_VERDICT_JSON_SCHEMA.additionalProperties, false);
  assert.deepEqual(REVIEW_VERDICT_JSON_SCHEMA.required, [
    "walkthrough",
    "architectural_concerns",
    "findings",
    "verdict",
    "verdict_reason",
  ]);
  assert.equal(REVIEW_VERDICT_JSON_SCHEMA.properties.architectural_concerns.items.additionalProperties, false);
  assert.equal(REVIEW_VERDICT_JSON_SCHEMA.properties.findings.items.additionalProperties, false);
  assert.deepEqual(REVIEW_VERDICT_JSON_SCHEMA.properties.findings.items.required, [
    "path",
    "line",
    "severity",
    "message",
    "confidence",
    "suggestion",
  ]);
  assert.deepEqual(REVIEW_VERDICT_JSON_SCHEMA.properties.findings.items.properties.confidence.type, ["number", "null"]);
  assert.deepEqual(REVIEW_VERDICT_JSON_SCHEMA.properties.findings.items.properties.suggestion.type, ["string", "null"]);
});

test("ReviewVerdict JSON schema adds no length, count, confidence, or line caps", () => {
  const serialized = JSON.stringify(REVIEW_VERDICT_JSON_SCHEMA);
  assert.doesNotMatch(serialized, /minLength|maxLength|minItems|maxItems|minimum|maximum/);
});

test("normalizeVerdict omits nullable optional finding values from the internal verdict", () => {
  const verdict = normalizeVerdict({
    walkthrough: "",
    architectural_concerns: [],
    findings: [{
      path: "src/service.ts",
      line: 10,
      severity: "blocking",
      message: "Broken invariant",
      confidence: null,
      suggestion: null,
    }],
    verdict: "request_changes",
    verdict_reason: "Fix the invariant.",
  });

  assert.equal(verdict.findings[0]?.confidence, undefined);
  assert.equal(verdict.findings[0]?.suggestion, undefined);
});
