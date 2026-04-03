import type { CIStatus, CheckResult, IncidentRecord, MergeResult, PRStatus, QueueEntry } from "./types.ts";

/**
 * Git operations needed by the reconciler. The sim (GitSim) implements
 * additional methods for test harness setup, but the reconciler only uses these.
 */
export interface GitOperations {
  fetch(remote?: string): Promise<void>;
  headSha(branch: string): Promise<string>;
  isAncestor(ancestor: string, descendant: string): Promise<boolean>;
  push(branch: string, force?: boolean, targetBranch?: string): Promise<void>;
}

/**
 * Builds and manages speculative cumulative branches.
 * Separate from GitOperations to keep the core interface minimal.
 */
export interface SpeculativeBranchBuilder {
  /** Merge prBranch into baseBranch, store result as specName. */
  buildSpeculative(prBranch: string, baseBranch: string, specName: string, mergeMessage?: string): Promise<MergeResult>;
  /** Delete a speculative branch (cleanup after merge/eviction). */
  deleteSpeculative(specName: string): Promise<void>;
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
  mergePR(prNumber: number): Promise<void>;
  getStatus(prNumber: number): Promise<PRStatus>;
  listChecks(prNumber: number): Promise<CheckResult[]>;
  listChecksForRef(ref: string): Promise<CheckResult[]>;
  listLabels(prNumber: number): Promise<string[]>;
  /** Find the open PR number for a branch, or null if none exists. */
  findPRByBranch(branch: string): Promise<number | null>;
  /** Delete the PR's head branch from the remote (best-effort cleanup). */
  deleteBranch(prNumber: number): Promise<void>;
  /** List open PRs with a specific label (for startup scan). */
  listOpenPRsWithLabel(label: string): Promise<Array<{ number: number; branch: string; headSha: string }>>;
}

/**
 * Reports evictions to external systems. The production implementation
 * creates a GitHub check run; the sim records evictions for test assertion.
 * The incident record is the source of truth; the check run is a projection.
 */
export interface EvictionReporter {
  reportEviction(entry: QueueEntry, incident: IncidentRecord): Promise<void>;
}
