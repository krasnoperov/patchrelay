import type { ReviewQuillPendingReview } from "./types.ts";

export type PendingCheckReason = ReviewQuillPendingReview["reason"];

interface CheckLike {
  name: string;
  status: string;
  conclusion?: string;
}

interface LoweredCheck {
  name: string;
  status: string;
  conclusion: string | undefined;
}

const PASSING_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);

function lowerCheck(check: CheckLike): LoweredCheck {
  return {
    name: check.name.toLowerCase(),
    status: check.status.toLowerCase(),
    conclusion: check.conclusion?.toLowerCase(),
  };
}

export function determinePendingCheckState(
  checks: CheckLike[],
  requiredChecks: string[],
): PendingCheckReason {
  const loweredChecks = checks.map(lowerCheck);
  const byName = new Map(loweredChecks.map((check) => [check.name, check]));
  if (requiredChecks.length > 0) {
    for (const required of requiredChecks) {
      const check = byName.get(required.toLowerCase());
      if (!check || check.status !== "completed") {
        return "checks_running";
      }
      if (!PASSING_CONCLUSIONS.has(check.conclusion ?? "")) {
        return "checks_failed";
      }
    }
    return "checks_unknown";
  }

  if (loweredChecks.length === 0) {
    return "checks_unknown";
  }
  if (loweredChecks.some((check) => check.status !== "completed")) {
    return "checks_running";
  }
  if (loweredChecks.some((check) => !PASSING_CONCLUSIONS.has(check.conclusion ?? ""))) {
    return "checks_failed";
  }
  return "checks_unknown";
}

export interface PendingCheckSummary {
  failed: string[];
  pending: string[];
}

export function pendingCheckNames(
  checks: CheckLike[],
  requiredChecks: string[],
): PendingCheckSummary {
  const loweredChecks = checks.map(lowerCheck);
  const byName = new Map(loweredChecks.map((check) => [check.name, check]));
  if (requiredChecks.length > 0) {
    return requiredChecks.reduce<PendingCheckSummary>((acc, required) => {
      const check = byName.get(required.toLowerCase());
      if (!check) {
        acc.pending.push(required);
        return acc;
      }
      if (check.status !== "completed") {
        acc.pending.push(required);
        return acc;
      }
      if (!PASSING_CONCLUSIONS.has(check.conclusion ?? "")) {
        acc.failed.push(required);
      }
      return acc;
    }, { failed: [], pending: [] });
  }

  return checks.reduce<PendingCheckSummary>((acc, check) => {
    if (check.status !== "completed") {
      acc.pending.push(check.name);
    } else if (!PASSING_CONCLUSIONS.has(check.conclusion?.toLowerCase() ?? "")) {
      acc.failed.push(check.name);
    }
    return acc;
  }, { failed: [], pending: [] });
}
