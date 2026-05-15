import type { GitHubStatusRollupEntry } from "../../github-rollup.ts";
import type { CommandRunner, CommandRunnerResult } from "../command-types.ts";
import { safeJsonParse } from "./shared.ts";

export interface GitHubPullRequestSnapshot {
  state?: string | undefined;
  reviewDecision?: string | undefined;
  mergeable?: string | undefined;
  mergeStateStatus?: string | undefined;
  headRefOid?: string | undefined;
  reviewRequests?: unknown[] | undefined;
  latestReviews?: unknown[] | undefined;
  statusCheckRollup?: GitHubStatusRollupEntry[] | undefined;
}

export type GitHubPullRequestProbeResult =
  | { ok: true; pr: GitHubPullRequestSnapshot }
  | { ok: false; error: string };

export async function probeGitHubPullRequest(
  runCommand: CommandRunner,
  repoFullName: string,
  prNumber: number,
): Promise<GitHubPullRequestProbeResult> {
  let result: CommandRunnerResult;
  try {
    result = await runCommand("gh", [
      "pr",
      "view",
      String(prNumber),
      "--repo",
      repoFullName,
      "--json",
      "state,reviewDecision,reviewRequests,latestReviews,statusCheckRollup,mergeable,mergeStateStatus,headRefOid",
    ]);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }

  if (result.exitCode !== 0) {
    return {
      ok: false,
      error: [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join(" ") || `gh exited ${result.exitCode}`,
    };
  }

  const parsed = safeJsonParse(result.stdout);
  if (!parsed) {
    return { ok: false, error: "invalid JSON from gh pr view" };
  }

  return { ok: true, pr: parsed as GitHubPullRequestSnapshot };
}

export function extractLatestBlockingReviewHeadSha(latestReviews: unknown[] | undefined): string | undefined {
  if (!Array.isArray(latestReviews)) {
    return undefined;
  }
  for (const review of latestReviews) {
    if (!review || typeof review !== "object") continue;
    const state = typeof (review as { state?: unknown }).state === "string"
      ? String((review as { state: string }).state).trim().toUpperCase()
      : undefined;
    if (state !== "CHANGES_REQUESTED") continue;
    const commitOid = typeof (review as { commit?: { oid?: unknown } }).commit?.oid === "string"
      ? String((review as { commit: { oid: string } }).commit.oid).trim()
      : undefined;
    if (commitOid) return commitOid;
  }
  return undefined;
}

export function extractRequestedReviewerLogins(requests: unknown[] | undefined): string[] {
  if (!Array.isArray(requests)) {
    return [];
  }
  const logins = requests.flatMap((request) => {
    if (!request || typeof request !== "object") {
      return [];
    }
    const direct = typeof (request as { login?: unknown }).login === "string"
      ? String((request as { login: string }).login)
      : undefined;
    const nested = typeof (request as { requestedReviewer?: { login?: unknown } }).requestedReviewer?.login === "string"
      ? String((request as { requestedReviewer: { login: string } }).requestedReviewer.login)
      : undefined;
    return [direct, nested].filter((entry): entry is string => Boolean(entry)).map((entry) => entry.trim().toLowerCase());
  });
  return [...new Set(logins)];
}
