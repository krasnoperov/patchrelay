import type { GitHubClient } from "../github-client.ts";
import type { PriorReviewClaim, PullRequestSummary, PullRequestReviewRecord } from "../types.ts";

function summarizeReviewBody(body: string | undefined): string | undefined {
  const normalized = body
    ?.split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) {
    return undefined;
  }
  return normalized.length <= 280 ? normalized : `${normalized.slice(0, 277)}...`;
}

function buildPriorReviewClaims(priorReviews: PullRequestReviewRecord[]): PriorReviewClaim[] {
  const scored = priorReviews
    .map((review, index) => ({ review, index }))
    .filter(({ review }) => Boolean(summarizeReviewBody(review.body)))
    .sort((left, right) => {
      const leftDecisive = left.review.state === "CHANGES_REQUESTED" || left.review.state === "APPROVED";
      const rightDecisive = right.review.state === "CHANGES_REQUESTED" || right.review.state === "APPROVED";
      if (leftDecisive !== rightDecisive) {
        return leftDecisive ? -1 : 1;
      }
      return right.index - left.index;
    })
    .slice(0, 3);

  return scored.flatMap(({ review }) => {
    const excerpt = summarizeReviewBody(review.body);
    if (!excerpt) {
      return [];
    }
    return [{
      ...(review.authorLogin ? { authorLogin: review.authorLogin } : {}),
      ...(review.state ? { state: review.state } : {}),
      ...(review.commitId ? { commitId: review.commitId } : {}),
      excerpt,
    }];
  });
}

export async function buildGitHubPromptContext(
  github: GitHubClient,
  repoFullName: string,
  pr: PullRequestSummary,
): Promise<{ priorReviewClaims: PriorReviewClaim[] }> {
  const priorReviews = await github.listPullRequestReviews(repoFullName, pr.number);
  return { priorReviewClaims: buildPriorReviewClaims(priorReviews) };
}
