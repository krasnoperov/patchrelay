import type { GitHubClient } from "./github-client.ts";
import type { PullRequestSummary, ReviewContext, ReviewQuillRepositoryConfig } from "./types.ts";
import { buildDiffContext } from "./diff-context/index.ts";
import { buildPromptContext } from "./prompt-context/index.ts";
import { renderReviewPrompt } from "./prompt-builder/index.ts";
import { materializeReviewWorkspace } from "./review-workspace/index.ts";

export async function buildReviewContext(params: {
  github: GitHubClient;
  repo: ReviewQuillRepositoryConfig;
  pr: PullRequestSummary;
}): Promise<{ context: ReviewContext; dispose: () => Promise<void> }> {
  const token = params.github.currentTokenForRepo(params.repo.repoFullName);
  if (!token) {
    throw new Error(`No GitHub installation token available for ${params.repo.repoFullName}`);
  }

  const materialized = await materializeReviewWorkspace({
    repoFullName: params.repo.repoFullName,
    baseBranch: params.repo.baseBranch,
    pr: params.pr,
    token,
  });

  try {
    const diff = await buildDiffContext(params.repo, materialized.workspace);
    const promptContext = await buildPromptContext(
      params.github,
      params.repo.repoFullName,
      params.pr,
      materialized.workspace,
      params.repo.reviewDocs,
    );
    const baseContext = {
      workspaceMode: "checkout" as const,
      workspace: materialized.workspace,
      repo: params.repo,
      pr: params.pr,
      diff,
      promptContext,
    };
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
