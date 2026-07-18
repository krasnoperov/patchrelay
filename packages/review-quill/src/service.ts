import type { Logger } from "pino";
import type {
  PullRequestSummary,
  ReviewAttemptDetail,
  ReviewAttemptRecord,
  ReviewEligibility,
  ReviewQuillConfig,
  ReviewQuillRepositoryConfig,
  ReviewQuillPendingReview,
  ReviewQuillRuntimeStatus,
  ReviewQuillWatchSnapshot,
} from "./types.ts";
import type { SqliteStore } from "./db/sqlite-store.ts";
import type { GitHubClient } from "./github-client.ts";
import { ReviewRunInterruptedError, type ReviewRunner } from "./review-runner.ts";
import { CodexCapacityError, CodexCapacityPause } from "./codex-capacity.ts";
import { AttemptReconciler } from "./attempt-reconciler.ts";
import { decorateAttempt } from "./attempt-state.ts";
import { getLatestAttemptsByPullRequest } from "./attempt-summary.ts";
import { CannotIntegrateError, buildReviewContext } from "./review-context.ts";
import {
  type ChangeIdentity,
  resolveReviewSurfaceMode,
  tryCarryForward,
} from "./carry-forward.ts";
import {
  determinePendingCheckState,
  pendingCheckNames,
} from "./pending-check-classifier.ts";
import {
  buildReviewBody,
  classifyPublicationDisposition,
  hasMatchingLatestReviewForHead,
  REVIEW_FINDING_CONFIDENCE_THRESHOLD,
  REVIEW_MAX_INLINE_COMMENTS,
} from "./review-publication-policy.ts";
import { renderReviewArtifacts } from "./review-artifact-renderer.ts";
import { submitReviewWithFallback } from "./submit-review-with-fallback.ts";
import { evaluateReviewEligibility } from "./review-eligibility.ts";
import { ReviewSemaphore } from "./review-semaphore.ts";
import { buildPromptFingerprint } from "./prompt-fingerprint.ts";

/** Default cap on parallel review executions. Review Quill shares one
 *  Codex app-server and one git cache per repository, so the default
 *  is intentionally conservative; operators can raise it after watching
 *  local Codex, disk, and GitHub API behavior under bursty review load. */
const DEFAULT_MAX_CONCURRENT_REVIEWS = 4;

class ReviewExecutionSupersededError extends Error {
  constructor(readonly summary: string) {
    super(summary);
    this.name = "ReviewExecutionSupersededError";
  }
}

export class ReviewQuillService {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly startedAt = new Date().toISOString();
  private readonly pendingReviewsByRepo = new Map<string, ReviewQuillPendingReview[]>();
  /**
   * In-memory dedupe of executions. Key is `{repoFullName}::{prNumber}::{headSha}`.
   * Two discovery passes that both land on the same PR head before the DB row is
   * inserted would otherwise both dispatch — this map ensures only one runs.
   * Cross-restart safety is provided by the `UNIQUE(repo_full_name, pr_number,
   * head_sha)` constraint on `review_attempts`.
   */
  private readonly inFlightReviews = new Map<string, Promise<void>>();
  private readonly inFlightReviewSignals = new Map<string, AbortController>();
  private readonly semaphore: ReviewSemaphore;
  private readonly reconciler: AttemptReconciler;
  /**
   * Service-wide gate that suspends ALL review dispatch while the Codex
   * account is out of usage capacity. In-memory only by design: a restart
   * mid-pause just retries on the next cycle and re-enters the pause on the
   * first capacity error — Codex itself is the source of truth.
   */
  private codexCapacityPause = new CodexCapacityPause();
  /**
   * Indirection over buildReviewContext so tests can stub workspace
   * materialization (it shells out to git) while still exercising the real
   * executeReview success/failure handling.
   */
  private buildContext: typeof buildReviewContext = buildReviewContext;
  private readonly runtime: ReviewQuillRuntimeStatus = {
    lastReconcileStartedAt: null,
    lastReconcileCompletedAt: null,
    lastReconcileOutcome: "idle",
    lastReconcileError: null,
    inFlightReviews: 0,
    repoLastReconciledAt: {},
    repoLastReconcileErrors: {},
    codexLimitedUntil: null,
  };

