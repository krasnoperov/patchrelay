// Codex capacity-limit handling.
//
// When the Codex/ChatGPT account exhausts its usage allowance, every review
// turn fails with an account-level error such as:
//
//   "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro),
//    visit https://chatgpt.com/codex/settings/usage to purchase more credits
//    or try again at 3:23 AM."
//
// Retrying per-PR is pointless — the limit is shared across the whole
// account — and each retry burns a fresh workspace + Codex thread every
// reconciliation cycle. This module provides:
//
//   - classifyCodexFailure: recognizes capacity-style errors and parses the
//     advertised "try again at H(:MM) AM/PM" wall-clock time into the next
//     local-timezone occurrence;
//   - CodexCapacityError: the typed error the review runner throws so the
//     service can tell capacity exhaustion apart from real review failures;
//   - CodexCapacityPause: the service-wide gate that suspends ALL review
//     dispatch until the advertised reset time (plus jitter) passes.

export type CodexFailureClassification =
  | { kind: "capacity"; detail: string; retryAtIso?: string }
  | { kind: "other" };

// Account-level capacity exhaustion wording observed from Codex. Matched
// case-insensitively anywhere in the error text.
const CAPACITY_PATTERNS = [/usage limit/i, /rate limit/i, /quota/i];

// "try again at 3:23 AM" / "try again at 11 PM". Minutes are optional.
const TRY_AGAIN_AT_PATTERN = /try again at (\d{1,2})(?::(\d{2}))?\s*(AM|PM)/i;

/**
 * Classify a Codex turn error. Returns `kind: "capacity"` when the message
 * matches known usage-limit/rate-limit/quota wording; when the message also
 * advertises a "try again at <time>" reset, `retryAtIso` is the NEXT
 * occurrence of that wall-clock time in the local timezone relative to `now`.
 */
export function classifyCodexFailure(
  errorMessage: string | undefined,
  now: Date = new Date(),
): CodexFailureClassification {
  if (!errorMessage || !errorMessage.trim()) return { kind: "other" };
  if (!CAPACITY_PATTERNS.some((pattern) => pattern.test(errorMessage))) {
    return { kind: "other" };
  }
  const retryAt = parseTryAgainAt(errorMessage, now);
  return {
    kind: "capacity",
    detail: errorMessage.trim(),
    ...(retryAt ? { retryAtIso: retryAt.toISOString() } : {}),
  };
}

function parseTryAgainAt(message: string, now: Date): Date | undefined {
  const match = message.match(TRY_AGAIN_AT_PATTERN);
  if (!match) return undefined;
  const rawHour = Number.parseInt(match[1]!, 10);
  const minute = match[2] ? Number.parseInt(match[2], 10) : 0;
  if (rawHour < 1 || rawHour > 12 || minute > 59) return undefined;
  // 12 AM → 00:xx, 12 PM → 12:xx, otherwise PM adds 12.
  let hour = rawHour === 12 ? 0 : rawHour;
  if (match[3]!.toUpperCase() === "PM") hour += 12;
  const candidate = new Date(now);
  candidate.setHours(hour, minute, 0, 0);
  if (candidate.getTime() <= now.getTime()) {
    candidate.setDate(candidate.getDate() + 1);
  }
  return candidate;
}

/**
 * Thrown by the review runner when a Codex turn failed because the account
 * is out of capacity. Carries the raw error text (`detail`) and the parsed
 * reset time (`retryAtIso`) when the message advertised one.
 */
export class CodexCapacityError extends Error {
  constructor(
    readonly detail: string,
    readonly retryAtIso?: string,
  ) {
    super(`Codex usage limit reached: ${detail}`);
    this.name = "CodexCapacityError";
  }
}

/** Fallback pause when the error did not advertise a reset time. */
const DEFAULT_PAUSE_MS = 10 * 60_000;
/** Upper bound on the random jitter added past the advertised reset time. */
const MAX_JITTER_MS = 60_000;

export interface CodexCapacityPauseEntry {
  /** True when this call transitioned the gate from open to paused —
   *  the caller should emit its single warn-level log exactly then. */
  entered: boolean;
  untilIso: string;
}

/**
 * Service-wide review-dispatch gate for Codex capacity exhaustion.
 *
 * Deliberately in-memory only: a restart during a pause simply retries on
 * the next reconciliation cycle and re-enters the pause as soon as the first
 * attempt hits the same capacity error again. Persisting the deadline buys
 * nothing — Codex itself is the source of truth for whether capacity is back.
 */
export class CodexCapacityPause {
  private untilMs: number | null = null;
  private untilIso: string | null = null;

  constructor(private readonly random: () => number = Math.random) {}

  /**
   * Record a capacity failure. The pause deadline is the advertised reset
   * time plus ≤60s of jitter (so a fleet of workers doesn't stampede Codex
   * at the exact reset second), or now + 10 minutes when no reset time was
   * parsed. While already paused, later failures only ever EXTEND the
   * deadline (never shorten it) and report `entered: false` so the caller
   * logs the pause once, not once per PR per cycle.
   */
  enter(error: CodexCapacityError, now: number = Date.now()): CodexCapacityPauseEntry {
    const advertised = error.retryAtIso ? Date.parse(error.retryAtIso) : Number.NaN;
    const jitter = Math.floor(this.random() * MAX_JITTER_MS);
    const target = Number.isFinite(advertised) && advertised > now
      ? advertised + jitter
      : now + DEFAULT_PAUSE_MS;
    const alreadyPaused = this.isPaused(now);
    if (!alreadyPaused || this.untilMs === null || target > this.untilMs) {
      this.untilMs = target;
      this.untilIso = new Date(target).toISOString();
    }
    return { entered: !alreadyPaused, untilIso: this.untilIso! };
  }

  /**
   * Whether review dispatch is currently suspended. Resumption is automatic:
   * once `now` passes the deadline the gate clears itself and the next
   * reconciliation cycle re-attempts normally.
   */
  isPaused(now: number = Date.now()): boolean {
    if (this.untilMs === null) return false;
    if (now >= this.untilMs) {
      this.untilMs = null;
      this.untilIso = null;
      return false;
    }
    return true;
  }

  /** ISO deadline while paused, null otherwise. Surfaced in /health. */
  limitedUntil(now: number = Date.now()): string | null {
    return this.isPaused(now) ? this.untilIso : null;
  }
}
