import type { GitHubStatusRollupEntry } from "./github-rollup.ts";
import { execCommand } from "./utils.ts";

export interface ReconcilePullRequestSnapshot {
  headRefOid?: string;
  state?: string;
  reviewDecision?: string;
  mergeable?: string;
  mergeStateStatus?: string;
  statusCheckRollup?: GitHubStatusRollupEntry[];
}

export type ReconcilePullRequestFetchResult =
  | { ok: true; pr: ReconcilePullRequestSnapshot }
  | { ok: false; error: Error };

/**
 * Snapshots a PR via `gh pr view --json`, used during idle reconciliation
 * to verify local workflow facts against fresh GitHub truth before
 * dispatching repair runs.
 *
 * Caller is responsible for logging / acting on `ok: false`; this helper
 * never throws.
 */
export async function fetchPullRequestSnapshot(
  repoFullName: string,
  prNumber: number,
  options: { timeoutMs?: number } = {},
): Promise<ReconcilePullRequestFetchResult> {
  try {
    const { stdout } = await execCommand("gh", [
      "pr", "view", String(prNumber),
      "--repo", repoFullName,
      "--json", "headRefOid,state,reviewDecision,mergeable,mergeStateStatus,statusCheckRollup",
    ], { timeoutMs: options.timeoutMs ?? 10_000 });
    const pr = JSON.parse(stdout) as ReconcilePullRequestSnapshot;
    return { ok: true, pr };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error : new Error(String(error)) };
  }
}
