import type { Logger } from "pino";
import type {
  PullRequestSummary,
  ReviewAttemptDetail,
  ReviewAttemptRecord,
  ReviewEligibility,
  ReviewFinding,
  ReviewQuillConfig,
  ReviewQuillRepositoryConfig,
  ReviewQuillRuntimeStatus,
  ReviewQuillWatchSnapshot,
  ReviewVerdict,
} from "./types.ts";
import type { SqliteStore } from "./db/sqlite-store.ts";
import type { GitHubClient } from "./github-client.ts";
import type { ReviewRunner } from "./review-runner.ts";
import type { PullRequestReviewRecord } from "./types.ts";
import { decorateAttempt, describeAttemptState, isAttemptActive } from "./attempt-state.ts";
import { buildReviewContext } from "./review-context.ts";

// Findings below this confidence score are dropped before posting.
// Empirical; tunable. Claude Code plugin uses 80 as its default. We
// start at 70 — slightly more permissive — and can raise if noise creeps
// back in.
const CONFIDENCE_THRESHOLD = 70;

// Guard against a runaway model producing 100 inline comments. Matches
// PR-Agent's `num_max_findings` cap philosophy.
const MAX_INLINE_COMMENTS = 20;

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

// Drop findings the model was not confident in, then cap the total
// count so a runaway model can't spam 100 inline comments.
//
// Also drop findings that point at files the model invented — any
// path not in `knownPaths` gets silently removed. The diff inventory
// is the authoritative list of files the model could actually review,
// so a finding pointing outside of it is always a hallucination.
export function filterFindings(findings: ReviewFinding[], knownPaths?: Set<string>): ReviewFinding[] {
  const confident = findings.filter((f) => (f.confidence ?? 100) >= CONFIDENCE_THRESHOLD);
  const withKnownPath = knownPaths
    ? confident.filter((f) => knownPaths.has(f.path))
    : confident;
  // Keep blocking findings first, then nits, up to the cap.
  const sorted = [...withKnownPath].sort((a, b) => {
    if (a.severity === b.severity) return (b.confidence ?? 100) - (a.confidence ?? 100);
    return a.severity === "blocking" ? -1 : 1;
  });
  return sorted.slice(0, MAX_INLINE_COMMENTS);
}

// Map the agent's verdict + findings to the GitHub review event. Enforces
// "nits never block": even if the model asked for REQUEST_CHANGES, if
// there are no blocking findings we demote to COMMENT. This is the same
// rule `normalizeVerdict` enforces in review-runner, but we re-apply it
// here after the confidence filter (which might have removed the
// blocking finding that justified request_changes in the first place).
export function resolveEvent(verdict: ReviewVerdict, filtered: ReviewFinding[]): "APPROVE" | "REQUEST_CHANGES" {
  const hasBlocking = filtered.some((f) => f.severity === "blocking")
    || verdict.architectural_concerns.some((c) => c.severity === "blocking");
  if (hasBlocking) return "REQUEST_CHANGES";
  return "APPROVE";
}

// Build the review body (posted into the `body` field of the GitHub
// review, i.e. the walkthrough comment at the top). Structured as:
//   1. Walkthrough narrative
//   2. Architectural concerns section (if any)
//   3. Final verdict line with rationale
export function buildReviewBody(params: {
  verdict: ReviewVerdict;
  event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
}): string {
  const { verdict, event } = params;
  const lines: string[] = [];

  lines.push(verdict.walkthrough.trim());

  if (verdict.architectural_concerns.length > 0) {
    lines.push("", "## Architectural concerns");
    for (const concern of verdict.architectural_concerns) {
      const marker = concern.severity === "blocking" ? "🚨" : "💡";
      lines.push(`- ${marker} **[${concern.category}]** ${concern.message}`);
    }
  }

  lines.push("");
  const verdictLabel = event === "APPROVE"
    ? "✅ Approve"
    : event === "REQUEST_CHANGES"
      ? "🛑 Request changes"
      : "💬 Comment";
  lines.push(`**Verdict: ${verdictLabel}** — ${verdict.verdict_reason}`);

  return lines.join("\n");
}

