import type { GitHubClient } from "../github-client.ts";
import type { PromptContext, PullRequestSummary, ReviewWorkspace } from "../types.ts";
import { buildGitHubPromptContext } from "./github-context.ts";
import { detectIssueKeys } from "./issue-keys.ts";
import { loadRepoGuidanceDocs } from "./repo-guidance.ts";

export async function buildPromptContext(
  github: GitHubClient,
  repoFullName: string,
  pr: PullRequestSummary,
  workspace: ReviewWorkspace,
  reviewDocs: string[],
): Promise<PromptContext> {
  const githubContext = await buildGitHubPromptContext(github, repoFullName, pr);
  const guidanceDocs = await loadRepoGuidanceDocs(workspace.worktreePath, reviewDocs);
  return {
    guidanceDocs,
    priorReviewClaims: githubContext.priorReviewClaims,
    issueKeys: detectIssueKeys(pr),
  };
}
