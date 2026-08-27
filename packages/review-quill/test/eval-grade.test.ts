import assert from "node:assert/strict";
import test from "node:test";
import type { ReviewEvalCase } from "../src/eval/case-file.ts";
import { gradeEvalCase } from "../src/eval/grade.ts";
import type { ReviewVerdict } from "../src/types.ts";

function evalCase(overrides: Partial<ReviewEvalCase> = {}): ReviewEvalCase {
  return {
    id: "case",
    sourcePath: "case.md",
    repository: "acme/demo",
    pullRequest: 1,
    baseSha: "1".repeat(40),
    headSha: "2".repeat(40),
    baseBranch: "main",
    headBranch: "feature/demo",
    title: "Demo",
    body: "Body",
    expectedVerdict: "request_changes",
    maximumConcerns: 1,
    forbidNits: true,
    reviewDocs: [],
    mustReport: [["screen reader", "focusable", "mark", "note"]],
    mustNotReport: [["persistent card", "hover"]],
    priorReviewClaims: [],
    notes: "",
    ...overrides,
  };
}

function verdict(message: string, overrides: Partial<ReviewVerdict> = {}): ReviewVerdict {
  return {
    walkthrough: "",
    architectural_concerns: [],
    findings: [{
      path: "src/card.tsx",
      line: 12,
      severity: "blocking",
      message,
      confidence: 98,
    }],
    verdict: "request_changes",
    verdict_reason: "A blocker remains.",
    ...overrides,
  };
}

test("gradeEvalCase accepts the required root cause without matching exact wording", () => {
  const grade = gradeEvalCase(
    evalCase(),
    verdict("Focusable screen and voice marks have unassociated notes, so screen readers cannot announce them."),
  );
  assert.equal(grade.passed, true);
});

test("gradeEvalCase identifies the observed weak touch fallback as forbidden", () => {
  const candidate = verdict("Support inspecting timeline marks on touch devices because they may not match :focus-visible.");
  const grade = gradeEvalCase(evalCase({
    mustReport: [],
    mustNotReport: [["touch device", "focus visible"]],
  }), candidate);
  assert.equal(grade.passed, false);
  assert.equal(grade.checks.find((check) => check.label === "Forbidden concern")?.passed, false);
});

test("gradeEvalCase rejects weak extras, nits, invalid anchors, and delivered verdict drift", () => {
  const candidate = verdict("Persistent cards omit facts that appear on hover.", {
    findings: [{
      path: "src/card.tsx",
      line: 12,
      severity: "nit",
      message: "Persistent cards omit facts that appear on hover.",
      confidence: 90,
    }],
    verdict: "approve",
    verdict_reason: "Only a nit remains.",
  });
  const grade = gradeEvalCase(evalCase(), candidate, ["src/card.tsx:12"], "approve");
  assert.equal(grade.passed, false);
  assert.deepEqual(
    grade.checks.filter((check) => !check.passed).map((check) => check.label),
    ["Verdict", "No distracting nits", "Changed-line anchors", "Required concern", "Forbidden concern"],
  );
});

test("gradeEvalCase accepts an empty approval after the known repair", () => {
  const repaired = verdict("", {
    findings: [],
    verdict: "approve",
    verdict_reason: "The prior accessibility concern is resolved.",
  });
  const grade = gradeEvalCase(evalCase({
    expectedVerdict: "approve",
    maximumConcerns: 0,
    mustReport: [],
  }), repaired);
  assert.equal(grade.passed, true);
});