// Format a single inline comment body: severity marker + message + optional
// committable suggestion block. The 6-line rule from Claude Code is
// enforced here: suggestions longer than 6 lines are dropped (we keep
// the message describing the fix, but don't inject a suggestion block
// that the reviewer would have to manually trim).
export function buildInlineCommentBody(finding: ReviewFinding): string {
  const marker = finding.severity === "blocking" ? "🚨" : "💡";
  const header = `${marker} ${finding.message}`;
  if (finding.suggestion) {
    const snippetLines = finding.suggestion.split("\n").length;
    if (snippetLines <= 6) {
      return `${header}\n\n\`\`\`suggestion\n${finding.suggestion}\n\`\`\``;
    }
  }
  return header;
}

function reviewStateForEvent(event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT"): "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" {
  switch (event) {
    case "APPROVE": return "APPROVED";
    case "REQUEST_CHANGES": return "CHANGES_REQUESTED";
    case "COMMENT": return "COMMENTED";
  }
}

function normalizeReviewerLogin(login: string | undefined): string | undefined {
  return login?.replace(/\[bot\]$/i, "");
}

function matchesReviewerLogin(authorLogin: string | undefined, reviewerLogin: string | undefined): boolean {
  const normalizedAuthor = normalizeReviewerLogin(authorLogin);
  const normalizedReviewer = normalizeReviewerLogin(reviewerLogin);
  return Boolean(normalizedAuthor && normalizedReviewer && normalizedAuthor === normalizedReviewer);
}

export function preserveRequestedChangesOnRereview(params: {
  reviews: PullRequestReviewRecord[];
  reviewerLogin: string | undefined;
  headSha: string;
  event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
}): "APPROVE" | "REQUEST_CHANGES" | "COMMENT" {
  if (params.event !== "COMMENT" || !params.reviewerLogin) {
    return params.event;
  }

  const latestPriorDecisiveReview = [...params.reviews]
    .reverse()
    .find((review) => matchesReviewerLogin(review.authorLogin, params.reviewerLogin)
      && review.commitId !== params.headSha
      && (review.state === "CHANGES_REQUESTED" || review.state === "APPROVED"));

  if (latestPriorDecisiveReview?.state === "CHANGES_REQUESTED") {
    return "REQUEST_CHANGES";
  }

  return params.event;
}

export function shouldRecoverNonDecisiveRereview(params: {
  attempt: Pick<ReviewAttemptRecord, "status" | "conclusion">;
  reviews: PullRequestReviewRecord[];
  reviewerLogin: string | undefined;
  headSha: string;
}): boolean {
  if (params.attempt.status !== "completed" || params.attempt.conclusion !== "skipped") {
    return false;
  }
  if (!hasMatchingLatestReviewForHead(params.reviews, params.reviewerLogin, params.headSha, "COMMENT")) {
    return false;
  }
  return preserveRequestedChangesOnRereview({
    reviews: params.reviews,
    reviewerLogin: params.reviewerLogin,
    headSha: params.headSha,
    event: "COMMENT",
  }) === "REQUEST_CHANGES";
}

type PublicationDisposition =
  | { action: "publish" }
  | { action: "supersede"; summary: string; checkConclusion: "cancelled" }
  | { action: "cancel"; summary: string; checkConclusion: "cancelled" };

