import type { CIStatus, CheckResult, MergeResult, PRStatus, RebaseResult } from "./types.ts";

/**
 * Git operations seam — swappable between real git (shell exec) and
 * isomorphic-git + memfs for testing.
 */
export interface GitOperations {
  fetch(remote?: string): Promise<void>;
  headSha(branch: string): Promise<string>;
  changedFiles(branch: string, base: string): Promise<string[]>;
  rebase(branch: string, onto: string): Promise<RebaseResult>;
  merge(source: string, into: string): Promise<MergeResult>;
  push(branch: string, force?: boolean): Promise<void>;
  createBranch(name: string, from: string): Promise<void>;
  deleteBranch(name: string): Promise<void>;
}

/**
 * CI runner seam — triggers and polls CI runs. Real implementation polls
 * GitHub Actions; test implementation is a deterministic oracle.
 */
export interface CIRunner {
  triggerRun(branch: string, sha: string): Promise<string>;
  getStatus(runId: string): Promise<CIStatus>;
  cancelRun(runId: string): Promise<void>;
}

/**
 * GitHub PR API seam — merge, status, and check queries. Real
 * implementation uses gh CLI or REST API; test implementation is in-memory.
 */
export interface GitHubPRApi {
  mergePR(prNumber: number, method: "squash" | "merge"): Promise<void>;
  getStatus(prNumber: number): Promise<PRStatus>;
  listChecks(prNumber: number): Promise<CheckResult[]>;
}

/**
 * Repair callback — the steward calls this to ask PatchRelay (or a stub)
 * to run a repair. The steward does not own agent execution.
 */
export interface RepairDispatcher {
  requestRepair(context: import("./types.ts").QueueRepairContext): Promise<void>;
  cancelRepair(queueEntryId: string): Promise<void>;
}
