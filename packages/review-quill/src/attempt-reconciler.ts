import type { Logger } from "pino";
import { describeAttemptState, isAttemptActive } from "./attempt-state.ts";
import type { GitHubClient } from "./github-client.ts";
import { findStaleDecisiveReviews } from "./review-publication-policy.ts";
import type { SqliteStore } from "./db/sqlite-store.ts";
import type {
  PullRequestReviewRecord,
  ReviewAttemptRecord,
  ReviewQuillConfig,
  ReviewQuillRepositoryConfig,
} from "./types.ts";

export interface AttemptReconcilerDeps {
  store: SqliteStore;
  github: GitHubClient;
  logger: Logger;
  config: ReviewQuillConfig;
  serviceStartedAt: string;
  reviewerLogin?: string | undefined;
}

interface RetireParams {
  status: "failed" | "cancelled" | "superseded";
  conclusion: "error" | "skipped";
  checkConclusion: "neutral" | "cancelled";
  summary: string;
}

/**
 * Owns the bookkeeping that retires review attempts when the world has moved
 * past them: PR closed/merged, head superseded, or attempt stalled. Pulled
 * out of the service so the service can focus on lifecycle + discovery +
 * execution, and so this cluster can be unit-tested with explicit fakes.
 */
export class AttemptReconciler {
  constructor(private readonly deps: AttemptReconcilerDeps) {}

  async retireAttempt(
    repo: ReviewQuillRepositoryConfig,
    attempt: ReviewAttemptRecord,
    params: RetireParams,
  ): Promise<void> {
    const { store, github, config } = this.deps;
    const detailsUrl = config.server.publicBaseUrl
      ? `${config.server.publicBaseUrl.replace(/\/$/, "")}/attempts/${attempt.id}`
      : undefined;
    store.updateAttempt(attempt.id, {
      status: params.status,
      conclusion: params.conclusion,
      summary: params.summary,
      completedAt: new Date().toISOString(),
    });
    if (attempt.externalCheckRunId === undefined) return;
    await github.updateCheckRun(repo.repoFullName, attempt.externalCheckRunId, {
      status: "completed",
      conclusion: params.checkConclusion,
      summary: params.summary,
      text: params.summary,
      ...(detailsUrl ? { detailsUrl } : {}),
    }).catch(() => undefined);
  }

  async reconcileClosedPullRequestAttempts(
    repo: ReviewQuillRepositoryConfig,
    openPullRequests: Awaited<ReturnType<GitHubClient["listOpenPullRequests"]>>,
  ): Promise<void> {
    const { store, github, logger } = this.deps;
    const openPullRequestNumbers = new Set(openPullRequests.map((pr) => pr.number));
    const activeAttempts = store.listActiveAttemptsForRepo(repo.repoFullName, 50);
    for (const attempt of activeAttempts) {
      if (openPullRequestNumbers.has(attempt.prNumber)) {
        continue;
      }

      let pr: Awaited<ReturnType<GitHubClient["getPullRequest"]>>;
      try {
        pr = await github.getPullRequest(repo.repoFullName, attempt.prNumber);
      } catch (error) {
        logger.warn({
          repo: repo.repoFullName,
          prNumber: attempt.prNumber,
          attemptId: attempt.id,
          error: error instanceof Error ? error.message : String(error),
        }, "Could not inspect non-open pull request while recovering active attempt");
        continue;
      }

      if (pr.state === "OPEN") {
        continue;
      }

      if (pr.headSha !== attempt.headSha) {
        await this.retireAttempt(repo, attempt, {
          status: "superseded",
          conclusion: "skipped",
          checkConclusion: "cancelled",
          summary: `Superseded by newer head ${pr.headSha.slice(0, 12)} before review finished.`,
        });
        continue;
      }

      const closure = pr.mergedAt ? "merged" : "closed";
      await this.retireAttempt(repo, attempt, {
        status: "cancelled",
        conclusion: "skipped",
        checkConclusion: "cancelled",
        summary: `Pull request was ${closure} before the review attempt finished.`,
      });
      logger.warn({
        repo: repo.repoFullName,
        prNumber: attempt.prNumber,
        attemptId: attempt.id,
        headSha: attempt.headSha,
        closure,
      }, "Recovered stranded review attempt for a non-open pull request");
    }
  }

  async reconcileActiveAttemptsForPullRequest(
    repo: ReviewQuillRepositoryConfig,
    pr: Awaited<ReturnType<GitHubClient["listOpenPullRequests"]>>[number],
  ): Promise<void> {
    const { store, logger, config, serviceStartedAt } = this.deps;
    const attempts = store.listAttemptsForPullRequest(repo.repoFullName, pr.number, 20);
    for (const attempt of attempts) {
      if (!isAttemptActive(attempt)) continue;
      if (attempt.headSha !== pr.headSha) {
        await this.retireAttempt(repo, attempt, {
          status: "superseded",
          conclusion: "skipped",
          checkConclusion: "cancelled",
          summary: `Superseded by newer head ${pr.headSha.slice(0, 12)} before review started.`,
        });
        continue;
      }
      const state = describeAttemptState(attempt, {
        serviceStartedAt,
        policy: {
          queuedAfterMs: config.reconciliation.staleQueuedAfterMs,
          runningAfterMs: config.reconciliation.staleRunningAfterMs,
        },
      });
      if (!state.stale) continue;
      const summary = `Marked stale and queued for retry. ${state.staleReason ?? "Attempt stopped making progress."}`;
      await this.retireAttempt(repo, attempt, {
        status: "failed",
        conclusion: "error",
        checkConclusion: "neutral",
        summary,
      });
      logger.warn({
        repo: repo.repoFullName,
        prNumber: pr.number,
        attemptId: attempt.id,
        headSha: attempt.headSha,
        staleReason: state.staleReason,
      }, "Recovered stale review attempt");
    }
  }

  async dismissStaleDecisiveReviews(
    repo: ReviewQuillRepositoryConfig,
    pr: Awaited<ReturnType<GitHubClient["listOpenPullRequests"]>>[number],
    reviews: PullRequestReviewRecord[],
  ): Promise<void> {
    const { github, logger, reviewerLogin } = this.deps;
    const staleReviews = findStaleDecisiveReviews({
      reviews,
      reviewerLogin,
      headSha: pr.headSha,
    });
    if (staleReviews.length === 0) return;

    const message = `Superseded by newer head ${pr.headSha.slice(0, 12)}; review-quill will re-review the latest commit separately.`;
    for (const review of staleReviews) {
      try {
        await github.dismissReview(repo.repoFullName, pr.number, review.id, message);
        logger.info({
          repo: repo.repoFullName,
          prNumber: pr.number,
          reviewId: review.id,
          dismissedReviewCommitId: review.commitId,
          currentHeadSha: pr.headSha,
          state: review.state,
        }, "Dismissed stale decisive review on superseded head");
      } catch (error) {
        const failure = error instanceof Error ? error.message : String(error);
        logger.warn({
          repo: repo.repoFullName,
          prNumber: pr.number,
          reviewId: review.id,
          dismissedReviewCommitId: review.commitId,
          currentHeadSha: pr.headSha,
          error: failure,
        }, "Failed to dismiss stale decisive review on superseded head");
      }
    }
  }
}
