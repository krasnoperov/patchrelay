import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ensureRepoCache } from "./cache.ts";
import { withRepoCacheMutation } from "./cache-mutex.ts";
import {
  gitCheckoutDetached,
  gitFetchReviewRefs,
  gitFetchIntegrationRefs,
  gitMergeBase,
  gitWorktreeAddDetached,
  gitWorktreeRemove,
} from "./git.ts";
import type { PullRequestSummary, ReviewWorkspace } from "../types.ts";

export async function resolveReviewDiffBaseSha(
  worktreePath: string,
  pr: Pick<PullRequestSummary, "number" | "baseSha" | "headSha">,
): Promise<string> {
  if (!pr.baseSha.trim()) {
    throw new Error(`PR #${pr.number} has no GitHub-reported base SHA`);
  }
  return await gitMergeBase(worktreePath, pr.baseSha, pr.headSha);
}

export async function materializeIntegrationWorkspace(params: {
  repoFullName: string;
  candidateRef: string;
  candidateSha: string;
  approvedHeadSha: string;
  prospectiveBaseSha: string;
  prNumber: number;
  token: string;
}): Promise<{ workspace: ReviewWorkspace; dispose: () => Promise<void> }> {
  const cachePath = await ensureRepoCache(params.repoFullName, params.token);
  const worktreePath = await mkdtemp(path.join(tmpdir(), "review-quill-integration-"));
  const headRef = "refs/remotes/integration/candidate";
  try {
    await withRepoCacheMutation(cachePath, async () => {
      await gitFetchIntegrationRefs(cachePath, params.candidateRef, params.prNumber, params.token);
      await gitWorktreeAddDetached(cachePath, worktreePath, headRef);
    });
    await gitCheckoutDetached(worktreePath, params.candidateSha);
    const workspace: ReviewWorkspace = {
      repoFullName: params.repoFullName,
      cachePath,
      worktreePath,
      baseRef: params.prospectiveBaseSha,
      diffBaseRef: params.prospectiveBaseSha,
      headRef,
      headSha: params.candidateSha,
      prBaseSha: params.prospectiveBaseSha,
    };
    const dispose = async () => {
      await withRepoCacheMutation(cachePath, () => gitWorktreeRemove(cachePath, worktreePath)).catch(() => undefined);
      await rm(worktreePath, { recursive: true, force: true }).catch(() => undefined);
    };
    return { workspace, dispose };
  } catch (error) {
    await withRepoCacheMutation(cachePath, () => gitWorktreeRemove(cachePath, worktreePath)).catch(() => undefined);
    await rm(worktreePath, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

export async function materializeReviewWorkspace(params: {
  repoFullName: string;
  pr: PullRequestSummary;
  token: string;
}): Promise<{ workspace: ReviewWorkspace; dispose: () => Promise<void> }> {
  if (!params.pr.baseRefName.trim() || !params.pr.baseSha.trim()) {
    throw new Error(`PR #${params.pr.number} has no GitHub-reported base ref and SHA`);
  }

  const cachePath = await ensureRepoCache(params.repoFullName, params.token);
  const worktreePath = await mkdtemp(path.join(tmpdir(), "review-quill-"));
  const headRef = `refs/remotes/pull/${params.pr.number}/head`;

  try {
    await withRepoCacheMutation(cachePath, async () => {
      await gitFetchReviewRefs(cachePath, params.pr.baseRefName, params.pr.number, params.token);
      await gitWorktreeAddDetached(cachePath, worktreePath, headRef);
    });
    await gitCheckoutDetached(worktreePath, params.pr.headSha);

    // Capture GitHub's `base.sha` from the PR snapshot, resolve the merge-base
    // once, and use its immutable SHA for every diff operation so a concurrent
    // fetch cannot move the review underneath us.
    const diffBaseSha = await resolveReviewDiffBaseSha(worktreePath, params.pr);
    const workspace: ReviewWorkspace = {
      repoFullName: params.repoFullName,
      cachePath,
      worktreePath,
      baseRef: diffBaseSha,
      diffBaseRef: diffBaseSha,
      headRef,
      headSha: params.pr.headSha,
      prBaseSha: params.pr.baseSha,
    };

    const dispose = async () => {
      await withRepoCacheMutation(cachePath, () => gitWorktreeRemove(cachePath, worktreePath)).catch(() => undefined);
      await rm(worktreePath, { recursive: true, force: true }).catch(() => undefined);
    };

    return { workspace, dispose };
  } catch (error) {
    await withRepoCacheMutation(cachePath, () => gitWorktreeRemove(cachePath, worktreePath)).catch(() => undefined);
    await rm(worktreePath, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}
