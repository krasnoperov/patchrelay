import { execCommand } from "./utils.ts";
import type { GitHubStatusRollupEntry } from "./github-rollup.ts";

export interface RemotePrState {
  headRefOid?: string;
  headRefName?: string;
  url?: string;
  isDraft?: boolean;
  isCrossRepository?: boolean;
  mergeable?: string;
  state?: string;
  author?: { login?: string };
  reviewDecision?: string;
  mergeStateStatus?: string;
  statusCheckRollup?: GitHubStatusRollupEntry[];
}

export async function readRemotePrState(
  repoFullName: string,
  prNumber: number,
): Promise<RemotePrState | undefined> {
  const { stdout, exitCode } = await execCommand("gh", [
    "pr", "view", String(prNumber),
    "--repo", repoFullName,
    "--json", "url,headRefName,headRefOid,isDraft,isCrossRepository,state,author,reviewDecision,mergeable,mergeStateStatus,statusCheckRollup",
  ], { timeoutMs: 10_000 });
  if (exitCode !== 0) return undefined;
  return JSON.parse(stdout) as RemotePrState;
}
