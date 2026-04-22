import { execCommand, safeJsonParse } from "./utils.ts";

export interface RemotePrReviewComment {
  body: string;
  path?: string;
  line?: number;
  side?: string;
  startLine?: number;
  startSide?: string;
  url?: string;
  authorLogin?: string;
}

export interface RemoteRequestedChangesReviewContext {
  reviewId?: number;
  reviewCommitId?: string;
  reviewUrl?: string;
  reviewerName?: string;
  reviewBody?: string;
  reviewComments?: RemotePrReviewComment[];
}

interface GitHubPullRequestReview {
  id?: number;
  state?: string;
  body?: string;
  commit_id?: string;
  html_url?: string;
  user?: { login?: string };
}

interface GitHubPullRequestReviewComment {
  body?: string;
  path?: string;
  line?: number;
  side?: string;
  start_line?: number;
  start_side?: string;
  html_url?: string;
  user?: { login?: string };
}

export async function readLatestRequestedChangesReviewContext(
  repoFullName: string,
  prNumber: number,
): Promise<RemoteRequestedChangesReviewContext | undefined> {
  const [owner, repo] = repoFullName.split("/", 2);
  if (!owner || !repo) {
    return undefined;
  }

  const reviewsResult = await execCommand("gh", [
    "api",
    `repos/${owner}/${repo}/pulls/${prNumber}/reviews?per_page=100`,
  ], { timeoutMs: 10_000 });
  if (reviewsResult.exitCode !== 0) {
    return undefined;
  }

  const reviews = safeJsonParse<GitHubPullRequestReview[]>(reviewsResult.stdout);
  if (!Array.isArray(reviews)) {
    return undefined;
  }

  const review = [...reviews].reverse().find((entry) => entry?.state?.trim().toUpperCase() === "CHANGES_REQUESTED");
  if (!review?.id) {
    return undefined;
  }

  const comments = await readReviewComments(owner, repo, prNumber, review.id);
  return {
    reviewId: review.id,
    ...(typeof review.commit_id === "string" && review.commit_id.trim() ? { reviewCommitId: review.commit_id.trim() } : {}),
    ...(typeof review.html_url === "string" && review.html_url.trim() ? { reviewUrl: review.html_url.trim() } : {}),
    ...(typeof review.body === "string" && review.body.trim() ? { reviewBody: review.body.trim() } : {}),
    ...(typeof review.user?.login === "string" && review.user.login.trim() ? { reviewerName: review.user.login.trim() } : {}),
    ...(comments.length > 0 ? { reviewComments: comments } : {}),
  };
}

async function readReviewComments(
  owner: string,
  repo: string,
  prNumber: number,
  reviewId: number,
): Promise<RemotePrReviewComment[]> {
  const commentsResult = await execCommand("gh", [
    "api",
    `repos/${owner}/${repo}/pulls/${prNumber}/reviews/${reviewId}/comments?per_page=100`,
  ], { timeoutMs: 10_000 });
  if (commentsResult.exitCode !== 0) {
    return [];
  }

  const comments = safeJsonParse<GitHubPullRequestReviewComment[]>(commentsResult.stdout);
  if (!Array.isArray(comments)) {
    return [];
  }

  return comments.flatMap((entry) => {
    const body = typeof entry.body === "string" ? entry.body.trim() : "";
    if (!body) {
      return [];
    }
    return [{
      body,
      ...(typeof entry.path === "string" ? { path: entry.path } : {}),
      ...(typeof entry.line === "number" ? { line: entry.line } : {}),
      ...(typeof entry.side === "string" ? { side: entry.side } : {}),
      ...(typeof entry.start_line === "number" ? { startLine: entry.start_line } : {}),
      ...(typeof entry.start_side === "string" ? { startSide: entry.start_side } : {}),
      ...(typeof entry.html_url === "string" ? { url: entry.html_url } : {}),
      ...(typeof entry.user?.login === "string" ? { authorLogin: entry.user.login } : {}),
    }];
  });
}