// Decide whether we should skip posting the new review because the
// existing one (from us, on the same head SHA) is already equivalent.
//
// Equivalence means BOTH:
//   - the review state matches (APPROVED / CHANGES_REQUESTED / COMMENTED)
//   - the rendered body is byte-identical
//
// The body comparison closes the gap where two runs on the same head
// produce the same verdict but different walkthroughs / findings — we
// want the new content visible to the author instead of silently
// keeping the stale content. Inline comments are deterministic from
// the body (both are derived from the same findings array), so body
// equality is a sufficient proxy; we don't need to diff comments too.
export function hasMatchingLatestReviewForHead(
  reviews: PullRequestReviewRecord[],
  reviewerLogin: string | undefined,
  headSha: string,
  event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT",
  newBody?: string,
): boolean {
  if (!reviewerLogin) return false;
  const desiredState = reviewStateForEvent(event);
  const latest = [...reviews]
    .reverse()
    .find((review) => matchesReviewerLogin(review.authorLogin, reviewerLogin) && review.commitId === headSha);
  if (latest?.state !== desiredState) return false;
  // State matches. If we were given a newBody to compare, require
  // byte-equality too. If not (backward compat), the state match is
  // enough.
  if (newBody !== undefined && latest.body !== newBody) return false;
  return true;
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

  getAttemptDetail(attemptId: number): ReviewAttemptDetail | undefined {
    const attempt = this.store.getAttemptById(attemptId);
    if (!attempt) return undefined;
    return {
      attempt: this.decorateAttempt(attempt),
      relatedAttempts: this.store
        .listAttemptsForPullRequest(attempt.repoFullName, attempt.prNumber, 10)
        .map((related) => this.decorateAttempt(related)),
    };
  }

  getWatchSnapshot(): ReviewQuillWatchSnapshot {
    const attempts = this.store.listAttempts(60).map((attempt) => this.decorateAttempt(attempt));
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
      await this.reconcileActiveAttemptsForPullRequest(repo, pr);
      const existing = this.store.getAttempt(repo.repoFullName, pr.number, pr.headSha);
      const eligibility = await this.evaluateEligibility(repo, pr.number, pr.headSha, pr.isDraft, pr.headRefName);
      if (existing && !["failed", "cancelled", "superseded"].includes(existing.status)) {
        if (!eligibility.eligible) continue;
        const currentReviews = await this.github.listPullRequestReviews(repo.repoFullName, pr.number);
        if (shouldRecoverNonDecisiveRereview({
          attempt: existing,
          reviews: currentReviews,
          reviewerLogin: this.reviewerLogin,
          headSha: pr.headSha,
        })) {
          this.logger.warn({
            repo: repo.repoFullName,
            prNumber: pr.number,
            headSha: pr.headSha,
            attemptId: existing.id,
          }, "Recovering non-decisive re-review on current head");
          await this.executeReview(repo, pr, existing);
        }
        continue;
      }
      if (!eligibility.eligible) continue;
      await this.executeReview(repo, pr, existing);
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
          threshold: CONFIDENCE_THRESHOLD,
          kept: filteredFindings.length,
          cap: MAX_INLINE_COMMENTS,
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
      const effectiveEvent = preserveRequestedChangesOnRereview({
        reviews: currentReviews,
        reviewerLogin: this.reviewerLogin,
        headSha: pr.headSha,
        event,
      });
      const effectiveReviewBody = buildReviewBody({ verdict: result.verdict, event: effectiveEvent });
      if (effectiveEvent !== event) {
        this.logger.info({
          repo: repo.repoFullName,
          prNumber: pr.number,
          headSha: pr.headSha,
          previousEvent: event,
          effectiveEvent,
        }, "Promoted re-review comment to requested changes to preserve decisive review state");
      }
      if (hasMatchingLatestReviewForHead(currentReviews, this.reviewerLogin, pr.headSha, effectiveEvent, effectiveReviewBody)) {
        this.logger.info({
          repo: repo.repoFullName,
          prNumber: pr.number,
          headSha: pr.headSha,
          verdict: result.verdict.verdict,
          event: effectiveEvent,
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
            event: effectiveEvent,
            body: effectiveReviewBody,
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
            event: effectiveEvent,
            body: effectiveReviewBody,
            commitId: pr.headSha,
          });
        }
      }
      const attemptConclusion = effectiveEvent === "REQUEST_CHANGES"
        ? "declined"
        : effectiveEvent === "COMMENT"
          ? "skipped"
          : "approved";
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
          ...(detailsUrl ? { detailsUrl } : {}),
        }).catch(() => undefined);
      }
    } finally {
      if (heartbeat) {
        clearInterval(heartbeat);
      }
    }
  }
}
