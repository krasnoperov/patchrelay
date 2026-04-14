import type { GitHubClient } from "../github-client.ts";
import type { PriorReviewClaim, PullRequestSummary, PullRequestReviewRecord } from "../types.ts";

// review-quill bodies can run ~1.5k chars; the verdict sentence (which names
// the actual blocker) lives at the very end. 280 chars clipped before it
// could be seen, which let consecutive rounds contradict each other because
// each round only ever saw the prior round's *intro* as context.
const PRIOR_REVIEW_EXCERPT_LIMIT = 1500;
const VERDICT_LINE_REGEX = /\*\*Verdict:[^\n]*/;

function extractVerdictLine(body: string): string | undefined {
  const match = body.match(VERDICT_LINE_REGEX);
  if (!match) {
    return undefined;
  }
  return match[0].replace(/\s+/g, " ").trim();
}

export function summarizeReviewBody(body: string | undefined): string | undefined {
  if (!body) {
    return undefined;
  }
  const normalized = body
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) {
    return undefined;
  }
  if (normalized.length <= PRIOR_REVIEW_EXCERPT_LIMIT) {
    return normalized;
  }

  const verdictLine = extractVerdictLine(body);
  if (!verdictLine) {
    return `${normalized.slice(0, PRIOR_REVIEW_EXCERPT_LIMIT - 3)}...`;
  }

  // Reserve room for the verdict line and a separator so the blocker survives
  // truncation even if the main prose runs long.
  const separator = " ... ";
  const prefixBudget = Math.max(0, PRIOR_REVIEW_EXCERPT_LIMIT - verdictLine.length - separator.length);
  const prefix = normalized.slice(0, prefixBudget).trim();
  if (!prefix) {
    return verdictLine;
  }
  return `${prefix}${separator}${verdictLine}`;
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
