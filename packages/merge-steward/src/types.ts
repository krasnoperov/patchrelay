/**
 * Queue entry statuses.
 *
 * queued → preparing_head → validating → merging → merged
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
  /** Speculative branch name (e.g., mq/spec-{entryId}). Null if not yet built. */
  specBranch: string | null;
  /** SHA of the speculative branch head. */
  specSha: string | null;
  /** Entry ID of the previous entry this spec branch is based on. Null if based on main. */
  specBasedOn: string | null;
  enqueuedAt: string;
  updatedAt: string;
}

export type FailureClass =
  | "main_broken"
  | "branch_local"
  | "integration_conflict"
  | "policy_blocked";

export type CheckConclusion = "success" | "failure" | "pending";

export interface CheckResult {
  name: string;
  conclusion: CheckConclusion;
  url?: string | undefined;
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

export interface QueueBlockState {
  reason: "main_broken";
  entryId: string;
  headPrNumber: number | null;
  baseBranch: string;
  baseSha: string | null;
  observedAt: string;
  failingChecks: CheckResult[];
  pendingChecks: CheckResult[];
}

export interface QueueWatchSnapshot {
  repoId: string;
  repoFullName: string;
  baseBranch: string;
  summary: QueueStatusSummary;
  runtime: QueueRuntimeStatus;
  queueBlock: QueueBlockState | null;
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
  mergeable: boolean;
  reviewApproved: boolean;
  merged: boolean;
}

export interface QueueConfig {
  repoId: string;
  baseBranch: string;
  maxRetries: number;
  flakyRetries: number;
  pollIntervalMs: number;
  requiredChecks: string[];
}

// ─── Reconciler Event Stream ────────────────────────────────────

export type ReconcileAction =
  | "promoted"             // queued → preparing_head
  | "fetch_started"
  | "main_broken"
  | "branch_mismatch"     // external push detected
  | "rebase_started"
  | "rebase_succeeded"
  | "rebase_conflict"
  | "spec_build_started"
  | "spec_build_succeeded"
  | "spec_build_conflict"
  | "ci_triggered"
  | "ci_pending"
  | "ci_passed"
  | "ci_failed"
  | "ci_flaky_retry"
  | "merge_revalidating"
  | "merge_succeeded"
  | "merge_rejected"
  | "merge_external"      // already merged outside queue
  | "evicted"
  | "invalidated"         // downstream entry reset due to base change
  | "retry_gated"         // non-spinning, waiting for base change
  | "budget_exhausted";

export interface ReconcileEvent {
  at: string;
  entryId: string;
  prNumber: number;
  action: ReconcileAction;
  detail?: string | undefined;
  specBranch?: string | undefined;
  baseSha?: string | undefined;
  ciRunId?: string | undefined;
  conflictFiles?: string[] | undefined;
  failingChecks?: CheckResult[] | undefined;
  pendingChecks?: CheckResult[] | undefined;
  failureClass?: string | undefined;
  dependsOn?: string | undefined;
}
