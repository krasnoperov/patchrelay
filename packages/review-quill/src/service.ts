import type { Logger } from "pino";
import type {
  PullRequestSummary,
  ReviewAttemptDetail,
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
import { buildReviewContext } from "./review-context.ts";

function branchExcluded(repo: ReviewQuillRepositoryConfig, branchName: string): boolean {
  return repo.excludeBranches.some((pattern) => pattern.endsWith("*")
    ? branchName.startsWith(pattern.slice(0, -1))
    : branchName === pattern);
}

function requiredChecksGreen(requiredChecks: string[], checks: Array<{ name: string; status: string; conclusion?: string }>): boolean {
  if (requiredChecks.length === 0) {
    return checks.length > 0 && checks.every((check) => check.status === "completed" && ["success", "neutral", "skipped"].includes(check.conclusion ?? ""));
  }
  return requiredChecks.every((required) => {
    const match = checks.find((check) => check.name === required);
    return Boolean(match && match.status === "completed" && ["success", "neutral", "skipped"].includes(match.conclusion ?? ""));
  });
}

function buildReviewBody(params: {
  verdict: "approve" | "request_changes";
  summary: string;
  findings: Array<{ path?: string; line?: number; severity: "blocking" | "nit"; message: string }>;
}): string {
  const lines = [
    `Machine verdict: ${params.verdict}`,
    "",
    params.summary,
  ];
  if (params.findings.length > 0) {
    lines.push("", "Findings:");
    for (const finding of params.findings) {
      const location = finding.path
        ? `${finding.path}${finding.line ? `:${finding.line}` : ""}`
        : undefined;
      lines.push(`- [${finding.severity}] ${location ? `${location} ` : ""}${finding.message}`);
    }
  }
  return lines.join("\n");
}

function reviewStateForVerdict(verdict: "approve" | "request_changes"): "APPROVED" | "CHANGES_REQUESTED" {
  return verdict === "approve" ? "APPROVED" : "CHANGES_REQUESTED";
}

type PublicationDisposition =
  | { action: "publish" }
  | { action: "supersede"; summary: string; checkConclusion: "cancelled" }
  | { action: "cancel"; summary: string; checkConclusion: "cancelled" };

export function hasMatchingLatestReviewForHead(
  reviews: PullRequestReviewRecord[],
  reviewerLogin: string | undefined,
  headSha: string,
  verdict: "approve" | "request_changes",
): boolean {
  if (!reviewerLogin) return false;
  const desiredState = reviewStateForVerdict(verdict);
  const latest = [...reviews]
    .reverse()
    .find((review) => review.authorLogin === reviewerLogin && review.commitId === headSha);
  return latest?.state === desiredState;
}

export function classifyPublicationDisposition(
  currentPr: Pick<PullRequestSummary, "state" | "isDraft" | "headSha">,
  reviewedHeadSha: string,
): PublicationDisposition {
  if (currentPr.headSha && currentPr.headSha !== reviewedHeadSha) {
    return {
      action: "supersede",
      summary: `Superseded by newer head ${currentPr.headSha.slice(0, 12)} before review publication`,
      checkConclusion: "cancelled",
    };
  }
  if (currentPr.state !== "open" && currentPr.state !== "OPEN") {
    return {
      action: "cancel",
      summary: `Cancelled because the PR is ${currentPr.state.toLowerCase()} before review publication`,
      checkConclusion: "cancelled",
    };
  }
  if (currentPr.isDraft) {
    return {
      action: "cancel",
      summary: "Cancelled because the PR returned to draft before review publication",
      checkConclusion: "cancelled",
    };
  }
  return { action: "publish" };
}

export class ReviewQuillService {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private reconcileInProgress = false;
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
    return this.store.listAttempts(100);
  }

  getAttemptDetail(attemptId: number): ReviewAttemptDetail | undefined {
    const attempt = this.store.getAttemptById(attemptId);
    if (!attempt) return undefined;
    return {
      attempt,
      relatedAttempts: this.store.listAttemptsForPullRequest(attempt.repoFullName, attempt.prNumber, 10),
    };
  }

  getWatchSnapshot(): ReviewQuillWatchSnapshot {
    const attempts = this.store.listAttempts(60);
    const recentWebhooks = this.store.listWebhooks(25);
    const repos = this.config.repositories.map((repo) => {
      const repoAttempts = attempts.filter((attempt) => attempt.repoFullName === repo.repoFullName);
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
        totalAttempts: attempts.length,
        queuedAttempts: attempts.filter((attempt) => attempt.status === "queued").length,
        runningAttempts: attempts.filter((attempt) => attempt.status === "running").length,
        completedAttempts: attempts.filter((attempt) => attempt.status === "completed").length,
        failedAttempts: attempts.filter((attempt) => attempt.status === "failed").length,
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
    for (const pr of prs) {
      const existing = this.store.getAttempt(repo.repoFullName, pr.number, pr.headSha);
      if (existing && !["failed", "cancelled", "superseded"].includes(existing.status)) continue;
      const eligibility = await this.evaluateEligibility(repo, pr.number, pr.headSha, pr.isDraft, pr.headRefName);
      if (!eligibility.eligible) continue;
      await this.executeReview(repo, pr, existing);
    }
  }

  private async evaluateEligibility(
    repo: ReviewQuillRepositoryConfig,
    prNumber: number,
    headSha: string,
    isDraft: boolean,
    branchName: string,
  ): Promise<ReviewEligibility> {
    if (isDraft) return { eligible: false, reason: "draft" };
    if (!headSha) return { eligible: false, reason: "missing_head_sha" };
    if (branchExcluded(repo, branchName)) return { eligible: false, reason: "excluded_branch" };
    const checks = await this.github.listCheckRuns(repo.repoFullName, headSha);
    if (!requiredChecksGreen(repo.requiredChecks, checks)) {
      return { eligible: false, reason: "required_checks_not_green" };
    }
    return { eligible: true };
  }

  private async executeReview(
    repo: ReviewQuillRepositoryConfig,
    pr: Awaited<ReturnType<GitHubClient["listOpenPullRequests"]>>[number],
    existingAttempt?: ReturnType<SqliteStore["getAttempt"]>,
  ): Promise<void> {
    const attempt = existingAttempt
      ? (this.store.updateAttempt(existingAttempt.id, {
        status: "queued",
        summary: "Retrying previous failed review attempt",
        completedAt: null,
      }) ?? existingAttempt)
      : this.store.createAttempt({
        repoFullName: repo.repoFullName,
        prNumber: pr.number,
        headSha: pr.headSha,
        status: "queued",
      });
    const detailsUrl = this.config.server.publicBaseUrl
      ? `${this.config.server.publicBaseUrl.replace(/\/$/, "")}/attempts/${attempt.id}`
      : undefined;

    try {
      const checkRunId = await this.github.createCheckRun(repo.repoFullName, {
        name: "review-quill/verdict",
        headSha: pr.headSha,
        status: "in_progress",
        summary: `Reviewing PR #${pr.number} at ${pr.headSha.slice(0, 12)}`,
        ...(detailsUrl ? { detailsUrl } : {}),
      });
      this.store.updateAttempt(attempt.id, { status: "running", externalCheckRunId: checkRunId });

      const prepared = await buildReviewContext({
        github: this.github,
        repo,
        pr,
      });
      let result: Awaited<ReturnType<ReviewRunner["review"]>>;
      try {
        result = await this.runner.review(prepared.context);
      } finally {
        await prepared.dispose();
      }
      const reviewBody = buildReviewBody({
        verdict: result.verdict.verdict,
        summary: result.verdict.summary,
        findings: result.verdict.findings,
      });
      const currentPr = await this.github.getPullRequest(repo.repoFullName, pr.number);
      const publicationDisposition = classifyPublicationDisposition(currentPr, pr.headSha);
      if (publicationDisposition.action !== "publish") {
        const superseded = publicationDisposition.action === "supersede";
        await this.github.updateCheckRun(repo.repoFullName, checkRunId, {
          status: "completed",
          conclusion: publicationDisposition.checkConclusion,
          summary: publicationDisposition.summary,
          text: publicationDisposition.summary,
          ...(detailsUrl ? { detailsUrl } : {}),
        });
        this.store.updateAttempt(attempt.id, {
          status: superseded ? "superseded" : "cancelled",
          conclusion: "skipped",
          summary: publicationDisposition.summary,
          threadId: result.threadId,
          turnId: result.turnId,
          externalCheckRunId: checkRunId,
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
      const approved = result.verdict.verdict === "approve";
      const currentReviews = await this.github.listPullRequestReviews(repo.repoFullName, pr.number);
      if (hasMatchingLatestReviewForHead(currentReviews, this.reviewerLogin, pr.headSha, result.verdict.verdict)) {
        this.logger.info({
          repo: repo.repoFullName,
          prNumber: pr.number,
          headSha: pr.headSha,
          verdict: result.verdict.verdict,
        }, "Skipping duplicate GitHub review for unchanged head verdict");
      } else {
        await this.github.submitReview(repo.repoFullName, pr.number, {
          event: approved ? "APPROVE" : "REQUEST_CHANGES",
          body: reviewBody,
        });
      }
      await this.github.updateCheckRun(repo.repoFullName, checkRunId, {
        status: "completed",
        conclusion: approved ? "success" : "failure",
        summary: result.verdict.summary,
        text: reviewBody,
        ...(detailsUrl ? { detailsUrl } : {}),
      });
      this.store.updateAttempt(attempt.id, {
        status: "completed",
        conclusion: approved ? "approved" : "declined",
        summary: result.verdict.summary,
        threadId: result.threadId,
        turnId: result.turnId,
        externalCheckRunId: checkRunId,
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
          ...(detailsUrl ? { detailsUrl } : {}),
        }).catch(() => undefined);
      }
    }
  }
}
