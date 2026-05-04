import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ensureRepoCache } from "./cache.ts";
import {
  gitCheckoutDetached,
  gitFetchReviewRefs,
  gitWorktreeAddDetached,
  gitWorktreeRemove,
} from "./git.ts";
import type { PullRequestSummary, ReviewWorkspace } from "../types.ts";

// `baseRefName` from GitHub names the PR's actual base ref. For a stacked
// PR this is another PR's branch; for a normal PR it's the repo default.
// We compare against the configured `baseBranch` so callers can tell —
// the call site decides whether to refuse carry-forward (today's v1
// behavior) or fetch the parent ref and use that as the diff base
// (deferred — see plan §3.2).
function isStackedPullRequest(pr: PullRequestSummary, repoBaseBranch: string): boolean {
  return pr.baseRefName !== "" && pr.baseRefName !== repoBaseBranch;
}

export async function materializeReviewWorkspace(params: {
  repoFullName: string;
  baseBranch: string;
  pr: PullRequestSummary;
  token: string;
}): Promise<{ workspace: ReviewWorkspace; dispose: () => Promise<void> }> {
  const cachePath = await ensureRepoCache(params.repoFullName, params.token);
  await gitFetchReviewRefs(cachePath, params.baseBranch, params.pr.number, params.token);
  const worktreePath = await mkdtemp(path.join(tmpdir(), "review-quill-"));
  const headRef = `refs/remotes/pull/${params.pr.number}/head`;
  const baseRef = `refs/remotes/origin/${params.baseBranch}`;
  await gitWorktreeAddDetached(cachePath, worktreePath, headRef);
  await gitCheckoutDetached(worktreePath, params.pr.headSha);

  const workspace: ReviewWorkspace = {
    repoFullName: params.repoFullName,
    cachePath,
    worktreePath,
    baseRef,
    headRef,
    headSha: params.pr.headSha,
  };

  return {
    workspace,
    dispose: async () => {
      await gitWorktreeRemove(cachePath, worktreePath).catch(() => undefined);
      await rm(worktreePath, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

export { isStackedPullRequest };
