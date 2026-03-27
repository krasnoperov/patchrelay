/**
 * Queue entry statuses — from design doc lifecycle.
 *
 * queued → waiting_head → preparing_head → validating → passed → merging → merged
 *
 * Failure paths:
 *   preparing_head → repair_requested
 *   validating     → repair_requested | evicted | paused
 */
export type QueueEntryStatus =
  | "queued"
  | "waiting_head"
  | "preparing_head"
  | "validating"
  | "passed"
  | "merging"
  | "repair_requested"
  | "repair_in_progress"
  | "paused"
  | "evicted"
  | "merged";

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
  ciRunId: string | null;
  ciRetries: number;
  repairAttempts: number;
  maxRepairAttempts: number;
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
  issueId: string;
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
