import type { Logger } from "pino";
import type { GitHubClient } from "./github-client.ts";
import type { ReviewSubmitEvent } from "./review-artifact-renderer.ts";

export interface SubmitReviewParams {
  github: GitHubClient;
  logger: Logger;
  repoFullName: string;
  prNumber: number;
  headSha: string;
  event: ReviewSubmitEvent;
  primaryBody: string;
  inlineComments: Array<{ path: string; line: number; side: "RIGHT"; body: string }>;
  /**
   * Renders the body to post on 422 retry, where inline comments have to be
   * folded into the body markdown. Only called if the primary POST fails
   * with an Unprocessable Entity AND there were inline comments to drop.
   */
  buildFallbackBody: () => string;
}

/**
 * Posts a PR review atomically (body + inline comments + verdict). If GitHub
 * rejects the whole POST with 422 (typically because at least one inline
 * comment anchors to a path/line that isn't in the diff) AND we had inline
 * comments to drop, retries body-only with findings folded into the body
 * markdown so the verdict still lands.
 *
 * Returns the body that was actually posted — callers should persist this on
 * the attempt row so the stored review matches what's visible on GitHub.
 */
export async function submitReviewWithFallback(params: SubmitReviewParams): Promise<string> {
  try {
    await params.github.submitReview(params.repoFullName, params.prNumber, {
      event: params.event,
      body: params.primaryBody,
      commitId: params.headSha,
      ...(params.inlineComments.length > 0 ? { comments: params.inlineComments } : {}),
    });
    return params.primaryBody;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const isUnprocessableEntity = /^GitHub API 422\b/.test(message);
    if (!isUnprocessableEntity || params.inlineComments.length === 0) {
      throw error;
    }
    const fallbackBody = params.buildFallbackBody();
    params.logger.warn({
      repo: params.repoFullName,
      prNumber: params.prNumber,
      headSha: params.headSha,
      droppedInlineComments: params.inlineComments.length,
      githubError: message.slice(0, 500),
    }, "GitHub rejected review with inline comments (422); retrying body-only with findings folded into body");
    await params.github.submitReview(params.repoFullName, params.prNumber, {
      event: params.event,
      body: fallbackBody,
      commitId: params.headSha,
    });
    return fallbackBody;
  }
}
