import type { Logger } from "pino";
import type {
  ReviewAttemptDetail,
  ReviewAttemptRecord,
  ReviewEligibility,
  ReviewQuillConfig,
  ReviewQuillRepositoryConfig,
  ReviewQuillRuntimeStatus,
  ReviewQuillWatchSnapshot,
} from "./types.ts";
import type { SqliteStore } from "./db/sqlite-store.ts";
import type { GitHubClient } from "./github-client.ts";
import type { ReviewRunner } from "./review-runner.ts";
import type { PullRequestReviewRecord } from "./types.ts";
import { decorateAttempt, describeAttemptState, isAttemptActive } from "./attempt-state.ts";
import { getLatestAttemptsByPullRequest } from "./attempt-summary.ts";
import { buildReviewContext } from "./review-context.ts";
import {
  buildInlineCommentBody,
  buildReviewBody,
  classifyPublicationDisposition,
  filterFindings,
  findStaleDecisiveReviews,
  hasMatchingLatestReviewForHead,
  REVIEW_FINDING_CONFIDENCE_THRESHOLD,
  REVIEW_MAX_INLINE_COMMENTS,
  resolveEvent,
} from "./review-publication-policy.ts";
import { evaluateReviewEligibility } from "./review-eligibility.ts";

export class ReviewQuillService {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private reconcileInProgress = false;
  private readonly startedAt = new Date().toISOString();
  private readonly runtime: ReviewQuillRuntimeStatus = {
    reconcileInProgress: false,
    lastReconcileStartedAt: null,
    lastReconcileCompletedAt: null,
    lastReconcileOutcome: "idle",
    lastReconcileError: null,
  };

  constructor(
    private readonly config: ReviewQuillConfig,
    private readonly store: SqliteStore,
    private readonly github: GitHubClient,
    private readonly runner: ReviewRunner,
    private readonly logger: Logger,
    private readonly reviewerLogin?: string,
  ) {}

  async start(): Promise<void> {
    await this.runner.start();
    await this.reconcileAll();
    this.schedule();
  }

  async stop(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.runner.stop();
  }

  listAttempts() {
    return this.store.listAttempts(100).map((attempt) => this.decorateAttempt(attempt));
  }

  async getAttemptDetail(attemptId: number): Promise<ReviewAttemptDetail | undefined> {
    const attempt = this.store.getAttemptById(attemptId);
    if (!attempt) return undefined;
    let currentPullRequest: ReviewAttemptDetail["currentPullRequest"];
    try {
      currentPullRequest = await this.github.getPullRequest(attempt.repoFullName, attempt.prNumber);
    } catch {
      currentPullRequest = undefined;
    }
    return {
      attempt: this.decorateAttempt(attempt),
      relatedAttempts: this.store
        .listAttemptsForPullRequest(attempt.repoFullName, attempt.prNumber, 10)
        .map((related) => this.decorateAttempt(related)),
      ...(currentPullRequest ? { currentPullRequest } : {}),
    };
  }

  getWatchSnapshot(): ReviewQuillWatchSnapshot {
    const attempts = this.store.listAttempts(60).map((attempt) => this.decorateAttempt(attempt));
    const latestAttempts = getLatestAttemptsByPullRequest(attempts);
    const recentWebhooks = this.store.listWebhooks(25);
    const repos = this.config.repositories.map((repo) => {
      const repoAttempts = latestAttempts.filter((attempt) => attempt.repoFullName === repo.repoFullName);
      const latestAttempt = repoAttempts[0];
      return {
        repoId: repo.repoId,
        repoFullName: repo.repoFullName,
        baseBranch: repo.baseBranch,
        totalAttempts: repoAttempts.length,
        queuedAttempts: repoAttempts.filter((attempt) => attempt.status === "queued").length,
        runningAttempts: repoAttempts.filter((attempt) => attempt.status === "running").length,
        completedAttempts: repoAttempts.filter((attempt) => attempt.status === "completed").length,
        failedAttempts: repoAttempts.filter((attempt) => attempt.status === "failed").length,
        latestAttemptAt: latestAttempt?.updatedAt ?? null,
        latestConclusion: latestAttempt?.conclusion ?? null,
      };
    });

    return {
      summary: {
        totalRepos: repos.length,
        totalAttempts: latestAttempts.length,
        queuedAttempts: latestAttempts.filter((attempt) => attempt.status === "queued").length,
        runningAttempts: latestAttempts.filter((attempt) => attempt.status === "running").length,
        completedAttempts: latestAttempts.filter((attempt) => attempt.status === "completed").length,
        failedAttempts: latestAttempts.filter((attempt) => attempt.status === "failed").length,
      },
      runtime: { ...this.runtime },
      repos,
      attempts,
      recentWebhooks,
    };
  }

