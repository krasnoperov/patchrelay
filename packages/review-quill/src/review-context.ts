import type { Logger } from "pino";
import type { GitHubClient } from "./github-client.ts";
import type { PullRequestSummary, ReviewContext, ReviewQuillRepositoryConfig } from "./types.ts";
import { loadReviewQuillRepoPrompting } from "./customization.ts";
import { buildDiffContext } from "./diff-context/index.ts";
import { buildPromptContext } from "./prompt-context/index.ts";
import { renderReviewPrompt } from "./prompt-builder/index.ts";
import { findDisallowedReviewPromptSectionIds, findUnknownReviewPromptSectionIds } from "./prompt-builder/render.ts";
import { materializeReviewWorkspaceWithMode } from "./review-workspace/index.ts";
import { resolveReviewSurfaceMode } from "./carry-forward.ts";

export class CannotIntegrateError extends Error {
  readonly headSha: string;
  readonly baseSha: string;
  constructor(headSha: string, baseSha: string) {
    super(`Cannot integrate PR head ${headSha.slice(0, 8)} with base ${baseSha.slice(0, 8)} — merge-tree conflict`);
    this.name = "CannotIntegrateError";
    this.headSha = headSha;
    this.baseSha = baseSha;
  }
}

export async function resolvePromptPullRequest(params: {
  github: GitHubClient;
  repoFullName: string;
  pr: PullRequestSummary;
}): Promise<PullRequestSummary> {
  const latestPr = await params.github.getPullRequest(params.repoFullName, params.pr.number);
  // Keep the reconcile-selected head stable. We only refresh the mutable PR
  // description/title when GitHub still points at the same commit.
  if (latestPr.headSha !== params.pr.headSha) {
    return params.pr;
  }
  return {
    ...params.pr,
    ...latestPr,
  };
}

function mergePromptCustomization(
  base: ReviewContext["promptCustomization"],
  override: ReviewContext["promptCustomization"] | undefined,
): ReviewContext["promptCustomization"] {
  return {
    ...(override?.extraInstructions
      ? { extraInstructions: override.extraInstructions }
      : base.extraInstructions
      ? { extraInstructions: base.extraInstructions }
      : {}),
    replaceSections: {
      ...base.replaceSections,
      ...(override?.replaceSections ?? {}),
    },
  };
}

export async function buildReviewContext(params: {
  github: GitHubClient;
  repo: ReviewQuillRepositoryConfig;
  pr: PullRequestSummary;
  prompting: ReviewContext["promptCustomization"];
  logger: Logger;
  selfLogin: string | undefined;
}): Promise<{ context: ReviewContext; dispose: () => Promise<void> }> {
  const token = params.github.currentTokenForRepo(params.repo.repoFullName);
  if (!token) {
    throw new Error(`No GitHub installation token available for ${params.repo.repoFullName}`);
  }

  const materialized = await materializeReviewWorkspaceWithMode({
    repoFullName: params.repo.repoFullName,
    baseBranch: params.repo.baseBranch,
    pr: params.pr,
    token,
    surfaceMode: resolveReviewSurfaceMode(params.repo),
  });
  if (materialized.kind === "cannot_integrate") {
    throw new CannotIntegrateError(materialized.headSha, materialized.baseSha);
  }

  try {
    const promptPr = await resolvePromptPullRequest({
      github: params.github,
      repoFullName: params.repo.repoFullName,
      pr: params.pr,
    });
    const diff = await buildDiffContext(params.repo, materialized.workspace);
    const promptContext = await buildPromptContext(
      params.github,
      params.repo.repoFullName,
      promptPr,
      materialized.workspace,
      params.repo.reviewDocs,
      params.selfLogin,
    );
    const repoPromptCustomization = loadReviewQuillRepoPrompting({
      repoRoot: materialized.workspace.worktreePath,
      logger: params.logger,
    });
    const baseContext = {
      workspaceMode: "checkout" as const,
      workspace: materialized.workspace,
      repo: params.repo,
      pr: promptPr,
      diff,
      promptCustomization: mergePromptCustomization(params.prompting, repoPromptCustomization),
      promptContext,
    };
    const unknownPromptSections = findUnknownReviewPromptSectionIds(baseContext.promptCustomization.replaceSections);
    if (unknownPromptSections.length > 0) {
      params.logger.warn(
        { repo: params.repo.repoFullName, prNumber: params.pr.number, unknownPromptSections },
        "Review Quill prompt customization references unknown section ids",
      );
    }
    const disallowedPromptSections = findDisallowedReviewPromptSectionIds(baseContext.promptCustomization.replaceSections);
    if (disallowedPromptSections.length > 0) {
      params.logger.warn(
        { repo: params.repo.repoFullName, prNumber: params.pr.number, disallowedPromptSections },
        "Review Quill prompt customization attempted to replace non-overridable sections",
      );
    }
    return {
      context: {
        ...baseContext,
        prompt: renderReviewPrompt(baseContext),
      },
      dispose: materialized.dispose,
    };
  } catch (error) {
    await materialized.dispose();
    throw error;
  }
}
