import assert from "node:assert/strict";
import test from "node:test";
import {
  buildInlineCommentBody,
  buildReviewBody,
  classifyPublicationDisposition,
  filterFindings,
  hasMatchingLatestReviewForHead,
  resolveEvent,
} from "../src/review-publication-policy.ts";
import type { ReviewFinding, ReviewVerdict } from "../src/types.ts";

function fakeFinding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    path: "src/foo.ts",
    line: 42,
    severity: "blocking",
    message: "null pointer dereference",
    ...overrides,
  };
}

function fakeVerdict(overrides: Partial<ReviewVerdict> = {}): ReviewVerdict {
  return {
    walkthrough: "This PR changes the admission flow.",
    architectural_concerns: [],
    findings: [],
    verdict: "approve",
    verdict_reason: "No issues found.",
    ...overrides,
  };
}

test("filterFindings drops low-confidence and hallucinated findings", () => {
  const findings = filterFindings([
    fakeFinding({ confidence: 90 }),
    fakeFinding({ path: "missing.ts", confidence: 90 }),
    fakeFinding({ confidence: 60 }),
  ], new Set(["src/foo.ts"]));

  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.path, "src/foo.ts");
});

test("resolveEvent keeps request changes only when there are blocking findings", () => {
  const verdict = fakeVerdict({
    architectural_concerns: [{ severity: "nit", category: "style", message: "Prefer a helper" }],
  });
  assert.equal(resolveEvent(verdict, [fakeFinding({ severity: "nit" })]), "APPROVE");
  assert.equal(resolveEvent(fakeVerdict({ architectural_concerns: [{ severity: "blocking", category: "correctness", message: "oops" }] }), []), "REQUEST_CHANGES");
});

test("buildReviewBody and buildInlineCommentBody render the reviewer payload", () => {
  assert.match(buildReviewBody({ verdict: fakeVerdict(), event: "APPROVE" }), /Verdict/);
  assert.match(buildInlineCommentBody(fakeFinding({ suggestion: "x = y" })), /suggestion/);
});

test("hasMatchingLatestReviewForHead detects matching state and body", () => {
  const reviews = [{
    id: 1,
    authorLogin: "review-quill",
    state: "APPROVED",
    commitId: "head-sha",
    body: "Walkthrough v1",
  }];
  assert.equal(hasMatchingLatestReviewForHead(reviews, "review-quill", "head-sha", "APPROVE", "Walkthrough v1"), true);
  assert.equal(hasMatchingLatestReviewForHead(reviews, "review-quill", "head-sha", "APPROVE", "Walkthrough v2"), false);
});

test("classifyPublicationDisposition marks stale heads as superseded", () => {
  const disposition = classifyPublicationDisposition({
    state: "OPEN",
    isDraft: false,
    headSha: "new-head-sha",
  }, "old-head-sha");

  assert.equal(disposition.action, "supersede");
});