  async triggerReconcile(repoFullName?: string): Promise<boolean> {
    if (this.reconcileInProgress) return false;
    await (repoFullName ? this.reconcileRepoByName(repoFullName) : this.reconcileAll());
    return true;
  }

  private schedule(): void {
    this.timer = setTimeout(() => {
      void this.reconcileAll().finally(() => this.schedule());
    }, this.config.reconciliation.pollIntervalMs);
    this.timer.unref?.();
  }

  private async reconcileAll(): Promise<void> {
    if (this.reconcileInProgress) return;
    this.reconcileInProgress = true;
    this.runtime.reconcileInProgress = true;
    this.runtime.lastReconcileStartedAt = new Date().toISOString();
    this.runtime.lastReconcileOutcome = "running";
    this.runtime.lastReconcileError = null;
    try {
      for (const repo of this.config.repositories) {
        await this.reconcileRepo(repo);
      }
      this.runtime.lastReconcileCompletedAt = new Date().toISOString();
      this.runtime.lastReconcileOutcome = "succeeded";
    } catch (error) {
      this.runtime.lastReconcileCompletedAt = new Date().toISOString();
      this.runtime.lastReconcileOutcome = "failed";
      this.runtime.lastReconcileError = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      this.reconcileInProgress = false;
      this.runtime.reconcileInProgress = false;
    }
  }

  private async reconcileRepoByName(repoFullName: string): Promise<void> {
    const repo = this.config.repositories.find((entry) => entry.repoFullName === repoFullName);
    if (!repo) return;
    if (this.reconcileInProgress) return;
    this.reconcileInProgress = true;
    this.runtime.reconcileInProgress = true;
    this.runtime.lastReconcileStartedAt = new Date().toISOString();
    this.runtime.lastReconcileOutcome = "running";
    this.runtime.lastReconcileError = null;
    try {
      await this.reconcileRepo(repo);
      this.runtime.lastReconcileCompletedAt = new Date().toISOString();
      this.runtime.lastReconcileOutcome = "succeeded";
    } catch (error) {
      this.runtime.lastReconcileCompletedAt = new Date().toISOString();
      this.runtime.lastReconcileOutcome = "failed";
      this.runtime.lastReconcileError = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      this.reconcileInProgress = false;
      this.runtime.reconcileInProgress = false;
    }
  }

  private async reconcileRepo(repo: ReviewQuillRepositoryConfig): Promise<void> {
    const prs = await this.github.listOpenPullRequests(repo.repoFullName);
    await this.reconcileClosedPullRequestAttempts(repo, prs);
    for (const pr of prs) {
      await this.reconcileActiveAttemptsForPullRequest(repo, pr);
      const currentReviews = await this.github.listPullRequestReviews(repo.repoFullName, pr.number);
      await this.dismissStaleDecisiveReviews(repo, pr, currentReviews);
      const existing = this.store.getAttempt(repo.repoFullName, pr.number, pr.headSha);
      const eligibility = await this.evaluateEligibility(repo, pr.number, pr.headSha, pr.isDraft, pr.headRefName);
      if (existing && !["failed", "cancelled", "superseded"].includes(existing.status)) {
        if (!eligibility.eligible) continue;
        continue;
      }
      if (!eligibility.eligible) continue;
      await this.executeReview(repo, pr, existing);
    }
  }

