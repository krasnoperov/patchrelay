/**
 * Queue entry statuses — Phase 1 lifecycle.
 *
 * queued → preparing_head → validating → merging → merged
 *
 * Failure paths:
 *   preparing_head   → repair_requested → repair_in_progress → preparing_head
 *   validating       → repair_requested (CI failure, retries exhausted)
 *   repair_requested → evicted (budget exhausted)
 *
 * Terminal states: merged, evicted, dequeued.
 * paused: reserved for Phase 2 (policy_blocked — no approval, manual hold).
 */
export type QueueEntryStatus =
  | "queued"
  | "preparing_head"
  | "validating"
  | "merging"
  | "repair_requested"
  | "repair_in_progress"
  | "paused"
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
  repairAttempts: number;
  maxRepairAttempts: number;
  issueKey: string | null;
  worktreePath: string | null;
  enqueuedAt: string;
  updatedAt: string;
}

export type FailureClass =
  | "main_broken"
  | "flaky_or_infra"
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

export interface QueueRepairContext {
  queueEntryId: string;
  issueKey: string | null;
  prNumber: number;
  prHeadSha: string;
  baseSha: string;
  failureClass: "branch_local" | "integration_conflict";
  failedChecks: Array<{
    name: string;
    url?: string | undefined;
    conclusion: "failure" | "timed_out" | "cancelled";
  }>;
  baselineChecksOnMain: Array<{
    name: string;
    conclusion: "success" | "failure";
  }>;
  isolatedDiffSummary?: string | undefined;
  compoundDiffSummary?: string | undefined;
  queuePosition: number;
  aheadPrNumbers: number[];
  behindPrNumbers: number[];
  priorAttempts: Array<{
    at: string;
    kind: "ci_repair" | "queue_repair";
    summary?: string | undefined;
    outcome: "failed" | "succeeded" | "abandoned";
  }>;
  attemptBudget: {
    current: number;
    max: number;
  };
}

export interface RepairRequestRecord {
  id: string;
  entryId: string;
  at: string;
  kind: "ci_repair" | "queue_repair";
  failureClass: FailureClass;
  summary?: string | undefined;
  outcome: "pending" | "failed" | "succeeded" | "abandoned";
}

export interface QueueEventRecord {
  id?: number | undefined;
  entryId: string;
  at: string;
  fromStatus: QueueEntryStatus | null;
  toStatus: QueueEntryStatus;
  detail?: string | undefined;
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
  maxRepairAttempts: number;
  flakyRetries: number;
  pollIntervalMs: number;
  requiredChecks: string[];
}
