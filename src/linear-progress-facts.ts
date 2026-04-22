import type { IssueRecord } from "./db-types.ts";
import { sanitizeOperatorFacingText } from "./presentation-text.ts";
import type { LinearAgentActivityContent } from "./types.ts";

export interface LinearProgressFact {
  kind: "root_cause_found" | "verification_started" | "publishing_started";
  meaningKey: string;
  ephemeralContent: LinearAgentActivityContent;
  historyContent: LinearAgentActivityContent;
}

export function deriveLinearProgressFact(
  notification: { method: string; params: Record<string, unknown> },
  issue?: Pick<IssueRecord, "prNumber">,
): LinearProgressFact | undefined {
  switch (notification.method) {
    case "item/completed":
      return deriveProgressFactFromCompletedItem(notification.params.item, issue);
    case "turn/plan/updated":
      return deriveProgressFactFromPlan(notification.params.plan, issue);
    default:
      return undefined;
  }
}

function deriveProgressFactFromCompletedItem(
  rawItem: unknown,
  issue?: Pick<IssueRecord, "prNumber">,
): LinearProgressFact | undefined {
  void issue;
  if (!rawItem || typeof rawItem !== "object") {
    return undefined;
  }
  const item = rawItem as Record<string, unknown>;
  if (item.type !== "agentMessage" || typeof item.text !== "string") {
    return undefined;
  }

  const body = compactOperatorSentence(item.text);
  if (!body) {
    return undefined;
  }

  if (looksLikeVerification(body)) {
    return {
      kind: "verification_started",
      meaningKey: `verification:${normalizeMeaningKey(body)}`,
      ephemeralContent: { type: "thought", body },
      historyContent: { type: "thought", body },
    };
  }
  if (looksLikePublishing(body)) {
    return {
      kind: "publishing_started",
      meaningKey: `publishing:${normalizeMeaningKey(body)}`,
      ephemeralContent: { type: "thought", body },
      historyContent: { type: "thought", body },
    };
  }
  if (looksLikeRootCause(body)) {
    return {
      kind: "root_cause_found",
      meaningKey: `finding:${normalizeMeaningKey(body)}`,
      ephemeralContent: { type: "thought", body },
      historyContent: { type: "thought", body },
    };
  }

  return undefined;
}

function deriveProgressFactFromPlan(
  rawPlan: unknown,
  issue?: Pick<IssueRecord, "prNumber">,
): LinearProgressFact | undefined {
  if (!Array.isArray(rawPlan)) {
    return undefined;
  }

  const activeStep = rawPlan
    .map((entry) => normalizePlanEntry(entry))
    .find((entry) => entry && entry.status === "in_progress");
  if (!activeStep) {
    return undefined;
  }

  if (looksLikeVerification(activeStep.step)) {
    return {
      kind: "verification_started",
      meaningKey: `verification:${normalizeMeaningKey(activeStep.step)}`,
      ephemeralContent: {
        type: "action",
        action: "Verifying",
        parameter: summarizePlanStep(activeStep.step, "latest changes before publishing"),
      },
      historyContent: {
        type: "action",
        action: "Verifying",
        parameter: summarizePlanStep(activeStep.step, "latest changes before publishing"),
      },
    };
  }

  if (looksLikePublishing(activeStep.step)) {
    const parameter = summarizePlanStep(activeStep.step, issue?.prNumber !== undefined ? `changes to PR #${issue.prNumber}` : "latest changes");
    return {
      kind: "publishing_started",
      meaningKey: `publishing:${normalizeMeaningKey(activeStep.step)}`,
      ephemeralContent: {
        type: "action",
        action: "Publishing",
        parameter,
      },
      historyContent: {
        type: "action",
        action: "Publishing",
        parameter,
      },
    };
  }

  return undefined;
}

function normalizePlanEntry(rawEntry: unknown): { step: string; status: "pending" | "in_progress" | "completed" } | undefined {
  if (!rawEntry || typeof rawEntry !== "object") {
    return undefined;
  }
  const entry = rawEntry as Record<string, unknown>;
  const rawStep = entry.step;
  if (typeof rawStep !== "string" || !rawStep.trim()) {
    return undefined;
  }
  const rawStatus = typeof entry.status === "string" ? entry.status : "pending";
  return {
    step: rawStep.trim(),
    status: rawStatus === "inProgress" ? "in_progress"
      : rawStatus === "completed" ? "completed"
      : rawStatus === "pending" ? "pending"
      : rawStatus === "in_progress" ? "in_progress"
      : "pending",
  };
}

function looksLikeRootCause(text: string): boolean {
  const normalized = text.toLowerCase();
  return /\b(narrowed|isolated|root cause)\b/.test(normalized)
    || normalized.startsWith("found that ")
    || normalized.startsWith("the failure is isolated")
    || normalized.startsWith("the issue is isolated");
}

function looksLikeVerification(text: string): boolean {
  const normalized = text.toLowerCase();
  return /\b(verifying|verification|targeted verification|smoke)\b/.test(normalized);
}

function looksLikePublishing(text: string): boolean {
  const normalized = text.toLowerCase();
  return /\b(publish|publishing|push|pushing)\b/.test(normalized)
    || normalized.includes("opening pr")
    || normalized.includes("opening the pr")
    || normalized.includes("opening pull request");
}

function compactOperatorSentence(text: string, maxLength = 160): string | undefined {
  const sanitized = sanitizeOperatorFacingText(text)?.replace(/\s+/g, " ").trim();
  if (!sanitized) {
    return undefined;
  }
  if (sanitized.length <= maxLength) {
    return sanitized;
  }

  const punctuated = lastBoundaryWithinLimit(sanitized, maxLength, /[.;!?]/g);
  if (punctuated !== undefined) {
    return sanitized.slice(0, punctuated + 1).trim();
  }

  const spaced = sanitized.lastIndexOf(" ", maxLength);
  if (spaced > 0) {
    return `${sanitized.slice(0, spaced).trimEnd()}...`;
  }

  return `${sanitized.slice(0, maxLength).trimEnd()}...`;
}

function summarizePlanStep(step: string, fallback: string): string {
  const sanitized = sanitizeOperatorFacingText(step)?.replace(/\s+/g, " ").trim();
  if (!sanitized) {
    return fallback;
  }

  const stripped = sanitized
    .replace(/^(run|running|start|starting)\s+/i, "")
    .replace(/^(verify|verifying|verification of)\s+/i, "")
    .replace(/^(publish|publishing|push|pushing|open|opening)\s+/i, "")
    .trim()
    .replace(/[.]+$/, "");

  return stripped || fallback;
}

function normalizeMeaningKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function lastBoundaryWithinLimit(text: string, maxLength: number, pattern: RegExp): number | undefined {
  let last = -1;
  for (;;) {
    const match = pattern.exec(text);
    if (!match) {
      break;
    }
    if (match.index >= maxLength) {
      break;
    }
    last = match.index;
  }
  return last >= 0 ? last : undefined;
}
