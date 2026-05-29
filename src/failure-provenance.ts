import type { IssueRecord } from "./db-types.ts";

/**
 * Every failure-provenance field on an issue, set to null.
 *
 * Spread into an issue upsert when a run reaches a clean advancing or terminal
 * state (for example `awaiting_queue` or `done`) and any previously recorded
 * GitHub failure or queue-incident context must not leak into the next
 * decision. Keeping the field set in one place stops it from drifting between
 * the run finalizer, the reconcilers, the completion check, and the webhook
 * state projector.
 */
export const CLEARED_FAILURE_PROVENANCE = {
  lastGitHubFailureSource: null,
  lastGitHubFailureHeadSha: null,
  lastGitHubFailureSignature: null,
  lastGitHubFailureCheckName: null,
  lastGitHubFailureCheckUrl: null,
  lastGitHubFailureContextJson: null,
  lastGitHubFailureAt: null,
  lastQueueIncidentJson: null,
  lastAttemptedFailureHeadSha: null,
  lastAttemptedFailureSignature: null,
  lastAttemptedFailureAt: null,
} as const satisfies Partial<Record<keyof IssueRecord, null>>;
