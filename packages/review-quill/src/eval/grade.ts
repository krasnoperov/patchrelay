import type { ReviewVerdict } from "../types.ts";
import type { ReviewEvalCase } from "./case-file.ts";

export interface EvalCheck {
  passed: boolean;
  label: string;
  detail: string;
}

export interface EvalGrade {
  passed: boolean;
  checks: EvalCheck[];
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function concernTexts(verdict: ReviewVerdict): string[] {
  return [
    ...verdict.findings.map((finding) => finding.message),
    ...verdict.architectural_concerns.map((concern) => `${concern.category} ${concern.message}`),
  ];
}

function markerMatches(text: string, markers: string[]): boolean {
  const normalized = normalize(text);
  return markers.every((marker) => normalized.includes(normalize(marker)));
}

export function gradeEvalCase(
  evalCase: ReviewEvalCase,
  verdict: ReviewVerdict,
  invalidAnchors: string[] = [],
  deliveredVerdict: ReviewEvalCase["expectedVerdict"] = verdict.verdict,
): EvalGrade {
  const concerns = concernTexts(verdict);
  const concernCount = verdict.findings.length + verdict.architectural_concerns.length;
  const nitCount = verdict.findings.filter((finding) => finding.severity === "nit").length
    + verdict.architectural_concerns.filter((concern) => concern.severity === "nit").length;
  const checks: EvalCheck[] = [
    {
      passed: deliveredVerdict === evalCase.expectedVerdict,
      label: "Verdict",
      detail: `expected ${evalCase.expectedVerdict}, delivered ${deliveredVerdict}`,
    },
    {
      passed: concernCount <= evalCase.maximumConcerns,
      label: "Concern count",
      detail: `${concernCount} reported, maximum ${evalCase.maximumConcerns}`,
    },
    {
      passed: !evalCase.forbidNits || nitCount === 0,
      label: "No distracting nits",
      detail: evalCase.forbidNits ? `${nitCount} nits reported` : "nits allowed by this case",
    },
    {
      passed: invalidAnchors.length === 0,
      label: "Changed-line anchors",
      detail: invalidAnchors.length === 0 ? "all line findings use changed new-version lines" : invalidAnchors.join(", "),
    },
  ];

  for (const markers of evalCase.mustReport) {
    const matched = concerns.some((text) => markerMatches(text, markers));
    checks.push({
      passed: matched,
      label: "Required concern",
      detail: `${matched ? "found" : "missing"}: ${markers.join(" + ")}`,
    });
  }
  for (const markers of evalCase.mustNotReport) {
    const matched = concerns.some((text) => markerMatches(text, markers));
    checks.push({
      passed: !matched,
      label: "Forbidden concern",
      detail: `${matched ? "reported" : "not reported"}: ${markers.join(" + ")}`,
    });
  }
  return { passed: checks.every((check) => check.passed), checks };
}
