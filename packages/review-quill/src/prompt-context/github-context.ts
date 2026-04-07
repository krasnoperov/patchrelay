import type { GitHubClient } from "../github-client.ts";
import type { PullRequestSummary, PullRequestReviewRecord } from "../types.ts";

export async function buildGitHubPromptContext(
  github: GitHubClient,
  repoFullName: string,
  pr: PullRequestSummary,
): Promise<{ priorReviews: PullRequestReviewRecord[] }> {
  const priorReviews = await github.listPullRequestReviews(repoFullName, pr.number);
  return { priorReviews };
}
