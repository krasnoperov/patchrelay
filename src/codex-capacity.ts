// Classifies Codex turn failures that are capacity outages (account usage
// limit, rate limit, quota) rather than evidence about the work itself.
// A capacity failure must not consume repair budgets or escalate an issue —
// the RunFailurePolicy defers the same workflow task behind a backoff instead
// (see deferCapacityLimitedRun).

export interface CodexCapacityFailure {
  kind: "capacity";
  /** The raw Codex error message that triggered the classification. */
  detail: string;
  /** Absolute retry time parsed from "try again at H:MM AM/PM", when present. */
  retryAtIso?: string | undefined;
}

export type CodexFailureClassification = CodexCapacityFailure | { kind: "other" };

// Known capacity phrasings. The real production string is
// "You've hit your usage limit. Upgrade to Pro (...) or try again at 3:23 AM.";
// rate-limit and quota phrasings are matched defensively for the API-key path.
// "Selected model is at capacity. Please try a different model." is a transient
// model-overload outage from the provider — it must back off and retry, not
// terminally fail the issue, so it is matched here too.
const CAPACITY_PATTERNS: readonly RegExp[] = [
  /usage limit/i,
  /rate limit/i,
  /quota/i,
  /at capacity/i,
  /try a different model/i,
];

export function classifyCodexFailure(
  errorMessage: string | undefined,
  now: Date = new Date(),
): CodexFailureClassification {
  const detail = errorMessage?.trim();
  if (!detail) return { kind: "other" };
  if (!CAPACITY_PATTERNS.some((pattern) => pattern.test(detail))) {
    return { kind: "other" };
  }
  const retryAtIso = parseRetryAt(detail, now);
  return { kind: "capacity", detail, ...(retryAtIso ? { retryAtIso } : {}) };
}

const MONTHS = new Map<string, number>([
  ["jan", 0], ["january", 0],
  ["feb", 1], ["february", 1],
  ["mar", 2], ["march", 2],
  ["apr", 3], ["april", 3],
  ["may", 4],
  ["jun", 5], ["june", 5],
  ["jul", 6], ["july", 6],
  ["aug", 7], ["august", 7],
  ["sep", 8], ["sept", 8], ["september", 8],
  ["oct", 9], ["october", 9],
  ["nov", 10], ["november", 10],
  ["dec", 11], ["december", 11],
]);

// Parses "try again at 3:23 AM" into the NEXT such wall-clock time in the
// host's local timezone (today if still ahead, otherwise tomorrow), plus the
// dated form emitted for longer account limits: "try again at Sep 19th, 2026
// 10:09 AM". An explicit past date is not rolled forward.
function parseRetryAt(message: string, now: Date): string | undefined {
  const dated = /try again at ([a-z]{3,9})\s+(\d{1,2})(?:st|nd|rd|th)?,\s*(\d{4})\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?/i.exec(message);
  if (dated) {
    const month = MONTHS.get(dated[1]!.toLowerCase());
    const day = Number(dated[2]);
    const year = Number(dated[3]);
    const rawHour = Number(dated[4]);
    const minute = dated[5] === undefined ? 0 : Number(dated[5]);
    if (month === undefined || day < 1 || day > 31 || rawHour < 1 || rawHour > 12 || minute > 59) {
      return undefined;
    }
    const isPm = dated[6]!.toLowerCase() === "p";
    const candidate = new Date(year, month, day, (rawHour % 12) + (isPm ? 12 : 0), minute, 0, 0);
    if (
      candidate.getFullYear() !== year
      || candidate.getMonth() !== month
      || candidate.getDate() !== day
      || candidate.getTime() <= now.getTime()
    ) {
      return undefined;
    }
    return candidate.toISOString();
  }
  const match = /try again at (\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?/i.exec(message);
  if (!match) return undefined;
  const rawHour = Number(match[1]);
  const minute = match[2] === undefined ? 0 : Number(match[2]);
  if (rawHour < 1 || rawHour > 12 || minute > 59) return undefined;
  const isPm = match[3]?.toLowerCase() === "p";
  const hour = (rawHour % 12) + (isPm ? 12 : 0);
  const candidate = new Date(now);
  candidate.setHours(hour, minute, 0, 0);
  if (candidate.getTime() <= now.getTime()) {
    candidate.setDate(candidate.getDate() + 1);
  }
  return candidate.toISOString();
}
