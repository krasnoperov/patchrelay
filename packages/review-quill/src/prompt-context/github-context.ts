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

// After this many decisive reviews from our own login accumulate on a PR,
// the anchor-bias of carrying forward our own prior claims starts to harm
// review quality — the model reaffirms its own past rejections instead of
// re-engaging with the current head. Drop our own claims at that point and
// let the next round reach a verdict independently. Other authors' reviews
// (humans) still pass through.
const SELF_CLAIM_FRESH_START_THRESHOLD = 3;

function normalizeLogin(login: string | undefined): string | undefined {
  return login?.replace(/\[bot\]$/i, "").toLowerCase();
}

function isDecisive(state: string | undefined): boolean {
  return state === "CHANGES_REQUESTED" || state === "APPROVED";
}

export function buildPriorReviewClaims(
  priorReviews: PullRequestReviewRecord[],
  selfLogin?: string,
): PriorReviewClaim[] {
  const normalizedSelf = normalizeLogin(selfLogin);
  const selfDecisiveCount = normalizedSelf
    ? priorReviews.filter((r) => isDecisive(r.state) && normalizeLogin(r.authorLogin) === normalizedSelf).length
    : 0;
  const shouldDropSelfClaims = selfDecisiveCount >= SELF_CLAIM_FRESH_START_THRESHOLD;

  const filtered = shouldDropSelfClaims
    ? priorReviews.filter((r) => normalizeLogin(r.authorLogin) !== normalizedSelf)
    : priorReviews;

  const scored = filtered
    .map((review, index) => ({ review, index }))
    .filter(({ review }) => Boolean(summarizeReviewBody(review.body)))
    .sort((left, right) => {
      const leftDecisive = isDecisive(left.review.state);
      const rightDecisive = isDecisive(right.review.state);
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
  selfLogin?: string,
): Promise<{ priorReviewClaims: PriorReviewClaim[] }> {
  const priorReviews = await github.listPullRequestReviews(repoFullName, pr.number);
  return { priorReviewClaims: buildPriorReviewClaims(priorReviews, selfLogin) };
}
