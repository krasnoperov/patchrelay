import type { GitHubClient } from "../github-client.ts";
import type {
  PriorReviewClaim,
  PullRequestConversationClaim,
  PullRequestConversationCommentRecord,
  PullRequestSummary,
  PullRequestReviewRecord,
} from "../types.ts";

// review-quill bodies can run ~1.5k chars; the verdict sentence (which names
// the actual blocker) lives at the very end. 280 chars clipped before it
// could be seen, which let consecutive rounds contradict each other because
// each round only ever saw the prior round's *intro* as context.
const PRIOR_REVIEW_EXCERPT_LIMIT = 1500;
export const RENDERED_CONVERSATION_CLAIM_LIMIT = 5;
const VERDICT_LINE_REGEX = /\*\*Verdict:[^\n]*/;

export function extractVerdictLine(body: string): string | undefined {
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
  if (verdictLine.length >= PRIOR_REVIEW_EXCERPT_LIMIT) {
    return verdictLine.slice(0, PRIOR_REVIEW_EXCERPT_LIMIT);
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

export function selectReviewVisibleConversationClaims(
  claims: PullRequestConversationClaim[],
): PullRequestConversationClaim[] {
  return claims.slice(-RENDERED_CONVERSATION_CLAIM_LIMIT);
}

function summarizePriorClaim(
  review: PullRequestReviewRecord,
  options?: { preferVerdictLineOnly?: boolean },
): string | undefined {
  if (!review.body) {
    return undefined;
  }
  if (options?.preferVerdictLineOnly) {
    return extractVerdictLine(review.body) ?? summarizeReviewBody(review.body);
  }
  return summarizeReviewBody(review.body);
}

// After this many decisive reviews from our own login accumulate on a PR,
// the anchor-bias of carrying forward our own prior claims starts to harm
// review quality — the model reaffirms its own past rejections instead of
// re-engaging with the current head. Drop our own claims at that point and
// let the next round reach a verdict independently. Other authors' reviews
// (humans) still pass through.
const SELF_CLAIM_FRESH_START_THRESHOLD = 3;

function normalizeLogin(login: string | undefined): string | undefined {
  const normalized = login?.trim().replace(/^app\//i, "").replace(/\[bot\]$/i, "").toLowerCase();
  return normalized || undefined;
}

const TRUSTED_AUTHOR_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

export function buildPullRequestConversationClaims(
  comments: PullRequestConversationCommentRecord[],
  prAuthorLogin: string | undefined,
): PullRequestConversationClaim[] {
  const normalizedPrAuthor = normalizeLogin(prAuthorLogin);
  return comments
    .flatMap((comment) => {
      const author = normalizeLogin(comment.authorLogin);
      const createdAtMs = comment.createdAt ? Date.parse(comment.createdAt) : Number.NaN;
      const excerpt = summarizeReviewBody(comment.body);
      const association = comment.authorAssociation?.toUpperCase();
      const isPrAuthor = Boolean(author && normalizedPrAuthor && author === normalizedPrAuthor);
      const isMaintainer = Boolean(association && TRUSTED_AUTHOR_ASSOCIATIONS.has(association));
      if ((!isPrAuthor && !isMaintainer) || !Number.isFinite(createdAtMs) || !excerpt) return [];
      return [{ comment, createdAtMs, excerpt }];
    })
    .sort((left, right) => right.createdAtMs - left.createdAtMs)
    .reverse()
    .map(({ comment, excerpt }) => ({
      ...(comment.authorLogin ? { authorLogin: comment.authorLogin } : {}),
      ...(comment.authorAssociation ? { authorAssociation: comment.authorAssociation } : {}),
      createdAt: comment.createdAt!,
      excerpt,
    }));
}

export function buildFollowUpHumanClaims(
  priorReviews: PullRequestReviewRecord[],
  selfLogin: string | undefined,
  priorAttemptCompletedAt: string | undefined,
): PriorReviewClaim[] {
  const normalizedSelf = normalizeLogin(selfLogin);
  const completedAtMs = priorAttemptCompletedAt ? Date.parse(priorAttemptCompletedAt) : Number.NaN;
  if (!normalizedSelf || !Number.isFinite(completedAtMs)) return [];

  return priorReviews
    .flatMap((review) => {
      const author = normalizeLogin(review.authorLogin);
      const isBotAuthor = /\[bot\]$/i.test(review.authorLogin?.trim() ?? "");
      const submittedAtMs = review.submittedAt ? Date.parse(review.submittedAt) : Number.NaN;
      const excerpt = summarizePriorClaim(review);
      if (isBotAuthor || !author || author === normalizedSelf || !Number.isFinite(submittedAtMs) || submittedAtMs <= completedAtMs || !excerpt) {
        return [];
      }
      return [{ review, submittedAtMs, excerpt }];
    })
    .sort((left, right) => {
      const leftDecisive = isDecisive(left.review.state);
      const rightDecisive = isDecisive(right.review.state);
      if (leftDecisive !== rightDecisive) return leftDecisive ? -1 : 1;
      return right.submittedAtMs - left.submittedAtMs;
    })
    .slice(0, 3)
    .map(({ review, excerpt }) => ({
      ...(review.authorLogin ? { authorLogin: review.authorLogin } : {}),
      ...(review.state ? { state: review.state } : {}),
      ...(review.commitId ? { commitId: review.commitId } : {}),
      excerpt,
    }));
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

  const selfClaims = normalizedSelf
    ? filtered
      .map((review, index) => ({ review, index }))
      .filter(({ review }) => normalizeLogin(review.authorLogin) === normalizedSelf)
      .sort((left, right) => {
        const leftDecisive = isDecisive(left.review.state);
        const rightDecisive = isDecisive(right.review.state);
        if (leftDecisive !== rightDecisive) {
          return leftDecisive ? -1 : 1;
        }
        return right.index - left.index;
      })
      .slice(0, 1)
      .flatMap(({ review }) => {
        const excerpt = summarizePriorClaim(review, { preferVerdictLineOnly: true });
        if (!excerpt) {
          return [];
        }
        return [{
          ...(review.authorLogin ? { authorLogin: review.authorLogin } : {}),
          ...(review.state ? { state: review.state } : {}),
          ...(review.commitId ? { commitId: review.commitId } : {}),
          excerpt,
        }];
      })
    : [];

  const scoredOthers = filtered
    .map((review, index) => ({ review, index }))
    .filter(({ review }) => normalizeLogin(review.authorLogin) !== normalizedSelf)
    .filter(({ review }) => Boolean(summarizePriorClaim(review)))
    .sort((left, right) => {
      const leftDecisive = isDecisive(left.review.state);
      const rightDecisive = isDecisive(right.review.state);
      if (leftDecisive !== rightDecisive) {
        return leftDecisive ? -1 : 1;
      }
      return right.index - left.index;
    })
    .slice(0, Math.max(0, 3 - selfClaims.length));

  const otherClaims = scoredOthers.flatMap(({ review }) => {
    const excerpt = summarizePriorClaim(review);
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

  return [...selfClaims, ...otherClaims];
}

export async function buildGitHubPromptContext(
  github: GitHubClient,
  repoFullName: string,
  pr: PullRequestSummary,
  selfLogin?: string,
  priorAttemptCompletedAt?: string,
): Promise<{
  conversationClaims: PullRequestConversationClaim[];
  priorReviewClaims: PriorReviewClaim[];
  followUpReviewClaims: PriorReviewClaim[];
}> {
  const [priorReviews, conversationComments] = await Promise.all([
    github.listPullRequestReviews(repoFullName, pr.number),
    github.listPullRequestConversationComments(repoFullName, pr.number),
  ]);
  return {
    conversationClaims: buildPullRequestConversationClaims(conversationComments, pr.authorLogin),
    priorReviewClaims: buildPriorReviewClaims(priorReviews, selfLogin),
    followUpReviewClaims: buildFollowUpHumanClaims(priorReviews, selfLogin, priorAttemptCompletedAt),
  };
}
