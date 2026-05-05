import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ensureRepoCache } from "./cache.ts";
import {
  gitCheckoutDetached,
  gitCommitTree,
  gitFetchReviewRefs,
  gitMergeBase,
  gitMergeTree,
  gitWorktreeAddDetached,
  gitWorktreeRemove,
} from "./git.ts";
import type { PullRequestSummary, ReviewSurfaceMode, ReviewWorkspace } from "../types.ts";

// `baseRefName` from GitHub names the PR's actual base ref. For a stacked
// PR this is another PR's branch; for a normal PR it's the repo default.
// We compare against the configured `baseBranch` so callers can tell —
// the call site decides whether to refuse carry-forward (today's v1
// behavior) or fetch the parent ref and use that as the diff base
// (deferred — see plan §3.2).
function isStackedPullRequest(pr: PullRequestSummary, repoBaseBranch: string): boolean {
  return pr.baseRefName !== "" && pr.baseRefName !== repoBaseBranch;
}

// Plan §3.4: result of materialization. `cannot_integrate` signals
// that the PR conflicts with the base in `git merge-tree --write-tree`
// — the reviewer cannot review what would land, so the service marks
// the attempt declined with that reason instead of proceeding.
export type MaterializeResult =
  | {
      kind: "ok";
      workspace: ReviewWorkspace;
      surfaceMode: ReviewSurfaceMode;
      // Populated only when surfaceMode === "integration_tree": the
      // tree id of the merged result, captured at materialization
      // time so the carry-forward cache key can include it without a
      // second probe.
      integrationTreeId?: string;
      dispose: () => Promise<void>;
    }
  | {
      kind: "cannot_integrate";
      headSha: string;
      baseSha: string;
    };

export async function materializeReviewWorkspace(params: {
  repoFullName: string;
  baseBranch: string;
  pr: PullRequestSummary;
  token: string;
  surfaceMode?: ReviewSurfaceMode;
}): Promise<{ workspace: ReviewWorkspace; dispose: () => Promise<void> }> {
  const result = await materializeReviewWorkspaceWithMode({ ...params });
  if (result.kind === "cannot_integrate") {
    throw new Error(
      `materializeReviewWorkspace: cannot integrate PR #${params.pr.number} into ${params.baseBranch} — head ${result.headSha.slice(0, 8)} conflicts with base ${result.baseSha.slice(0, 8)}`,
    );
  }
  return { workspace: result.workspace, dispose: result.dispose };
}

// Plan §3.4: mode-aware materialization. When `surfaceMode` is
// `integration_tree`, the worktree is checked out at a synthetic
// merge commit (`commit-tree <integration-tree> -p base -p head`) so
// the agent's file reads see what would actually land. Returns
// `cannot_integrate` on a real merge-tree conflict — the service
// turns that into a declined attempt without invoking the reviewer.
export async function materializeReviewWorkspaceWithMode(params: {
  repoFullName: string;
  baseBranch: string;
  pr: PullRequestSummary;
  token: string;
  surfaceMode?: ReviewSurfaceMode;
}): Promise<MaterializeResult> {
  const surfaceMode = params.surfaceMode ?? "head";
  const cachePath = await ensureRepoCache(params.repoFullName, params.token);
  await gitFetchReviewRefs(cachePath, params.baseBranch, params.pr.number, params.token);
  const worktreePath = await mkdtemp(path.join(tmpdir(), "review-quill-"));
  const headRef = `refs/remotes/pull/${params.pr.number}/head`;
  const baseRef = `refs/remotes/origin/${params.baseBranch}`;
  await gitWorktreeAddDetached(cachePath, worktreePath, headRef);
  await gitCheckoutDetached(worktreePath, params.pr.headSha);

  let workspaceHeadSha = params.pr.headSha;
  let integrationTreeId: string | undefined;

  if (surfaceMode === "integration_tree") {
    const baseSha = await gitMergeBase(worktreePath, baseRef, params.pr.headSha);
    const merge = await gitMergeTree(worktreePath, baseSha, params.pr.headSha);
    if (merge.conflict) {
      await gitWorktreeRemove(cachePath, worktreePath).catch(() => undefined);
      await rm(worktreePath, { recursive: true, force: true }).catch(() => undefined);
      return { kind: "cannot_integrate", headSha: params.pr.headSha, baseSha };
    }
    integrationTreeId = merge.treeId;
    const syntheticSha = await gitCommitTree(
      worktreePath,
      merge.treeId,
      [baseSha, params.pr.headSha],
      `synthetic integration of PR #${params.pr.number}`,
    );
    await gitCheckoutDetached(worktreePath, syntheticSha);
    workspaceHeadSha = syntheticSha;
  }

  const workspace: ReviewWorkspace = {
    repoFullName: params.repoFullName,
    cachePath,
    worktreePath,
    baseRef,
    headRef,
    headSha: workspaceHeadSha,
  };

  const dispose = async () => {
    await gitWorktreeRemove(cachePath, worktreePath).catch(() => undefined);
    await rm(worktreePath, { recursive: true, force: true }).catch(() => undefined);
  };

  return {
    kind: "ok",
    workspace,
    surfaceMode,
    ...(integrationTreeId ? { integrationTreeId } : {}),
    dispose,
  };
}

export { isStackedPullRequest };
