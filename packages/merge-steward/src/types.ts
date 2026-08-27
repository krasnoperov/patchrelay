/**
 * Queue entry statuses.
 *
 * queued → preparing_head → validating → merging → merged
 *
 * Every entry resolves an explicit immutable candidate. Exact-head candidates
 * reuse checks on that SHA; integration candidates run on a cumulative ref.
 *
 * Failure: any state → evicted (after retry budget exhausted).
 * Conflict retries are gated on base SHA change (non-spinning).
 *
 * Terminal states: merged, evicted, dequeued.
 */
export type QueueEntryStatus =
  | "queued"
  | "preparing_head"
  | "validating"
  | "merging"
  | "evicted"
  | "merged"
  | "dequeued";

export const TERMINAL_STATUSES: QueueEntryStatus[] = ["merged", "evicted", "dequeued"];

export type PostMergeStatus = "pending" | "pass" | "fail" | "unknown";
export type CandidateKind = "head" | "integration";

export interface QueueEntry {
  id: string;
  repoId: string;
  prNumber: number;
  branch: string;
  headSha: string;
  baseSha: string;
  status: QueueEntryStatus;
  position: number;
  priority: number;
  generation: number;
  ciRunId: string | null;
  ciRetries: number;
  retryAttempts: number;
  maxRetries: number;
  /** Base SHA at the time of last conflict — gates non-spinning retries. */
  lastFailedBaseSha: string | null;
  issueKey: string | null;
  /** Explicit identity of the immutable commit proposed as the next main. */
  candidateKind: CandidateKind | null;
  /** Fingerprint of the GitHub check policy used to validate the candidate. */
  candidatePolicyFingerprint: string | null;
  /** Ephemeral ref used to run an integration candidate. Null for head candidates. */
  candidateRef: string | null;
  /** Exact immutable commit proposed as the next value of main. */
  candidateSha: string | null;
  /** Entry whose candidate this one extends. Null when based on current main. */
  candidateBasedOn: string | null;
  /** Optional human-facing wait reason when the entry is blocked inside its current state. */
  waitDetail?: string | null;
  /** Post-merge verification status for the landed commit on main. */
  postMergeStatus: PostMergeStatus | null;
  /** PR title captured at admission. Falls back to branch name in the UI. */
  prTitle?: string | null;
  /** Commit SHA used when checking post-merge status. */
  postMergeSha: string | null;
  /** Optional one-line summary of post-merge checks. */
  postMergeSummary: string | null;
  /** Timestamp of the most recent post-merge verification attempt. */
  postMergeCheckedAt: string | null;
  /**
   * PR's base ref captured at admission. When this names
   * another open PR's `branch` (head ref), the entry is stacked and
   * the queue holds it behind the parent until the parent is itself
   * admitted. `null` when the PR was opened against the repo default.
   */
  baseRefName: string | null;
  enqueuedAt: string;
  updatedAt: string;
  /**
   * Set once, when the entry first reaches a terminal status
   * (merged/evicted/dequeued), and never bumped afterward — unlike
   * updatedAt, which post-merge re-verification keeps moving. Lets the
   * dashboard report an accurate "how long it took" (decidedAt - enqueuedAt)
   * and "how long ago" (now - decidedAt). Null while still in flight.
   */
  decidedAt: string | null;
}

export type FailureClass =
  | "main_broken"
  | "branch_local"
  | "integration_conflict"
  | "policy_blocked";

export type CheckConclusion = "success" | "failure" | "pending" | "neutral" | "skipped";

export interface CheckResult {
  name: string;
  conclusion: CheckConclusion;
  /** GitHub App that produced the check run, when GitHub exposes it. */
  appId?: number | undefined;
  /** Monotonic GitHub check-run id, used to distinguish a real rerun. */
  runId?: number | undefined;
  url?: string | undefined;
}

export interface RequiredCheck {
  name: string;
  /** Null means branch policy accepts this context from any producer. */
  appId: number | null;
}

/**
 * Context attached to an eviction incident. Structured data that any
 * external agent can use to understand and potentially repair the failure.
 * The GitHub check run output is a projection of this record.
 */
export interface EvictionContext {
  version: 1;
  failureClass: FailureClass;
  conflictFiles?: string[] | undefined;
  failedChecks?: Array<{ name: string; conclusion: string; url?: string }> | undefined;
  openPrAncestors?: Array<{ prNumber: number; branch: string; headSha: string; sharedAncestorSha: string }> | undefined;
  baseSha: string;
  prHeadSha: string;
  queuePosition: number;
  baseBranch?: string | undefined;
  branch?: string | undefined;
  issueKey?: string | null | undefined;
  retryHistory: Array<{ at: string; baseSha: string; outcome: string }>;
}

/**
 * Durable eviction/incident record. Source of truth — the GitHub check
 * run is a projection of this. Persists in queue_incidents table.
 */
export interface IncidentRecord {
  id: string;
  entryId: string;
  at: string;
  failureClass: FailureClass;
  context: EvictionContext;
  outcome: "open" | "resolved" | "superseded";
}

export interface QueueEventRecord {
  id?: number | undefined;
  entryId: string;
  at: string;
  fromStatus: QueueEntryStatus | null;
  toStatus: QueueEntryStatus;
  detail?: string | undefined;
  /** Snapshot of entry.baseSha at transition time. */
  baseSha?: string | undefined;
}

export interface QueueEventSummary extends QueueEventRecord {
  prNumber: number;
  branch: string;
  issueKey: string | null;
}

