import { resolveFactoryStateFromGitHub, type FactoryState } from "./factory-state.ts";
import type { GitHubTriggerEvent } from "./github-types.ts";
import {
  isFailingCheckStatus,
  isReviewDecisionApproved,
  isReviewDecisionReviewRequired,
} from "./idle-reconciliation-helpers.ts";

/**
 * Normalized GitHub PR facts observed by either ingestion path (core
 * simplification plan, phase C1).
 *
 * Both the webhook projector and the idle reconciler build this object from
 * their own sources — the webhook payload vs a polled `gh pr view` snapshot —
 * and call {@link deriveFactoryStateFromPrFacts} for the factory-state
 * decision. Same inputs produce the same state by construction; the only
 * deliberate divergence between the paths is the *shape* of the evidence:
 *
 * - A webhook is a **delta** observation: it carries a concrete
 *   `triggerEvent`, so the decision routes through the transition-rule table
 *   in `factory-state.ts`.
 * - A poll is a **level** observation: there is no trigger event, only the
 *   current PR state, review decision, and settled gate status, so the
 *   decision uses the level rules below (terminal recovery, approved →
 *   awaiting_queue, closed-PR disposition).
 */
export interface ObservedPrFacts {
  /** Which ingestion path produced the facts (for logging/telemetry). */
  source: "webhook" | "poll";
  /** Delta observation: the concrete GitHub trigger event (webhook only). */
  triggerEvent?: GitHubTriggerEvent | undefined;
  /** Current PR state, normalized to the issue-store vocabulary. */
  prState?: "open" | "closed" | "merged" | undefined;
  /** PR number when the observation is PR-shaped. */
  prNumber?: number | undefined;
  /**
   * Review decision as GitHub reports it (`APPROVED`, `CHANGES_REQUESTED`,
   * `REVIEW_REQUIRED`, case-insensitive). Webhook review events express the
   * decision through `triggerEvent` instead.
   */
  reviewDecision?: string | undefined;
  /** Settled branch gate status for `headSha` (`pending`/`success`/`failure`). */
  gateCheckStatus?: string | undefined;
  /** Head SHA the observation refers to. */
  headSha?: string | undefined;
  /** Poll only: the polled head differs from the previously recorded one. */
  headAdvanced?: boolean | undefined;
  /** Webhook only: classification of a `check_failed` event. */
  failureSource?: "queue_eviction" | "branch_ci" | undefined;
  /** Webhook only: the commit a `review_approved` event approved. */
  approvalHeadSha?: string | undefined;
  /**
   * Poll only, when `prState === "closed"`: what the closed PR means for the
   * issue (`resolveClosedPrDisposition`). Webhook `pr_closed` events return
   * `undefined` here — the terminal-PR handler owns that path.
   */
  closedPrDisposition?: "done" | "terminal" | "redelegate" | undefined;
}

/** The slice of the current issue row the derivation depends on. */
export interface CurrentIssueFacts {
  factoryState: FactoryState;
  prReviewState?: string | undefined;
  activeRunId?: number | undefined;
  activeRunType?: string | undefined;
  activeRunSourceHeadSha?: string | undefined;
}

/**
 * Pure factory-state derivation shared by the webhook projector and the idle
 * reconciler. Returns the state the issue should move to, or `undefined`
 * when the observation is a no-op for the current state.
 */
export function deriveFactoryStateFromPrFacts(
  observed: ObservedPrFacts,
  current: CurrentIssueFacts,
): FactoryState | undefined {
  if (observed.triggerEvent !== undefined) {
    return deriveFromTriggerEvent(observed.triggerEvent, observed, current);
  }
  return deriveFromPolledLevel(observed, current);
}

// ── Delta observations (webhook trigger events) ─────────────────────
// The transition-rule table in factory-state.ts is the spec; this wrapper
// adds the awaiting_input/delegated lifting that the webhook path applies
// before consulting the table.
function deriveFromTriggerEvent(
  triggerEvent: GitHubTriggerEvent,
  observed: ObservedPrFacts,
  current: CurrentIssueFacts,
): FactoryState | undefined {
  if (triggerEvent === "pr_closed") {
    // The terminal-PR handler owns the closed-PR decision on the webhook path.
    return undefined;
  }

  const effectiveCurrentState =
    (current.factoryState === "awaiting_input" || current.factoryState === "delegated")
    && (observed.prState === "open" || observed.prNumber !== undefined)
      ? "pr_open"
      : current.factoryState;

  const resolved = resolveFactoryStateFromGitHub(triggerEvent, effectiveCurrentState, {
    prReviewState: current.prReviewState,
    activeRunId: current.activeRunId,
    failureSource: observed.failureSource,
    ...(current.activeRunType ? { activeRunType: current.activeRunType } : {}),
    ...(current.activeRunSourceHeadSha ? { activeRunSourceHeadSha: current.activeRunSourceHeadSha } : {}),
    ...(observed.approvalHeadSha ? { approvalHeadSha: observed.approvalHeadSha } : {}),
  });
  if (resolved !== undefined) {
    return resolved;
  }
  if (effectiveCurrentState !== current.factoryState) {
    return effectiveCurrentState;
  }
  return undefined;
}

// ── Level observations (polled snapshot) ────────────────────────────
function deriveFromPolledLevel(
  observed: ObservedPrFacts,
  current: CurrentIssueFacts,
): FactoryState | undefined {
  if (observed.prState === "closed") {
    if (observed.closedPrDisposition === "done") return "done";
    if (observed.closedPrDisposition === "terminal") return undefined;
    return "delegated";
  }
  if (observed.prState === "merged") {
    // Mirrors the pr_merged transition rule: with an active run the
    // finalizer owns the completion; deploy tracking may map "done" to
    // "deploying" at the call site.
    return current.activeRunId === undefined ? "done" : undefined;
  }

  if (current.factoryState === "escalated" || current.factoryState === "failed") {
    // Terminal recovery: newer GitHub truth reopens a stuck terminal issue.
    // No fall-through to the generic approved rule — an escalated issue with
    // a red gate stays escalated (the failure provenance keeps the repair
    // routable; auto-reopening would swallow it).
    if (isReviewDecisionApproved(observed.reviewDecision) && !isFailingCheckStatus(observed.gateCheckStatus)) {
      return "awaiting_queue";
    }
    if (observed.gateCheckStatus === "pending") {
      return "pr_open";
    }
    if (observed.headAdvanced && !isFailingCheckStatus(observed.gateCheckStatus)) {
      return "pr_open";
    }
    if (isReviewDecisionReviewRequired(observed.reviewDecision) && !isFailingCheckStatus(observed.gateCheckStatus)) {
      return "pr_open";
    }
    return undefined;
  }

  if (isReviewDecisionApproved(observed.reviewDecision)) {
    return "awaiting_queue";
  }
  return undefined;
}
