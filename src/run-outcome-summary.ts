import type { FactoryState, RunType } from "./factory-state.ts";
import { sanitizeOperatorFacingText } from "./presentation-text.ts";

export interface RunOutcomeFacts {
  workflowReason?: string | undefined;
  postRunState?: FactoryState | undefined;
  prNumber?: number | undefined;
  reviewerName?: string | undefined;
  reviewSummary?: string | undefined;
  failingCheckName?: string | undefined;
  failureSummary?: string | undefined;
  queueIncidentSummary?: string | undefined;
  latestAssistantSummary?: string | undefined;
}

export function buildRunOutcomeSummary(params: {
  runType: RunType;
  facts: RunOutcomeFacts;
}): string {
  switch (params.runType) {
    case "implementation":
      return summarizeImplementation(params.facts);
    case "review_fix":
      return summarizeReviewFix(params.facts);
    case "ci_repair":
      return summarizeCiRepair(params.facts);
    case "queue_repair":
      return summarizeQueueRepair(params.facts);
    case "branch_upkeep":
      return "Branch updated.";
  }
}

function summarizeImplementation(facts: RunOutcomeFacts): string {
  const assistantSummary = summarizeImplementationAssistantOutcome(facts.latestAssistantSummary);
  if (assistantSummary) {
    return assistantSummary;
  }

  switch (facts.postRunState) {
    case "awaiting_queue":
      return "Ready for merge.";
    case "done":
      return "Completed.";
    case "pr_open":
    default:
      return "Ready for review.";
  }
}

function summarizeImplementationAssistantOutcome(value: string | undefined): string | undefined {
  const sanitized = sanitizeOperatorFacingText(value)?.trim();
  if (!sanitized) {
    return undefined;
  }
  const normalized = sanitized.replace(/\s+/g, " ");
  if (/^(ready for review|ready for merge|completed)\.?$/i.test(normalized)) {
    return undefined;
  }
  return normalized;
}

function summarizeReviewFix(facts: RunOutcomeFacts): string {
  const concern = summarizeKnownConcern(extractReviewConcern(facts.reviewSummary));
  return concern ? rewriteConcernAsOutcome(concern) : "Review feedback addressed.";
}

function summarizeCiRepair(facts: RunOutcomeFacts): string {
  const check = sanitizeOperatorFacingText(facts.failingCheckName)?.replace(/\s+/g, " ").trim();
  if (check) {
    return `${check} fixed.`;
  }
  const concern = summarizeKnownConcern(facts.failureSummary);
  if (concern) {
    return rewriteConcernAsOutcome(concern);
  }
  return "CI fixed.";
}

function summarizeQueueRepair(facts: RunOutcomeFacts): string {
  const concern = summarizeKnownConcern(facts.queueIncidentSummary);
  if (concern) {
    return rewriteConcernAsOutcome(concern);
  }
  return "Merge queue issue resolved.";
}

function summarizeKnownConcern(value: string | undefined): string | undefined {
  const sanitized = sanitizeOperatorFacingText(value)?.replace(/\s+/g, " ").trim();
  if (!sanitized) {
    return undefined;
  }
  const stripped = sanitized
    .replace(/^please\s+/i, "")
    .replace(/[.]+$/, "")
    .trim();
  if (!stripped) {
    return undefined;
  }
  return stripped.length <= 80 ? stripped : `${stripped.slice(0, 80).trimEnd()}...`;
}

function extractReviewConcern(value: string | undefined): string | undefined {
  const sanitized = sanitizeOperatorFacingText(value)?.trim();
  if (!sanitized) {
    return undefined;
  }

  const verdictReason = sanitized.match(/\*\*Verdict:[^—\n]*—\s*([^\n]+)/i)?.[1]?.trim();
  if (verdictReason) {
    return stripReviewLeadingPhrase(verdictReason);
  }

  const finding = sanitized.match(/^-+\s*(?:[^\w`]*\s*)?`?([^`\n]+?)`?\s*(?:—|-)\s*([^\n]+)/m);
  if (finding?.[2]) {
    return stripReviewLeadingPhrase(finding[2]);
  }

  return sanitized;
}

function stripReviewLeadingPhrase(value: string): string {
  return value
    .replace(/^request changes because\s+/i, "")
    .replace(/^the pr\s+/i, "")
    .trim();
}

function rewriteConcernAsOutcome(concern: string): string {
  const normalized = concern.trim().replace(/[.]+$/, "");
  const tightened = normalized.match(/^tighten\s+(.+)$/i);
  if (tightened?.[1]) {
    return `${capitalizeFirst(stripLeadingArticle(tightened[1]))} tightened.`;
  }
  const fixed = normalized.match(/^(fix|repair)\s+(.+)$/i);
  if (fixed?.[2]) {
    return `${capitalizeFirst(stripLeadingArticle(fixed[2]))} fixed.`;
  }
  const resolved = normalized.match(/^resolve\s+(.+)$/i);
  if (resolved?.[1]) {
    return `${capitalizeFirst(stripLeadingArticle(resolved[1]))} resolved.`;
  }
  const updated = normalized.match(/^update\s+(.+)$/i);
  if (updated?.[1]) {
    return `${capitalizeFirst(stripLeadingArticle(updated[1]))} updated.`;
  }
  return `${capitalizeFirst(normalized)}.`;
}

function capitalizeFirst(value: string): string {
  const trimmed = value.trim();
  return trimmed ? `${trimmed.slice(0, 1).toUpperCase()}${trimmed.slice(1)}` : trimmed;
}

function stripLeadingArticle(value: string): string {
  return value.trim().replace(/^the\s+/i, "");
}
