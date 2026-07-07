import type { NormalizedGitHubEvent } from "./github-types.ts";
import { buildRequestedChangesWorkflowIdentity } from "./reactive-workflow-keys.ts";
import type { RunContext } from "./run-context.ts";

type FetchLike = typeof fetch;

interface GitHubReviewThreadComment {
  id: number;
  body: string;
  path?: string | undefined;
  line?: number | undefined;
  side?: string | undefined;
  startLine?: number | undefined;
  startSide?: string | undefined;
  commitId?: string | undefined;
  url?: string | undefined;
  diffHunk?: string | undefined;
  authorLogin?: string | undefined;
}

export interface GitHubRequestedChangesContext {
  context: RunContext;
  dedupeKey: string;
}

export async function resolveGitHubRequestedChangesContext(params: {
  linearIssueId: string;
  event: NormalizedGitHubEvent;
  fetchImpl: FetchLike;
  includeInlineComments?: boolean | undefined;
}): Promise<GitHubRequestedChangesContext> {
  const { linearIssueId, event, fetchImpl } = params;
  const reviewComments = params.includeInlineComments === false
    ? undefined
    : await fetchReviewCommentsForEvent(event, fetchImpl);
  const identity = buildRequestedChangesWorkflowIdentity({
    linearIssueId,
    headSha: event.headSha,
    reviewCommitId: event.reviewCommitId,
    reviewId: event.reviewId,
    reviewerName: event.reviewerName,
  });
  return {
    dedupeKey: identity.dedupeKey,
    context: {
      requestedChangesCoalesceKey: identity.coalesceKey,
      ...(identity.headSha ? { requestedChangesHeadSha: identity.headSha } : {}),
      reviewBody: event.reviewBody,
      reviewCommitId: event.reviewCommitId,
      reviewId: event.reviewId,
      reviewUrl: buildGitHubReviewUrl(event.repoFullName, event.prNumber, event.reviewId),
      reviewerName: event.reviewerName,
      ...(reviewComments && reviewComments.length > 0 ? { reviewComments } : {}),
    } satisfies RunContext,
  };
}

async function fetchReviewCommentsForEvent(
  event: NormalizedGitHubEvent,
  fetchImpl: FetchLike,
): Promise<GitHubReviewThreadComment[] | undefined> {
  if (event.triggerEvent !== "review_changes_requested") {
    return undefined;
  }
  if (!event.repoFullName || event.prNumber === undefined || event.reviewId === undefined) {
    return undefined;
  }

  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (!token) {
    return undefined;
  }

  const [owner, repo] = event.repoFullName.split("/", 2);
  if (!owner || !repo) {
    return undefined;
  }

  const response = await fetchImpl(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${event.prNumber}/reviews/${event.reviewId}/comments?per_page=100`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "patchrelay",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );
  if (!response.ok) {
    throw new Error(`GitHub review comment fetch failed (${response.status})`);
  }

  const payload = await response.json() as unknown;
  if (!Array.isArray(payload)) {
    return undefined;
  }

  const comments: GitHubReviewThreadComment[] = [];
  for (const entry of payload) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const body = typeof record.body === "string" ? record.body.trim() : "";
    const id = typeof record.id === "number" ? record.id : undefined;
    if (!body || id === undefined) continue;
    comments.push({
      id,
      body,
      ...(typeof record.path === "string" ? { path: record.path } : {}),
      ...(typeof record.line === "number" ? { line: record.line } : {}),
      ...(typeof record.side === "string" ? { side: record.side } : {}),
      ...(typeof record.start_line === "number" ? { startLine: record.start_line } : {}),
      ...(typeof record.start_side === "string" ? { startSide: record.start_side } : {}),
      ...(typeof record.commit_id === "string" ? { commitId: record.commit_id } : {}),
      ...(typeof record.html_url === "string" ? { url: record.html_url } : {}),
      ...(typeof record.diff_hunk === "string" ? { diffHunk: record.diff_hunk } : {}),
      ...(typeof (record.user as Record<string, unknown> | undefined)?.login === "string"
        ? { authorLogin: String((record.user as Record<string, unknown>).login) }
        : {}),
    });
  }

  return comments;
}

function buildGitHubReviewUrl(
  repoFullName: string | undefined,
  prNumber: number | undefined,
  reviewId: number | undefined,
): string | undefined {
  if (!repoFullName || prNumber === undefined || reviewId === undefined) {
    return undefined;
  }
  return `https://github.com/${repoFullName}/pull/${prNumber}#pullrequestreview-${reviewId}`;
}