export interface QueueRuntimeStatus {
  tickInProgress: boolean;
  lastTickStartedAt: string | null;
  lastTickCompletedAt: string | null;
  lastTickOutcome: "idle" | "running" | "succeeded" | "failed";
  lastTickError: string | null;
  tickAgeMs?: number | null;
  staleTickThresholdMs?: number;
  staleTick?: boolean;
  lastReconcileEvent?: ReconcileEventSummary | null;
}

export interface ReconcileEventSummary {
  at: string;
  entryId: string;
  prNumber: number;
  action: ReconcileAction;
  detail?: string | undefined;
  ciRunId?: string | undefined;
  candidateRef?: string | undefined;
  candidateKind?: CandidateKind | undefined;
  candidateSha?: string | undefined;
}

export interface QueueReconcileResult {
  started: boolean;
  reason?: "already_running" | undefined;
  runtime: QueueRuntimeStatus;
}

export interface QueueStatusSummary {
  total: number;
  active: number;
  queued: number;
  preparingHead: number;
  validating: number;
  merging: number;
  merged: number;
  evicted: number;
  dequeued: number;
  headEntryId: string | null;
  headPrNumber: number | null;
}

export interface GitHubPolicyState {
  requiredChecks: string[];
  requiredCheckRules?: RequiredCheck[];
  requireAllChecksOnEmptyRequiredSet: boolean;
  fetchedAt: string | null;
  lastRefreshReason: string | null;
  lastRefreshChanged: boolean | null;
}

export interface QueueWatchSnapshot {
  repoId: string;
  repoFullName: string;
  baseBranch: string;
  githubPolicy: GitHubPolicyState;
  summary: QueueStatusSummary;
  runtime: QueueRuntimeStatus;
  entries: QueueEntry[];
  recentEvents: QueueEventSummary[];
}

export interface QueueEntryDetail {
  entry: QueueEntry;
  events: QueueEventRecord[];
  incidents: IncidentRecord[];
}

export interface RebaseResult {
  success: boolean;
  newHeadSha?: string | undefined;
  conflictFiles?: string[] | undefined;
}

export interface MergeResult {
  success: boolean;
  sha?: string | undefined;
  conflictFiles?: string[] | undefined;
}

export type CIStatus = "pending" | "pass" | "fail";

export interface PRStatus {
  number: number;
  branch: string;
  headSha: string;
  title?: string | undefined;
  /** Base ref used to recognize and order stacked PRs. */
  baseRefName?: string | undefined;
  mergeable: boolean;
  mergeStateStatus?: string | undefined;
  reviewDecision?: string | undefined;
  reviewApproved: boolean;
  merged: boolean;
}

export interface QueueConfig {
  repoId: string;
  baseBranch: string;
  maxRetries: number;
  flakyRetries: number;
  pollIntervalMs: number;
}

// ─── Reconciler Event Stream ────────────────────────────────────

export type ReconcileAction =
  | "promoted"             // queued → preparing_head
  | "fetch_started"
  | "main_broken"
  | "branch_mismatch"     // external push detected
  | "candidate_selected"
  | "integration_build_started"
  | "integration_build_succeeded"
  | "integration_build_conflict"
  | "ci_triggered"
  | "ci_pending"
  | "ci_passed"
  | "ci_failed"
  | "ci_flaky_retry"
  | "merge_revalidating"
  | "head_candidate_landed"
  | "merge_succeeded"
  | "merge_rejected"
  | "merge_external"      // already merged outside queue
  | "policy_changed"      // GitHub branch protection changed
  | "evicted"
  | "invalidated"         // downstream entry reset due to base change
  | "retry_gated"         // non-spinning, waiting for base change
  | "budget_exhausted"
  | "merge_waiting_approval" // approval withdrawn, waiting for re-approval
  | "open_pr_ancestry_blocked" // candidate shares PR history not yet present in main
  | "stack_dependency_waiting"
  | "merge_waiting_recognition" // PR head already reaches main; wait for GitHub to classify the merge
  | "merge_waiting_main"     // main still verifying post-merge; keep spec + CI and retry
  | "main_pending_bypassed"  // main rerun pending for an already-validated merge commit
  | "pr_branch_cleanup_deferred" // GitHub has not yet classified the PR as merged
  | "pr_branch_cleanup_failed"   // branch cleanup failed after merge; non-blocking
  | "sanitized_closed"    // entry terminalized: PR closed on GitHub
  | "sanitized_duplicate" // older duplicate entry superseded
  | "post_merge_verification_started"
  | "post_merge_verification_completed"
  | "queue_label_synced"  // GitHub queue sub-state label (queue:testing/queue:merging) updated
  | "branch_unreachable"; // branch gone or git operation failed unexpectedly

export interface ReconcileEvent {
  at: string;
  entryId: string;
  prNumber: number;
  action: ReconcileAction;
  detail?: string | undefined;
  candidateRef?: string | undefined;
  candidateKind?: CandidateKind | undefined;
  candidateSha?: string | undefined;
  policyFingerprint?: string | undefined;
  baseSha?: string | undefined;
  ciRunId?: string | undefined;
  conflictFiles?: string[] | undefined;
  failingChecks?: CheckResult[] | undefined;
  pendingChecks?: CheckResult[] | undefined;
  missingRequiredChecks?: string[] | undefined;
  failureClass?: string | undefined;
  dependsOn?: string | undefined;
}
