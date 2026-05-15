import type { ReconcilePullRequestSnapshot } from "./reconcile-pr-fetch.ts";

function normalizedReviewDecision(value: string | undefined): string | undefined {
  return value?.trim().toUpperCase();
}

export type PrReviewState = "approved" | "changes_requested" | "commented";

export interface PrStateUpdates {
  prHeadSha?: string;
  prState?: "open";
  prReviewState?: PrReviewState;
  prCheckStatus?: "pending" | "success" | "failure" | "unknown";
  lastGitHubCiSnapshotHeadSha?: string;
  lastGitHubCiSnapshotGateCheckName?: string;
  lastGitHubCiSnapshotGateCheckStatus?: "pending" | "success" | "failure" | "unknown";
  lastGitHubCiSnapshotSettledAt?: string | null;
}

function reviewDecisionToPrReviewState(value: string | undefined): PrReviewState | undefined {
  const normalized = normalizedReviewDecision(value);
  if (normalized === "APPROVED") return "approved";
  if (normalized === "CHANGES_REQUESTED") return "changes_requested";
  if (normalized === "REVIEW_REQUIRED") return "commented";
  return undefined;
}

/**
 * Pure projection from a fresh `gh pr view` snapshot into the issue-row
 * fields that should be written back. Keeps the snapshot row in sync with
 * GitHub truth and records a CI snapshot row (for the queue-health monitor
 * and the operator feed) when both the head SHA and a gate check status
 * are observable.
 *
 * Settled-at is null when the gate check is still pending so callers can
 * tell a freshly-observed "in progress" from a recently-settled result.
 */
export function buildPrStateUpdates(
  pr: ReconcilePullRequestSnapshot,
  gateCheckStatus: "pending" | "success" | "failure" | "unknown" | undefined,
  primaryGateCheckName: string,
  now: () => Date = () => new Date(),
): PrStateUpdates {
  const prReviewState = reviewDecisionToPrReviewState(pr.reviewDecision);
  return {
    ...(pr.headRefOid ? { prHeadSha: pr.headRefOid } : {}),
    ...(pr.state === "OPEN" ? { prState: "open" as const } : {}),
    ...(prReviewState ? { prReviewState } : {}),
    ...(gateCheckStatus ? { prCheckStatus: gateCheckStatus } : {}),
    ...(pr.headRefOid && gateCheckStatus
      ? {
          lastGitHubCiSnapshotHeadSha: pr.headRefOid,
          lastGitHubCiSnapshotGateCheckName: primaryGateCheckName,
          lastGitHubCiSnapshotGateCheckStatus: gateCheckStatus,
          lastGitHubCiSnapshotSettledAt: gateCheckStatus === "pending" ? null : now().toISOString(),
        }
      : {}),
  };
}
