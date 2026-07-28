import type { CheckResult, RequiredCheck } from "./types.ts";

export interface CheckPolicyEvaluation {
  status: "pass" | "pending" | "fail";
  missing: RequiredCheck[];
  failing: CheckResult[];
  pending: CheckResult[];
}

function normalizeName(name: string): string {
  return name.trim().toLowerCase();
}

function matchesRule(check: CheckResult, rule: RequiredCheck): boolean {
  return normalizeName(check.name) === normalizeName(rule.name)
    && (rule.appId === null || check.appId === rule.appId);
}

function selectLatestRerun(checks: CheckResult[]): CheckResult[] {
  if (checks.length <= 1) return checks;
  if (checks.some((check) => check.runId === undefined)) return checks;
  const ids = checks.map((check) => check.runId!);
  if (new Set(ids).size !== ids.length) return checks;
  return [checks.reduce((latest, check) => check.runId! > latest.runId! ? check : latest)];
}

function coalesceReruns(checks: CheckResult[]): CheckResult[] {
  const groups = new Map<string, CheckResult[]>();
  for (const check of checks) {
    const key = `${normalizeName(check.name)}\0${check.appId ?? "any"}`;
    const group = groups.get(key) ?? [];
    group.push(check);
    groups.set(key, group);
  }
  return [...groups.values()].flatMap(selectLatestRerun);
}

export function mapGitHubCheckConclusion(
  status: string | undefined,
  conclusion: string | null,
): CheckResult["conclusion"] {
  if (status !== "completed" || conclusion === null) return "pending";
  switch (conclusion) {
    case "success": return "success";
    case "neutral": return "neutral";
    case "skipped": return "skipped";
    case "failure":
    case "cancelled":
    case "timed_out":
    case "stale":
    case "action_required":
      return "failure";
    default:
      return "pending";
  }
}

/** Evaluate the exact check runs against the current GitHub policy identity. */
export function evaluateCheckPolicy(
  requiredChecks: RequiredCheck[],
  requireAllChecksOnEmptyRequiredSet: boolean,
  checks: CheckResult[],
): CheckPolicyEvaluation {
  if (requiredChecks.length > 0) {
    const missing: RequiredCheck[] = [];
    const failing: CheckResult[] = [];
    const pending: CheckResult[] = [];

    for (const required of requiredChecks) {
      const matching = selectLatestRerun(checks.filter((check) => matchesRule(check, required)));
      if (matching.length === 0) {
        missing.push(required);
        continue;
      }
      // A named required job that was skipped did not validate this
      // candidate. Neutral is explicitly accepted by GitHub.
      failing.push(...matching.filter((check) =>
        check.conclusion === "failure" || check.conclusion === "skipped"));
      pending.push(...matching.filter((check) => check.conclusion === "pending"));
    }

    return {
      status: failing.length > 0 ? "fail" : missing.length > 0 || pending.length > 0 ? "pending" : "pass",
      missing,
      failing,
      pending,
    };
  }

  if (checks.length === 0) {
    return { status: "pending", missing: [], failing: [], pending: [] };
  }

  // With no named required set, skipped conditional jobs are non-applicable.
  const currentChecks = coalesceReruns(checks);
  const failing = currentChecks.filter((check) => check.conclusion === "failure");
  const pending = currentChecks.filter((check) => check.conclusion === "pending");
  if (requireAllChecksOnEmptyRequiredSet || requiredChecks.length === 0) {
    return {
      status: failing.length > 0 ? "fail" : pending.length > 0 ? "pending" : "pass",
      missing: [],
      failing,
      pending,
    };
  }

  return { status: "pass", missing: [], failing: [], pending: [] };
}

export function formatRequiredCheck(check: RequiredCheck): string {
  return check.appId === null ? check.name : `${check.name} (app ${check.appId})`;
}
