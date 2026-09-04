import type { ReviewQuillConfig } from "../types.ts";
import type { EvalCaseOutcome } from "./run-case.ts";

function checkbox(passed: boolean): string {
  return passed ? "[x]" : "[ ]";
}

function fenced(value: string): string {
  return ["```text", value.trim() || "<empty>", "```"].join("\n");
}

export function renderEvalReport(params: {
  outcomes: EvalCaseOutcome[];
  config: ReviewQuillConfig;
  startedAt: string;
  sourceCommit?: string;
}): string {
  const completed = params.outcomes.filter((outcome) => outcome.status === "completed");
  const passed = completed.filter((outcome) => outcome.grade.passed).length;
  const allPassed = passed === params.outcomes.length;
  const lines = [
    "# Review Quill evaluation",
    "",
    `Result: ${allPassed ? "PASS" : "FAIL"}`,
    `Cases: ${passed}/${params.outcomes.length} passed`,
    `Started: ${params.startedAt}`,
    "Mode: native-two-pass",
    `Model: ${params.config.codex.model ?? "default"}`,
    ...(params.sourceCommit ? [`Source commit: ${params.sourceCommit}`] : []),
    "Runs per case: 1",
    "",
    "Marker checks are deterministic smoke tests. Read the raw reviews below before accepting a prompt change.",
  ];

  for (const outcome of params.outcomes) {
    lines.push("", `## ${outcome.evalCase.id}`, "");
    if (outcome.status === "failed") {
      lines.push("Result: ERROR", "", fenced(outcome.error));
      continue;
    }
    lines.push(
      `Result: ${outcome.grade.passed ? "PASS" : "FAIL"}`,
      `Expected verdict: ${outcome.evalCase.expectedVerdict}`,
      `Delivered verdict: ${outcome.deliveredVerdict}`,
      `Normalized concerns: ${outcome.verdict.findings.length + outcome.verdict.architectural_concerns.length}`,
      `Findings dropped before delivery: ${outcome.droppedFindings}`,
      `Thread: ${outcome.threadId}`,
      ...(outcome.reviewTurnId ? [`Review turn: ${outcome.reviewTurnId}`] : []),
      `Normalization turn: ${outcome.normalizationTurnId}`,
      "",
      "### Checks",
      "",
      ...outcome.grade.checks.map((check) => `- ${checkbox(check.passed)} ${check.label}: ${check.detail}`),
      "",
      "### Normalized concerns",
      "",
      ...(outcome.verdict.findings.length === 0 && outcome.verdict.architectural_concerns.length === 0
        ? ["- None"]
        : [
            ...outcome.verdict.findings.map((finding) =>
              `- ${finding.severity} ${finding.path}:${finding.line} (${finding.confidence ?? "no confidence"}) — ${finding.message}`),
            ...outcome.verdict.architectural_concerns.map((concern) =>
              `- ${concern.severity} [${concern.category}] — ${concern.message}`),
          ]),
      "",
      "### Raw native review",
      "",
      fenced(outcome.rawReview),
    );
  }
  return `${lines.join("\n")}\n`;
}
