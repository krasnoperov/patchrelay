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

/**
 * Evidence carried by a GitHub observation when a writer wants to clear
 * failure provenance. Built by both ingestion paths:
 *
 * - the webhook projector from the event payload (head SHA + which check
 *   succeeded),
 * - the idle reconciler from a polled `gh pr view` snapshot (current head +
 *   settled gate status).
 */
export interface ObservedProvenanceEvidence {
  /** PR state, when observed. A merged or closed PR supersedes any failure. */
  prState?: "open" | "closed" | "merged" | undefined;
  /** Head SHA the evidence was observed for. */
  headSha?: string | undefined;
  /**
   * True when `headSha` is known to be the PR's *current* head — a polled
   * snapshot, or a push event that carries the freshly pushed head. Webhook
   * check events can be delivered out of order, so their head SHA alone never
   * proves the failure head was superseded.
   */
  headIsCurrentTruth?: boolean | undefined;
  /** Settled branch-gate status observed for `headSha`. */
  gateCheckStatus?: string | undefined;
  /** The merge-queue eviction check succeeded for `headSha`. */
  evictionCheckSucceeded?: boolean | undefined;
}

type FailureProvenanceCurrent = Pick<
  IssueRecord,
  "lastGitHubFailureSource" | "lastGitHubFailureHeadSha"
>;

/**
 * The single rule for clearing failure provenance (core simplification plan,
 * phase C1): provenance may be cleared only when the observed evidence is
 * NEWER than the recorded failure —
 *
 * 1. the PR merged or closed (nothing left to repair), or
 * 2. the PR's current head differs from `lastGitHubFailureHeadSha` (the
 *    failing commit was superseded), or
 * 3. the same kind of check that recorded the failure succeeded on the
 *    recorded failure head (the failure was actually fixed):
 *    - `queue_eviction` failures require the eviction check itself to
 *      succeed — a green *branch* gate proves nothing about integration
 *      with main (the swallowed-repair bug), while
 *    - `branch_ci` (and unclassified) failures are cleared by a green gate
 *      or a green eviction check on the failure head.
 *
 * A poll that merely "looks green" on the same head never clears a queue
 * incident, and a stale check event for an unrelated head never clears
 * anything.
 */
export function mayClearFailureProvenance(
  current: FailureProvenanceCurrent,
  observed: ObservedProvenanceEvidence,
): boolean {
  if (observed.prState === "merged" || observed.prState === "closed") {
    return true;
  }
  const failureHeadSha = current.lastGitHubFailureHeadSha;
  if (!failureHeadSha) {
    // Nothing concrete recorded to preserve — clearing is harmless.
    return true;
  }
  if (observed.headSha && observed.headIsCurrentTruth && observed.headSha !== failureHeadSha) {
    return true;
  }
  if (observed.headSha === failureHeadSha) {
    if (current.lastGitHubFailureSource === "queue_eviction") {
      return observed.evictionCheckSucceeded === true;
    }
    return observed.gateCheckStatus === "success" || observed.evictionCheckSucceeded === true;
  }
  return false;
}
