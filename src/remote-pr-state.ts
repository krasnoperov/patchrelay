import { execCommand } from "./utils.ts";

export interface RemotePrState {
  headRefOid?: string;
  state?: string;
  reviewDecision?: string;
  mergeStateStatus?: string;
}

export async function readRemotePrState(
  repoFullName: string,
  prNumber: number,
): Promise<RemotePrState | undefined> {
  const { stdout, exitCode } = await execCommand("gh", [
    "pr", "view", String(prNumber),
    "--repo", repoFullName,
    "--json", "headRefOid,state,reviewDecision,mergeStateStatus",
  ], { timeoutMs: 10_000 });
  if (exitCode !== 0) return undefined;
  return JSON.parse(stdout) as RemotePrState;
}