  private async reconcileClosedPullRequestAttempts(
    repo: ReviewQuillRepositoryConfig,
    openPullRequests: Awaited<ReturnType<GitHubClient["listOpenPullRequests"]>>,
  ): Promise<void> {
    const openPullRequestNumbers = new Set(openPullRequests.map((pr) => pr.number));
    const activeAttempts = this.store.listActiveAttemptsForRepo(repo.repoFullName, 50);
    for (const attempt of activeAttempts) {
      if (openPullRequestNumbers.has(attempt.prNumber)) {
        continue;
      }

      let pr: Awaited<ReturnType<GitHubClient["getPullRequest"]>>;
      try {
        pr = await this.github.getPullRequest(repo.repoFullName, attempt.prNumber);
      } catch (error) {
        this.logger.warn({
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
      this.logger.warn({
        repo: repo.repoFullName,
        prNumber: attempt.prNumber,
        attemptId: attempt.id,
        headSha: attempt.headSha,
        closure,
      }, "Recovered stranded review attempt for a non-open pull request");
    }
  }

  private async dismissStaleDecisiveReviews(
    repo: ReviewQuillRepositoryConfig,
    pr: Awaited<ReturnType<GitHubClient["listOpenPullRequests"]>>[number],
    reviews: PullRequestReviewRecord[],
  ): Promise<void> {
    const staleReviews = findStaleDecisiveReviews({
      reviews,
      reviewerLogin: this.reviewerLogin,
      headSha: pr.headSha,
    });
    if (staleReviews.length === 0) return;

    const message = `Superseded by newer head ${pr.headSha.slice(0, 12)}; review-quill will re-review the latest commit separately.`;
    for (const review of staleReviews) {
      try {
        await this.github.dismissReview(repo.repoFullName, pr.number, review.id, message);
        this.logger.info({
          repo: repo.repoFullName,
          prNumber: pr.number,
          reviewId: review.id,
          dismissedReviewCommitId: review.commitId,
          currentHeadSha: pr.headSha,
          state: review.state,
        }, "Dismissed stale decisive review on superseded head");
      } catch (error) {
        const failure = error instanceof Error ? error.message : String(error);
        this.logger.warn({
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

  private decorateAttempt(attempt: ReviewAttemptRecord): ReviewAttemptRecord {
    return decorateAttempt(attempt, {
      serviceStartedAt: this.startedAt,
      policy: {
        queuedAfterMs: this.config.reconciliation.staleQueuedAfterMs,
        runningAfterMs: this.config.reconciliation.staleRunningAfterMs,
      },
    });
  }

  private async reconcileActiveAttemptsForPullRequest(
    repo: ReviewQuillRepositoryConfig,
    pr: Awaited<ReturnType<GitHubClient["listOpenPullRequests"]>>[number],
  ): Promise<void> {
    const attempts = this.store.listAttemptsForPullRequest(repo.repoFullName, pr.number, 20);
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
        serviceStartedAt: this.startedAt,
        policy: {
          queuedAfterMs: this.config.reconciliation.staleQueuedAfterMs,
          runningAfterMs: this.config.reconciliation.staleRunningAfterMs,
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
      this.logger.warn({
        repo: repo.repoFullName,
        prNumber: pr.number,
        attemptId: attempt.id,
        headSha: attempt.headSha,
        staleReason: state.staleReason,
      }, "Recovered stale review attempt");
    }
  }

  private async retireAttempt(
    repo: ReviewQuillRepositoryConfig,
    attempt: ReviewAttemptRecord,
    params: {
      status: "failed" | "cancelled" | "superseded";
      conclusion: "error" | "skipped";
      checkConclusion: "neutral" | "cancelled";
      summary: string;
    },
  ): Promise<void> {
    const detailsUrl = this.config.server.publicBaseUrl
      ? `${this.config.server.publicBaseUrl.replace(/\/$/, "")}/attempts/${attempt.id}`
      : undefined;
    this.store.updateAttempt(attempt.id, {
      status: params.status,
      conclusion: params.conclusion,
      summary: params.summary,
      completedAt: new Date().toISOString(),
    });
    if (attempt.externalCheckRunId === undefined) return;
    await this.github.updateCheckRun(repo.repoFullName, attempt.externalCheckRunId, {
      status: "completed",
      conclusion: params.checkConclusion,
      summary: params.summary,
      text: params.summary,
      ...(detailsUrl ? { detailsUrl } : {}),
    }).catch(() => undefined);
  }

  private async evaluateEligibility(
    repo: ReviewQuillRepositoryConfig,
    prNumber: number,
    headSha: string,
    isDraft: boolean,
    branchName: string,
  ): Promise<ReviewEligibility> {
    return await evaluateReviewEligibility({
      repo,
      github: this.github,
      headSha,
      isDraft,
      branchName,
    });
  }

  private async executeReview(
    repo: ReviewQuillRepositoryConfig,
    pr: Awaited<ReturnType<GitHubClient["listOpenPullRequests"]>>[number],
    existingAttempt?: ReturnType<SqliteStore["getAttempt"]>,
  ): Promise<void> {
    const attempt = existingAttempt
      ? (this.store.updateAttempt(existingAttempt.id, {
        status: "queued",
        conclusion: null,
        summary: "Retrying previous failed review attempt",
        threadId: null,
        turnId: null,
        externalCheckRunId: null,
        completedAt: null,
      }) ?? existingAttempt)
      : this.store.createAttempt({
        repoFullName: repo.repoFullName,
        prNumber: pr.number,
        headSha: pr.headSha,
        status: "queued",
      });
    let heartbeat: ReturnType<typeof setInterval> | undefined;

    try {
      this.store.updateAttempt(attempt.id, {
        status: "running",
        externalCheckRunId: null,
      });
      heartbeat = setInterval(() => {
        this.store.updateAttempt(attempt.id, {});
      }, this.config.reconciliation.heartbeatIntervalMs);
      heartbeat.unref?.();

      const prepared = await buildReviewContext({
        github: this.github,
        repo,
        pr,
        prompting: this.config.prompting,
        logger: this.logger,
      });
      // Log diff packer stats so production reviews show the same
      // numbers the `review-quill diff --json` CLI exposes locally.
      // Useful for spotting drift in budget pressure / hallucinated paths
      // / pure-deletion files across many PRs without re-running the CLI.
      const reasons = prepared.context.diff.suppressed.reduce<Record<string, number>>((acc, entry) => {
        acc[entry.reason] = (acc[entry.reason] ?? 0) + 1;
        return acc;
      }, {});
      this.logger.info({
        repo: repo.repoFullName,
        prNumber: pr.number,
        headSha: pr.headSha,
        inventoryCount: prepared.context.diff.inventory.length,
        patchCount: prepared.context.diff.patches.length,
        suppressedCount: prepared.context.diff.suppressed.length,
        suppressedReasons: reasons,
        patchBodyBudgetTokens: repo.patchBodyBudgetTokens,
      }, "Diff packer stats");
      let result: Awaited<ReturnType<ReviewRunner["review"]>>;
      try {
        result = await this.runner.review(prepared.context);
      } finally {
        await prepared.dispose();
      }
      // Build the set of paths the model was actually allowed to comment
      // on. The diff inventory is the authoritative list — any finding
      // pointing outside it is a hallucinated path and gets dropped
      // before the GitHub POST so a single bad comment doesn't 422 the
      // whole review.
      const knownPaths = new Set(prepared.context.diff.inventory.map((entry) => entry.path));
      const filteredFindings = filterFindings(result.verdict.findings, knownPaths);
      const droppedTotal = result.verdict.findings.length - filteredFindings.length;
      if (droppedTotal > 0) {
        const droppedByPath = result.verdict.findings.filter((f) => !knownPaths.has(f.path)).length;
        const droppedByConfidence = droppedTotal - droppedByPath;
        this.logger.info({
          repo: repo.repoFullName,
          prNumber: pr.number,
          droppedByConfidence,
          droppedByPath,
          threshold: REVIEW_FINDING_CONFIDENCE_THRESHOLD,
          kept: filteredFindings.length,
          cap: REVIEW_MAX_INLINE_COMMENTS,
        }, "Dropped low-confidence, hallucinated-path, or over-cap findings before posting");
      }
      const event = resolveEvent(result.verdict, filteredFindings);
      const reviewBody = buildReviewBody({ verdict: result.verdict, event });
      const inlineComments = filteredFindings.map((finding) => ({
        path: finding.path,
        line: finding.line,
        side: "RIGHT" as const,
        body: buildInlineCommentBody(finding),
      }));
      const currentPr = await this.github.getPullRequest(repo.repoFullName, pr.number);
      const publicationDisposition = classifyPublicationDisposition(currentPr, pr.headSha);
      if (publicationDisposition.action !== "publish") {
        const superseded = publicationDisposition.action === "supersede";
        this.store.updateAttempt(attempt.id, {
          status: superseded ? "superseded" : "cancelled",
          conclusion: "skipped",
          summary: publicationDisposition.summary,
          threadId: result.threadId,
          turnId: result.turnId,
          externalCheckRunId: null,
          completedAt: new Date().toISOString(),
        });
        this.logger.info({
          repo: repo.repoFullName,
          prNumber: pr.number,
          reviewedHeadSha: pr.headSha,
          currentHeadSha: currentPr.headSha,
          action: publicationDisposition.action,
        }, "Skipping stale review publication");
        return;
      }
      const currentReviews = await this.github.listPullRequestReviews(repo.repoFullName, pr.number);
      if (hasMatchingLatestReviewForHead(currentReviews, this.reviewerLogin, pr.headSha, event, reviewBody)) {
        this.logger.info({
          repo: repo.repoFullName,
          prNumber: pr.number,
          headSha: pr.headSha,
          verdict: result.verdict.verdict,
          event,
        }, "Skipping duplicate GitHub review for unchanged head verdict");
      } else {
        // Atomic POST with body + inline comments + verdict. If GitHub
        // rejects with 422 it usually means at least one of the inline
        // comments references a path/line that isn't in the diff (e.g.
        // a context line, or a line on the LHS of the diff). The whole
        // POST is rejected as a unit, so a single bad comment kills the
        // entire review. To survive that case we retry ONCE without the
        // inline comments — the body-only review still lands so the
        // verdict is visible to the author and CI.
        try {
          await this.github.submitReview(repo.repoFullName, pr.number, {
            event,
            body: reviewBody,
            commitId: pr.headSha,
            ...(inlineComments.length > 0 ? { comments: inlineComments } : {}),
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const isUnprocessableEntity = /^GitHub API 422\b/.test(message);
          if (!isUnprocessableEntity || inlineComments.length === 0) {
            throw error;
          }
          this.logger.warn({
            repo: repo.repoFullName,
            prNumber: pr.number,
            headSha: pr.headSha,
            droppedInlineComments: inlineComments.length,
            githubError: message.slice(0, 500),
          }, "GitHub rejected review with inline comments (422); retrying body-only");
          await this.github.submitReview(repo.repoFullName, pr.number, {
            event,
            body: reviewBody,
            commitId: pr.headSha,
          });
        }
      }
      const attemptConclusion = event === "REQUEST_CHANGES" ? "declined" : "approved";
      this.store.updateAttempt(attempt.id, {
        status: "completed",
        conclusion: attemptConclusion,
        summary: result.verdict.walkthrough,
        threadId: result.threadId,
        turnId: result.turnId,
        externalCheckRunId: null,
        completedAt: new Date().toISOString(),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn({ repo: repo.repoFullName, prNumber: pr.number, error: message }, "Review attempt failed");
      const latest = this.store.updateAttempt(attempt.id, {
        status: "failed",
        conclusion: "error",
        summary: message,
        completedAt: new Date().toISOString(),
      });
      if (latest?.externalCheckRunId) {
        await this.github.updateCheckRun(repo.repoFullName, latest.externalCheckRunId, {
          status: "completed",
          conclusion: "neutral",
          summary: "Review Quill could not complete the review attempt",
          text: message,
        }).catch(() => undefined);
      }
    } finally {
      if (heartbeat) {
        clearInterval(heartbeat);
      }
    }
  }
}
