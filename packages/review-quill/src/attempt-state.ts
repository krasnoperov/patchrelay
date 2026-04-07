import type { ReviewAttemptRecord } from "./types.ts";

export interface ReviewAttemptStalenessPolicy {
  queuedAfterMs: number;
  runningAfterMs: number;
}

export interface ReviewAttemptStateContext {
  now?: number;
  serviceStartedAt?: string | number | Date;
  policy: ReviewAttemptStalenessPolicy;
}

export interface ReviewAttemptState {
  stale: boolean;
  staleReason?: string;
}

export function isAttemptActive(attempt: ReviewAttemptRecord): boolean {
  return attempt.status === "queued" || attempt.status === "running";
}

export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1_000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const totalHours = Math.floor(totalMinutes / 60);
  if (totalHours < 48) return `${totalHours}h`;
  return `${Math.floor(totalHours / 24)}d`;
}

function parseTimestamp(value: string | number | Date | undefined): number | undefined {
  if (value === undefined) return undefined;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

export function describeAttemptState(
  attempt: ReviewAttemptRecord,
  context: ReviewAttemptStateContext,
): ReviewAttemptState {
  if (!isAttemptActive(attempt)) {
    return { stale: false };
  }

  const updatedAtMs = parseTimestamp(attempt.updatedAt);
  const nowMs = context.now ?? Date.now();
  const serviceStartedAtMs = parseTimestamp(context.serviceStartedAt);
  if (updatedAtMs === undefined) {
    return {
      stale: true,
      staleReason: "Attempt has an unreadable heartbeat timestamp.",
    };
  }

  if (serviceStartedAtMs !== undefined && updatedAtMs < serviceStartedAtMs) {
    return {
      stale: true,
      staleReason: `Attempt was left ${attempt.status} across a review-quill restart; last heartbeat was ${formatDuration(nowMs - updatedAtMs)} ago.`,
    };
  }

  const staleAfterMs = attempt.status === "queued"
    ? context.policy.queuedAfterMs
    : context.policy.runningAfterMs;
  const ageMs = Math.max(0, nowMs - updatedAtMs);
  if (ageMs >= staleAfterMs) {
    return {
      stale: true,
      staleReason: `Attempt has been ${attempt.status} without a heartbeat for ${formatDuration(ageMs)} (threshold ${formatDuration(staleAfterMs)}).`,
    };
  }

  return { stale: false };
}

export function decorateAttempt(
  attempt: ReviewAttemptRecord,
  context: ReviewAttemptStateContext,
): ReviewAttemptRecord {
  const state = describeAttemptState(attempt, context);
  if (!state.stale) {
    return {
      ...attempt,
      stale: false,
    };
  }
  return {
    ...attempt,
    stale: true,
    ...(state.staleReason ? { staleReason: state.staleReason } : {}),
  };
}
