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

  // Plan §5.3: optional identity/tree primitives. When present they
  // power the patch-id-aware updateHead short-circuit; when absent
  // the reconciler falls back to the standard rebuild path.
  /** Stable patch-id of head's diff against base. Returns undefined on git error. */
  patchIdAgainst?(base: string, headSha: string): Promise<string | undefined>;
  /** `git merge-tree --write-tree base headSha` — returns tree-id, or undefined on conflict/error. */
  integrationTreeId?(base: string, headSha: string): Promise<string | undefined>;
  /** Tree id of a commit (`commit^{tree}`). */
  treeId?(commitSha: string): Promise<string | undefined>;
  /** `git commit-tree tree -p p1 -p p2 -m message`. Returns the new commit SHA. */
  commitTree?(tree: string, parents: string[], message: string): Promise<string | undefined>;
  /** Force-push a known commit SHA to a branch (overrides the target ref directly). */
  pushCommit?(commitSha: string, branch: string): Promise<void>;
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
  /** List open PRs for restart-time eligibility scans. */
  listOpenPRs(): Promise<Array<{ number: number; branch: string; headSha: string }>>;
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
  /**
   * Plan §5.2: emit a "spec ready" check_run on the PR's head SHA when
   * a fresh spec branch has been pushed. Lets review-quill (and other
   * consumers) subscribe to integration-tree availability via the
   * GitHub bus instead of polling. Optional — implementations that
   * cannot or should not write this check (sim, in-memory, dry-run)
   * may omit or no-op.
   */
  reportSpecReady?(entry: QueueEntry, specBranch: string, specSha: string): Promise<void>;
}