  constructor(
    private readonly config: ReviewQuillConfig,
    private readonly store: SqliteStore,
    private readonly github: GitHubClient,
    private readonly runner: ReviewRunner,
    private readonly logger: Logger,
    private readonly reviewerLogin?: string,
  ) {
    const capacity = config.reconciliation.maxConcurrentReviews ?? DEFAULT_MAX_CONCURRENT_REVIEWS;
    this.semaphore = new ReviewSemaphore(capacity, (inFlight) => {
      this.runtime.inFlightReviews = inFlight;
    });
    this.reconciler = new AttemptReconciler({
      store: this.store,
      github: this.github,
      logger: this.logger,
      config: this.config,
      serviceStartedAt: this.startedAt,
      reviewerLogin: this.reviewerLogin,
    });
  }

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
      runtime: { ...this.runtime, codexLimitedUntil: this.codexCapacityPause.limitedUntil() },
      repos,
      attempts,
      recentWebhooks,
      pendingReviews: [...this.pendingReviewsByRepo.values()].flat(),
    };
  }

  getRuntimeStatus(): ReviewQuillRuntimeStatus {
    return {
      ...this.runtime,
      repoLastReconciledAt: { ...this.runtime.repoLastReconciledAt },
      repoLastReconcileErrors: { ...this.runtime.repoLastReconcileErrors },
      // Computed live so the pause auto-expires without needing a tick.
      codexLimitedUntil: this.codexCapacityPause.limitedUntil(),
    };
  }

  private setPendingReviews(repoId: string, pending: ReviewQuillPendingReview[]): void {
    this.pendingReviewsByRepo.set(repoId, pending);
  }

  private prunePendingReviews(openRepoIds: string[]): void {
    const toKeep = new Set(openRepoIds);
    for (const repoId of Array.from(this.pendingReviewsByRepo.keys())) {
      if (!toKeep.has(repoId)) {
        this.pendingReviewsByRepo.delete(repoId);
      }
    }
  }

  /**
   * Triggers a discovery pass and waits for it (but NOT for the reviews it
   * fans out — those are independent workers under the semaphore).
   * `repoFullName` scopes discovery to one repo; otherwise all watched
   * repos are walked.
   *
   * Multiple passes can run concurrently — discovery is read-only against
   * the world (GitHub list calls + DB lookups + cheap eligibility math)
   * and the dispatch itself is dedupe'd by `inFlightReviews`. There's no
   * global lock to wait on, so this method always returns `true` once the
   * discovery completes; the boolean is kept for backward compat with the
   * earlier `false = queued, will run later` semantics.
   */
  async triggerReconcile(repoFullName?: string): Promise<boolean> {
    await (repoFullName ? this.discoverRepoByName(repoFullName) : this.reconcileAll());
    return true;
  }

  /**
   * Fire-and-forget variant. Discovery runs in the background; errors are
   * logged. Always returns `true` — there is no queue any more.
   */
  requestReconcile(repoFullName?: string): boolean {
    void (repoFullName ? this.discoverRepoByName(repoFullName) : this.reconcileAll()).catch((error: unknown) => {
      this.logger.error({
        repo: repoFullName,
        error: error instanceof Error ? error.message : String(error),
      }, "Background reconcile failed");
    });
    return true;
  }

  private schedule(): void {
    this.timer = setTimeout(() => {
      void this.reconcileAll().finally(() => this.schedule());
    }, this.config.reconciliation.pollIntervalMs);
    this.timer.unref?.();
  }

  private async reconcileAll(): Promise<void> {
    this.runtime.lastReconcileStartedAt = new Date().toISOString();
    this.runtime.lastReconcileOutcome = "running";
    this.runtime.lastReconcileError = null;
    // Discover all repos in parallel. Discovery is read-only and cheap —
    // GitHub list + DB lookups + carry-forward identity math. Heavy work
    // (Codex turn) is dispatched as a fire-and-forget worker that runs
    // outside the discovery pass, gated by `acquireReviewSlot()`.
    const results = await Promise.all(
      this.config.repositories.map(async (repo) => {
        try {
          await this.discoverRepo(repo);
          delete this.runtime.repoLastReconcileErrors[repo.repoFullName];
          return { repo, ok: true as const };
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          this.runtime.repoLastReconcileErrors[repo.repoFullName] = message;
          this.logger.error({
            repo: repo.repoFullName,
            err: message,
          }, "discoverRepo failed");
          return {
            repo,
            ok: false as const,
            error: message,
          };
        }
      }),
    );
    this.prunePendingReviews(this.config.repositories.map((repo) => repo.repoId));
    this.runtime.lastReconcileCompletedAt = new Date().toISOString();

    const failures = results.filter((result) => !result.ok);
    if (failures.length === 0) {
      this.runtime.lastReconcileOutcome = "succeeded";
      this.runtime.lastReconcileError = null;
      return;
    }

    const summary = failures
      .map((failure) => `${failure.repo.repoFullName}: ${failure.error}`)
      .join("; ");
    this.runtime.lastReconcileError = summary;
    if (failures.length === results.length) {
      this.runtime.lastReconcileOutcome = "failed";
    } else {
      this.runtime.lastReconcileOutcome = "degraded";
    }
  }

  private async discoverRepoByName(repoFullName: string): Promise<void> {
    const repo = this.config.repositories.find((entry) => entry.repoFullName === repoFullName);
    if (!repo) return;
    await this.discoverRepo(repo);
  }

  /**
   * Dispatches a review as an independent worker. Idempotent: if the same
   * (repo, pr, head) is already in flight, the existing promise is returned
   * so the caller doesn't double-fire. The promise resolves when the review
   * completes (or fails); errors are logged, never thrown out.
   */
  private dispatchReview(
    repo: ReviewQuillRepositoryConfig,
    pr: PullRequestSummary,
    existing: ReviewAttemptRecord | undefined,
    identity: ChangeIdentity | undefined,
  ): Promise<void> {
    const key = `${repo.repoFullName}::${pr.number}::${pr.headSha}`;
    const inFlight = this.inFlightReviews.get(key);
    if (inFlight) return inFlight;

    this.supersedeInFlightReviewsForPullRequest(repo, pr.number, pr.headSha);
    const controller = new AbortController();
    this.inFlightReviewSignals.set(key, controller);
    const work = (async () => {
      const release = await this.semaphore.acquire();
      try {
        await this.executeReview(repo, pr, existing, identity, controller.signal);
      } catch (error) {
        if (error instanceof ReviewExecutionSupersededError) {
          this.logger.info({
            repo: repo.repoFullName,
            prNumber: pr.number,
            headSha: pr.headSha,
            summary: error.summary,
          }, "Skipped superseded review worker before attempt creation");
          return;
        }
        this.logger.error({
          repo: repo.repoFullName,
          prNumber: pr.number,
          headSha: pr.headSha,
          err: error instanceof Error ? error.message : String(error),
        }, "Review execution failed");
      } finally {
        release();
        this.inFlightReviews.delete(key);
        this.inFlightReviewSignals.delete(key);
      }
    })();

    this.inFlightReviews.set(key, work);
    return work;
  }

  private supersedeInFlightReviewsForPullRequest(
    repo: ReviewQuillRepositoryConfig,
    prNumber: number,
    currentHeadSha: string,
  ): void {
    const prefix = `${repo.repoFullName}::${prNumber}::`;
    for (const [key, controller] of this.inFlightReviewSignals.entries()) {
      if (!key.startsWith(prefix) || key === `${prefix}${currentHeadSha}` || controller.signal.aborted) {
        continue;
      }
      controller.abort(`Superseded by newer head ${currentHeadSha.slice(0, 12)} before review started.`);
      this.logger.info({
        repo: repo.repoFullName,
        prNumber,
        currentHeadSha,
        supersededKey: key,
      }, "Superseded older in-flight review worker for pull request");
    }
  }

  private throwIfReviewSuperseded(signal: AbortSignal | undefined): void {
    if (!signal?.aborted) return;
    const reason = typeof signal.reason === "string" && signal.reason.trim()
      ? signal.reason.trim()
      : "Superseded by newer head before review started.";
    throw new ReviewExecutionSupersededError(reason);
  }

  /**
   * Discovery pass for one repo. Walks the open PR list, decides per PR
   * whether a fresh review is needed, and **dispatches** any executions
   * as independent workers (fire-and-forget under the semaphore).
   *
   * Discovery itself is read-only and cheap — no Codex calls happen here,
   * so multiple discovery passes can run concurrently with no coordination
   * other than the in-flight dedup in `dispatchReview`.
   */
  private async discoverRepo(repo: ReviewQuillRepositoryConfig): Promise<void> {
    const prs = await this.github.listOpenPullRequests(repo.repoFullName);
    const pendingForRepo: ReviewQuillPendingReview[] = [];
    await this.reconciler.reconcileClosedPullRequestAttempts(repo, prs);
    for (const pr of prs) {
      await this.reconciler.reconcileActiveAttemptsForPullRequest(repo, pr);
      this.supersedeInFlightReviewsForPullRequest(repo, pr.number, pr.headSha);
      const currentReviews = await this.github.listPullRequestReviews(repo.repoFullName, pr.number);
      const existing = this.store.getAttempt(repo.repoFullName, pr.number, pr.headSha);
      const eligibility = await this.evaluateEligibility(repo, pr.number, pr.headSha, pr.isDraft, pr.headRefName);
      if (!eligibility.eligible && !pr.isDraft && eligibility.reason === "required_checks_not_green") {
        const checks = eligibility.checkRuns ?? [];
        const state = determinePendingCheckState(checks, repo.requiredChecks);
        const summary = pendingCheckNames(checks, repo.requiredChecks);
        if (state !== "checks_unknown" || summary.failed.length > 0 || summary.pending.length > 0) {
          pendingForRepo.push({
            repoId: repo.repoId,
            repoFullName: repo.repoFullName,
            prNumber: pr.number,
            headSha: pr.headSha,
            headRefName: pr.headRefName,
            ...(pr.title ? { prTitle: pr.title } : {}),
            reason: state,
            failedChecks: summary.failed,
            pendingChecks: summary.pending,
            updatedAt: new Date().toISOString(),
          });
        }
      }

      // Decide whether this PR needs a fresh review run, attempting
      // carry-forward first when eligible. Dismissal of stale decisive
      // reviews must run AFTER the carry-forward decision (plan
      // implementation.md §A.4): otherwise a transient identity-compute
      // failure would dismiss the prior approval and leave nothing to
      // re-emit.
      let needsExecution = false;
      let identity: ChangeIdentity | undefined;
      if (existing && !["failed", "cancelled", "superseded"].includes(existing.status)) {
        // Exact-head match — already reviewed (or in-flight) on this SHA.
      } else if (!eligibility.eligible) {
        // Ineligible — nothing to publish.
      } else {
        const result = await tryCarryForward(repo, pr, {
          store: this.store,
          github: this.github,
          logger: this.logger,
        });
        if (result.kind === "carried_forward") {
          needsExecution = false;
        } else {
          identity = result.kind === "no_candidate" ? result.identity : undefined;
          needsExecution = true;
        }
      }

      // Now safe: either we already re-emitted on the current head
      // (carry-forward hit) or we are about to run a fresh review that
      // will publish a new verdict (executeReview branch).
      await this.reconciler.dismissStaleDecisiveReviews(repo, pr, currentReviews);

      if (needsExecution) {
        // While the Codex account is out of capacity, skip dispatch
        // entirely — every attempt would burn a workspace + thread just to
        // fail with the same account-level error. One warn was logged when
        // the pause began; per-PR skips stay at debug. The pause expires by
        // itself, so the next cycle past the deadline dispatches normally.
        if (this.codexCapacityPause.isPaused()) {
          this.logger.debug({
            repo: repo.repoFullName,
            prNumber: pr.number,
            headSha: pr.headSha,
            codexLimitedUntil: this.codexCapacityPause.limitedUntil(),
          }, "Skipping review dispatch during Codex capacity pause");
          continue;
        }
        // Fire-and-forget. The discovery pass returns once all PRs have
        // been *evaluated*, not once their reviews are published — that
        // way one repo's long-running review never blocks discovery for
        // any other repo. The semaphore inside `dispatchReview` is what
        // bounds CPU/memory, not the discovery loop.
        this.dispatchReview(repo, pr, existing, identity);
      }
    }

    this.setPendingReviews(repo.repoId, pendingForRepo);
    this.runtime.repoLastReconciledAt[repo.repoFullName] = new Date().toISOString();
    delete this.runtime.repoLastReconcileErrors[repo.repoFullName];
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
    identity?: ChangeIdentity,
    signal?: AbortSignal,
  ): Promise<void> {
    this.throwIfReviewSuperseded(signal);
    // A worker dispatched moments before a Codex capacity pause began may
    // only reach the front of the semaphore queue after the pause is in
    // effect — bail out before creating or touching any attempt state.
    if (this.codexCapacityPause.isPaused()) {
      this.logger.debug({
        repo: repo.repoFullName,
        prNumber: pr.number,
        headSha: pr.headSha,
        codexLimitedUntil: this.codexCapacityPause.limitedUntil(),
      }, "Skipping review execution during Codex capacity pause");
      return;
    }
    // Plan §3.6: the publication policy below (inline-vs-body-only)
    // must match whatever materializeReviewWorkspaceWithMode actually
    // produced. buildReviewContext resolves surface mode straight from
    // repo config — derive the same here so we don't anchor inline
    // comments at PR head while the model reviewed an integration
    // tree (identity computation can return undefined for stacked
    // PRs and other failure paths; identity.mode is therefore not a
    // reliable source of truth).
    const surfaceMode = resolveReviewSurfaceMode(repo);
    const attempt = existingAttempt
      ? (this.store.updateAttempt(existingAttempt.id, {
        status: "queued",
        conclusion: null,
        summary: "Retrying previous failed review attempt",
        externalCheckRunId: null,
        completedAt: null,
        ...(identity?.patchId !== undefined ? { patchId: identity.patchId } : {}),
        ...(identity?.integrationTreeId !== undefined ? { integrationTreeId: identity.integrationTreeId } : {}),
        reviewSurfaceMode: surfaceMode,
        ...(identity?.baseSha !== undefined ? { baseSha: identity.baseSha } : {}),
        promptFingerprint: buildPromptFingerprint(pr),
      }) ?? existingAttempt)
      : this.store.createAttempt({
        repoFullName: repo.repoFullName,
        prNumber: pr.number,
        headSha: pr.headSha,
        status: "queued",
        ...(pr.title ? { prTitle: pr.title } : {}),
        promptFingerprint: buildPromptFingerprint(pr),
        ...(identity?.patchId !== undefined ? { patchId: identity.patchId } : {}),
        ...(identity?.integrationTreeId !== undefined ? { integrationTreeId: identity.integrationTreeId } : {}),
        reviewSurfaceMode: surfaceMode,
        ...(identity?.baseSha !== undefined ? { baseSha: identity.baseSha } : {}),
      });
    if (existingAttempt && pr.title && attempt.prTitle !== pr.title) {
      this.store.setAttemptTitle(attempt.id, pr.title);
      attempt.prTitle = pr.title;
    }
    let heartbeat: ReturnType<typeof setInterval> | undefined;

    try {
      this.store.updateAttempt(attempt.id, {
        status: "running",
        externalCheckRunId: null,
      });
      this.throwIfReviewSuperseded(signal);

      const preflightPr = await this.github.getPullRequest(repo.repoFullName, pr.number);
      const preflightDisposition = classifyPublicationDisposition(preflightPr, pr.headSha);
      if (preflightDisposition.action !== "publish") {
        const superseded = preflightDisposition.action === "supersede";
        this.store.updateAttempt(attempt.id, {
          status: superseded ? "superseded" : "cancelled",
          conclusion: "skipped",
          summary: preflightDisposition.summary,
          externalCheckRunId: null,
          completedAt: new Date().toISOString(),
        });
        this.logger.info({
          repo: repo.repoFullName,
          prNumber: pr.number,
          reviewedHeadSha: pr.headSha,
          currentHeadSha: preflightPr.headSha,
          action: preflightDisposition.action,
        }, "Skipping stale review before Codex execution");
        return;
      }
      this.store.updateAttempt(attempt.id, {
        promptFingerprint: buildPromptFingerprint(preflightPr),
      });
      if (preflightPr.title && attempt.prTitle !== preflightPr.title) {
        this.store.setAttemptTitle(attempt.id, preflightPr.title);
        attempt.prTitle = preflightPr.title;
      }
      this.throwIfReviewSuperseded(signal);

      heartbeat = setInterval(() => {
        this.store.updateAttempt(attempt.id, {});
      }, this.config.reconciliation.heartbeatIntervalMs);
      heartbeat.unref?.();

      let prepared: Awaited<ReturnType<typeof buildReviewContext>>;
      try {
        prepared = await this.buildContext({
          github: this.github,
          repo,
          pr,
          prompting: this.config.prompting,
          logger: this.logger,
          selfLogin: this.reviewerLogin,
        });
      } catch (error) {
        if (error instanceof CannotIntegrateError) {
          // Plan §3.4 conflict path. Mark this attempt declined with a
          // `cannot_integrate` reason so the lander's spec build is
          // not bypassed and the operator sees an early-eviction signal.
          this.store.updateAttempt(attempt.id, {
            status: "completed",
            conclusion: "declined",
            summary: `cannot_integrate: PR head conflicts with ${repo.baseBranch}`,
            completedAt: new Date().toISOString(),
          });
          this.logger.warn({
            repo: repo.repoFullName,
            prNumber: pr.number,
            headSha: error.headSha,
            baseSha: error.baseSha,
          }, "Marked review attempt declined: cannot_integrate (merge-tree conflict in integration_tree mode)");
          return;
        }
        throw error;
      }
      let result: Awaited<ReturnType<ReviewRunner["review"]>>;
      try {
        this.throwIfReviewSuperseded(signal);
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
        result = await this.runner.review(prepared.context, {
          ...(signal ? { signal } : {}),
          onThreadSnapshot: (transcript) => {
            this.store.updateAttempt(attempt.id, {
              threadId: transcript.id,
              turnId: transcript.turns.at(-1)?.id ?? null,
              transcript,
            });
          },
        });
      } finally {
        await prepared.dispose();
      }
      this.throwIfReviewSuperseded(signal);
      const { reviewBody, inlineComments, filteredFindings, event, dropStats } = renderReviewArtifacts({
        verdict: result.verdict,
        inventoryPaths: prepared.context.diff.inventory.map((entry) => entry.path),
        surfaceMode,
      });
      if (dropStats.droppedTotal > 0) {
        this.logger.info({
          repo: repo.repoFullName,
          prNumber: pr.number,
          droppedByConfidence: dropStats.droppedByConfidence,
          droppedByPath: dropStats.droppedByPath,
          threshold: REVIEW_FINDING_CONFIDENCE_THRESHOLD,
          kept: filteredFindings.length,
          cap: REVIEW_MAX_INLINE_COMMENTS,
        }, "Dropped low-confidence, hallucinated-path, or over-cap findings before posting");
      }
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
      // Track the body we actually posted so the persisted attempt
      // row matches what's visible on GitHub. The 422 retry path
      // re-renders the body with findings folded in, so this can
      // diverge from the primary `reviewBody`.
      let publishedBody = reviewBody;
      if (hasMatchingLatestReviewForHead(currentReviews, this.reviewerLogin, pr.headSha, event, reviewBody)) {
        this.logger.info({
          repo: repo.repoFullName,
          prNumber: pr.number,
          headSha: pr.headSha,
          verdict: result.verdict.verdict,
          event,
        }, "Skipping duplicate GitHub review for unchanged head verdict");
      } else {
        publishedBody = await submitReviewWithFallback({
          github: this.github,
          logger: this.logger,
          repoFullName: repo.repoFullName,
          prNumber: pr.number,
          headSha: pr.headSha,
          event,
          primaryBody: reviewBody,
          inlineComments,
          buildFallbackBody: () => buildReviewBody({
            verdict: result.verdict,
            event,
            inlineFindings: filteredFindings,
          }),
        });
      }
      const attemptConclusion = event === "REQUEST_CHANGES" ? "declined" : "approved";
      // Persist the rendered review on the attempt row so future heads
      // that produce the same patch-id can be served from the cache by
      // re-emitting this body+event without re-running the reviewer.
      // publicationMode is body_only in v1; with_annotations is deferred.
      this.store.updateAttempt(attempt.id, {
        status: "completed",
        conclusion: attemptConclusion,
        summary: result.verdict.walkthrough?.trim() || result.verdict.verdict_reason,
        threadId: result.threadId,
        turnId: result.turnId,
        externalCheckRunId: null,
        completedAt: new Date().toISOString(),
        reviewBody: publishedBody,
        reviewEvent: event,
        publicationMode: "body_only",
      });
    } catch (error) {
      if (error instanceof ReviewExecutionSupersededError) {
        this.store.updateAttempt(attempt.id, {
          status: "superseded",
          conclusion: "skipped",
          summary: error.summary,
          externalCheckRunId: null,
          completedAt: new Date().toISOString(),
        });
        this.logger.info({
          repo: repo.repoFullName,
          prNumber: pr.number,
          headSha: pr.headSha,
          attemptId: attempt.id,
          summary: error.summary,
        }, "Review attempt superseded before Codex execution");
        return;
      }
      if (error instanceof ReviewRunInterruptedError) {
        this.store.updateAttempt(attempt.id, {
          status: "superseded",
          conclusion: "skipped",
          summary: error.message,
          threadId: error.threadId ?? null,
          turnId: error.turnId ?? null,
          externalCheckRunId: null,
          completedAt: new Date().toISOString(),
        });
        this.logger.info({
          repo: repo.repoFullName,
          prNumber: pr.number,
          headSha: pr.headSha,
          attemptId: attempt.id,
          threadId: error.threadId,
          turnId: error.turnId,
          summary: error.message,
        }, "Review attempt interrupted after being superseded");
        return;
      }
      if (error instanceof CodexCapacityError) {
        const pause = this.codexCapacityPause.enter(error);
        // Capacity exhaustion is an account-level condition, not a defect
        // of this PR's review — exempt it from attempt accounting. Mark
        // the attempt cancelled/skipped instead of failed/error so it does
        // not count toward failed-attempt stats or read as a real review
        // failure anywhere, while staying terminal-but-retryable: discovery
        // re-dispatches cancelled attempts once the pause lifts.
        this.store.updateAttempt(attempt.id, {
          status: "cancelled",
          conclusion: "skipped",
          summary: `Codex usage limit; review deferred until ${pause.untilIso}. ${error.detail}`,
          externalCheckRunId: null,
          completedAt: new Date().toISOString(),
        });
        if (pause.entered) {
          this.logger.warn({
            codexLimitedUntil: pause.untilIso,
            retryAtIso: error.retryAtIso ?? null,
            detail: error.detail,
            repo: repo.repoFullName,
            prNumber: pr.number,
          }, `Codex usage limit; pausing reviews until ${pause.untilIso}`);
        } else {
          this.logger.debug({
            codexLimitedUntil: pause.untilIso,
            repo: repo.repoFullName,
            prNumber: pr.number,
          }, "Review attempt hit the Codex usage limit during an active capacity pause");
        }
        return;
      }
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
