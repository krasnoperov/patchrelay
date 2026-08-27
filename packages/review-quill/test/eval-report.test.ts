import assert from "node:assert/strict";
import test from "node:test";
import { renderEvalReport } from "../src/eval/report.ts";

test("renderEvalReport keeps results readable Markdown without serialized JSON", () => {
  const report = renderEvalReport({
    startedAt: "2026-08-27T10:00:00.000Z",
    sourceCommit: "abc123",
    config: { codex: { reviewMode: "native-two-pass", model: "gpt-test" } } as never,
    outcomes: [{
      status: "completed",
      evalCase: { id: "sample", expectedVerdict: "approve" } as never,
      grade: { passed: true, checks: [{ passed: true, label: "Verdict", detail: "expected approve, delivered approve" }] },
      verdict: {
        walkthrough: "",
        architectural_concerns: [],
        findings: [],
        verdict: "approve",
        verdict_reason: "No blockers.",
      },
      deliveredVerdict: "approve",
      droppedFindings: 0,
      rawReview: "No findings.",
      threadId: "thread-1",
      reviewTurnId: "review-1",
      normalizationTurnId: "turn-2",
    }],
  });
  assert.match(report, /^# Review Quill evaluation/m);
  assert.match(report, /Result: PASS/);
  assert.match(report, /- \[x\] Verdict/);
  assert.match(report, /```text\nNo findings\.\n```/);
  assert.doesNotMatch(report, /"verdict"\s*:/);
});
