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
  selfLogin?: string,
  priorAttemptCompletedAt?: string,
): Promise<PromptContext> {
  const githubContext = await buildGitHubPromptContext(github, repoFullName, pr, selfLogin, priorAttemptCompletedAt);
  const guidanceDocs = await loadRepoGuidanceDocs(workspace.worktreePath, reviewDocs, [pr.title, pr.body ?? ""]);
  return {
    guidanceDocs,
    priorReviewClaims: githubContext.priorReviewClaims,
    followUpReviewClaims: githubContext.followUpReviewClaims,
    issueKeys: detectIssueKeys(pr),
  };
}
