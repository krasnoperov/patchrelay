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
  enqueuedAt: string;
  updatedAt: string;
}

export type FailureClass =
  | "main_broken"
  | "branch_local"
  | "integration_conflict"
  | "policy_blocked";

export type CheckConclusion =
  | "success"
  | "failure"
  | "timed_out"
  | "cancelled"
  | "pending";

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
  failedChecks?: Array<{ name: string; conclusion: string }> | undefined;
  baseSha: string;
  prHeadSha: string;
  queuePosition: number;
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

export interface QueueWatchSnapshot {
  repoId: string;
  repoFullName: string;
  baseBranch: string;
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
