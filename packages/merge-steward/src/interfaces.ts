import type { CIStatus, CheckResult, IncidentRecord, PRStatus, QueueEntry, RebaseResult } from "./types.ts";

/**
 * Git operations needed by the reconciler. The sim (GitSim) implements
 * additional methods for test harness setup, but the reconciler only uses these.
 */
export interface GitOperations {
  fetch(remote?: string): Promise<void>;
  headSha(branch: string): Promise<string>;
  rebase(branch: string, onto: string): Promise<RebaseResult>;
  push(branch: string, force?: boolean): Promise<void>;
}

/**
 * CI runner seam — triggers and polls CI runs. Real implementation polls
 * GitHub Actions; test implementation is a deterministic oracle.
 */
export interface CIRunner {
  triggerRun(branch: string, sha: string): Promise<string>;
  getStatus(runId: string): Promise<CIStatus>;
  cancelRun(runId: string): Promise<void>;
  /** Optional: check if the base branch CI is green. */
  getMainStatus?(baseBranch: string): Promise<CIStatus>;
}

/**
 * GitHub PR API seam — merge, status, and check queries. Real
 * implementation uses gh CLI or REST API; test implementation is in-memory.
 */
export interface GitHubPRApi {
  mergePR(prNumber: number, method: "squash" | "merge"): Promise<void>;
  getStatus(prNumber: number): Promise<PRStatus>;
  listChecks(prNumber: number): Promise<CheckResult[]>;
  listLabels(prNumber: number): Promise<string[]>;
}

/**
 * Reports evictions to external systems. The production implementation
 * creates a GitHub check run; the sim records evictions for test assertion.
 * The incident record is the source of truth; the check run is a projection.
 */
export interface EvictionReporter {
  reportEviction(entry: QueueEntry, incident: IncidentRecord): Promise<void>;
}
