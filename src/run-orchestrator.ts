import type { Logger } from "pino";
import type { GitHubAppBotIdentity } from "./github-app-token.ts";
import type { CodexAppServerClient, CodexNotification } from "./codex-app-server.ts";
import type { PatchRelayDatabase } from "./db.ts";
import type { BranchOwner, IssueRecord, RunRecord } from "./db-types.ts";
import { ACTIVE_RUN_STATES, TERMINAL_STATES, type FactoryState, type RunType } from "./factory-state.ts";
import type { OperatorEventFeed } from "./operator-feed.ts";
import { extractTurnId, resolveRunCompletionStatus, summarizeCurrentThread } from "./run-reporting.ts";
import {
  buildRunFailureActivity,
  buildRunStartedActivity,
} from "./linear-session-reporting.ts";
import { WorktreeManager } from "./worktree-manager.ts";
import type {
  AppConfig,
  CodexThreadSummary,
  LinearClientProvider,
} from "./types.ts";
import { resolveAuthoritativeLinearStopState, resolvePreferredCompletedLinearState } from "./linear-workflow.ts";
import { execCommand } from "./utils.ts";
import { getThreadTurns } from "./codex-thread-utils.ts";
import { deriveIssueSessionReactiveIntent } from "./issue-session.ts";
import { QueueHealthMonitor } from "./queue-health-monitor.ts";
import {
  resolveImplementationDeliveryMode,
} from "./prompting/patchrelay.ts";
import type { ImplementationDeliveryMode } from "./prompting/patchrelay.ts";
import { IdleIssueReconciler, resolveBranchOwnerForStateTransition } from "./idle-reconciliation.ts";
import { LinearSessionSync } from "./linear-session-sync.ts";
import { IssueSessionLeaseService } from "./issue-session-lease-service.ts";
import { RunFinalizer } from "./run-finalizer.ts";
import { RunLauncher } from "./run-launcher.ts";
import { RunRecoveryService } from "./run-recovery-service.ts";
import { RunWakePlanner, type PendingRunWake } from "./run-wake-planner.ts";

function lowerCaseFirst(value: string): string {
  return value ? `${value.slice(0, 1).toLowerCase()}${value.slice(1)}` : value;
}

function isRequestedChangesRunType(runType: RunType): boolean {
  return runType === "review_fix" || runType === "branch_upkeep";
}

type RequestedChangesMode = "address_review_feedback" | "branch_upkeep";

function resolveRequestedChangesMode(runType: RunType, context?: Record<string, unknown>): RequestedChangesMode {
  if (runType === "branch_upkeep") {
    return "branch_upkeep";
  }
  return context?.reviewFixMode === "branch_upkeep" || context?.branchUpkeepRequired === true
    ? "branch_upkeep"
    : "address_review_feedback";
}

interface RemotePrState {
  headRefOid?: string;
  state?: string;
  reviewDecision?: string;
  mergeStateStatus?: string;
}

interface PostRunFollowUp {
  pendingRunType: RunType;
  factoryState: FactoryState;
  context?: Record<string, unknown> | undefined;
  summary: string;
}

function isBranchUpkeepRequired(context: Record<string, unknown> | undefined): boolean {
  return context?.branchUpkeepRequired === true;
}

export class RunOrchestrator {
  private readonly worktreeManager: WorktreeManager;
  /** Tracks last probe-failure feed event per issue to avoid spamming the operator feed. */
  private readonly queueHealthMonitor: QueueHealthMonitor;
  private readonly idleReconciler: IdleIssueReconciler;
  readonly linearSync: LinearSessionSync;
  private activeThreadId: string | undefined;
  private readonly workerId = `patchrelay:${process.pid}`;
  private readonly leaseService: IssueSessionLeaseService;
  private readonly runFinalizer: RunFinalizer;
  private readonly runLauncher: RunLauncher;
  private readonly runRecovery: RunRecoveryService;
  private readonly runWakePlanner: RunWakePlanner;
  readonly activeSessionLeases: Map<string, string>;
  botIdentity?: GitHubAppBotIdentity;

  constructor(
    private readonly config: AppConfig,
    private readonly db: PatchRelayDatabase,
    private readonly codex: CodexAppServerClient,
    private readonly linearProvider: LinearClientProvider,
    private readonly enqueueIssue: (projectId: string, issueId: string) => void,
    private readonly logger: Logger,
    private readonly feed?: OperatorEventFeed,
  ) {
    this.worktreeManager = new WorktreeManager(config);
    this.linearSync = new LinearSessionSync(config, db, linearProvider, logger, feed);
    this.leaseService = new IssueSessionLeaseService(
      db,
      logger,
      this.workerId,
      (threadId, maxRetries) => this.readThreadWithRetry(threadId, maxRetries),
    );
    this.activeSessionLeases = this.leaseService.activeSessionLeases;
    this.runFinalizer = new RunFinalizer(db, logger, this.linearSync, this.enqueueIssue, feed);
    this.runLauncher = new RunLauncher(config, db, codex, logger, this.worktreeManager);
    this.runRecovery = new RunRecoveryService(
      db,
      logger,
      this.linearSync,
      (projectId, linearIssueId) => this.releaseIssueSessionLease(projectId, linearIssueId),
      (projectId, issueId) => this.enqueueIssue(projectId, issueId),
      (newState, pendingRunType) => this.resolveBranchOwnerForStateTransition(newState, pendingRunType),
      feed,
    );
    this.runWakePlanner = new RunWakePlanner(db);
    this.idleReconciler = new IdleIssueReconciler(db, config, {
      enqueueIssue: (projectId, issueId) => this.enqueueIssue(projectId, issueId),
    }, logger, feed);
    this.queueHealthMonitor = new QueueHealthMonitor(db, config, {
      advanceIdleIssue: (issue, newState, options) => this.idleReconciler.advanceIdleIssue(issue, newState, options),
      enqueueIssue: (projectId, issueId) => this.enqueueIssue(projectId, issueId),
    }, logger, feed);
  }

  private resolveRunWake(issue: IssueRecord): PendingRunWake | undefined {
    return this.runWakePlanner.resolveRunWake(issue);
  }

  private appendWakeEventWithLease(
    lease: { projectId: string; linearIssueId: string; leaseId: string },
    issue: Pick<IssueRecord, "projectId" | "linearIssueId" | "prHeadSha" | "lastGitHubFailureSignature" | "lastGitHubFailureHeadSha">,
    runType: RunType,
    context?: Record<string, unknown>,
    dedupeScope?: string,
  ): boolean {
    return this.runWakePlanner.appendWakeEventWithLease(lease, issue, runType, context, dedupeScope);
  }

  private materializeLegacyPendingWake(
    issue: IssueRecord,
    lease: { projectId: string; linearIssueId: string; leaseId: string },
  ): IssueRecord {
    return this.runWakePlanner.materializeLegacyPendingWake(issue, lease);
  }

  // ─── Run ────────────────────────────────────────────────────────

  async run(item: { projectId: string; issueId: string }): Promise<void> {
    const project = this.config.projects.find((p) => p.id === item.projectId);
    if (!project) return;

    if (this.leaseService.hasLocalLease(item.projectId, item.issueId)) {
      return;
    }

    const issue = this.db.issues.getIssue(item.projectId, item.issueId);
    if (!issue || issue.activeRunId !== undefined) return;
    const issueSession = this.db.issueSessions.getIssueSession(item.projectId, item.issueId);

    const leaseId = this.leaseService.acquire(item.projectId, item.issueId);
    if (!leaseId) {
      this.logger.info({ issueKey: issue.issueKey, projectId: item.projectId }, "Skipped run because another worker holds the session lease");
      return;
    }

    if (issue.prState === "merged") {
      this.db.issueSessions.upsertIssueWithLease(
        { projectId: issue.projectId, linearIssueId: issue.linearIssueId, leaseId },
        { projectId: issue.projectId, linearIssueId: issue.linearIssueId, pendingRunType: null, factoryState: "done" as never },
      );
      this.leaseService.release(item.projectId, item.issueId);
      return;
    }

    const wakeIssue = this.materializeLegacyPendingWake(issue, { projectId: item.projectId, linearIssueId: item.issueId, leaseId });
    const wake = this.resolveRunWake(wakeIssue);
    if (!wake) {
      this.leaseService.release(item.projectId, item.issueId);
      return;
    }
    const { runType, context, resumeThread } = wake;
    const effectiveContext = isRequestedChangesRunType(runType)
      ? await this.resolveRequestedChangesWakeContext(issue, runType, context, project)
      : context;
    const sourceHeadSha = typeof effectiveContext?.failureHeadSha === "string"
      ? effectiveContext.failureHeadSha
      : typeof effectiveContext?.headSha === "string"
        ? effectiveContext.headSha
        : issue.prHeadSha;
    const budgetExceeded = this.runWakePlanner.budgetExceeded(issue, runType, isRequestedChangesRunType);
    if (budgetExceeded) {
      this.escalate(issue, runType, budgetExceeded);
      return;
    }

    if (!this.runWakePlanner.incrementAttemptCounters(
      issue,
      { projectId: issue.projectId, linearIssueId: issue.linearIssueId, leaseId },
      runType,
      isRequestedChangesRunType,
    )) {
      this.releaseIssueSessionLease(item.projectId, item.issueId);
      return;
    }

    const { prompt, branchName, worktreePath } = this.runLauncher.prepareLaunchPlan({
      project,
      issue,
      runType,
      ...(effectiveContext ? { effectiveContext } : {}),
    });

    const run = this.runLauncher.claimRun({
      item,
      issue,
      leaseId,
      runType,
      prompt,
      ...(sourceHeadSha ? { sourceHeadSha } : {}),
      ...(effectiveContext ? { effectiveContext } : {}),
      materializeLegacyPendingWake: (targetIssue, lease) => this.materializeLegacyPendingWake(targetIssue, lease),
      resolveRunWake: (targetIssue) => this.resolveRunWake(targetIssue),
      branchName,
      worktreePath,
    });
    if (!run) {
      this.releaseIssueSessionLease(item.projectId, item.issueId);
      return;
    }

    this.feed?.publish({
      level: "info",
      kind: "stage",
      issueKey: issue.issueKey,
      projectId: item.projectId,
      stage: runType,
      status: "starting",
      summary: `Starting ${runType} run`,
    });

    const {
      threadId,
      turnId,
      parentThreadId,
    } = await this.runLauncher.launchTurn({
      project,
      issue,
      ...(issueSession ? { issueSession } : {}),
      run,
      runType,
      prompt,
      branchName,
      worktreePath,
      resumeThread,
      ...(effectiveContext ? { effectiveContext } : {}),
      leaseId,
      ...(this.botIdentity ? { botIdentity: this.botIdentity } : {}),
      assertLaunchLease: (targetRun, phase) => this.assertLaunchLease(targetRun, phase),
      resetWorktreeToTrackedBranch: (targetWorktreePath, targetBranchName, targetIssue) =>
        this.resetWorktreeToTrackedBranch(targetWorktreePath, targetBranchName, targetIssue),
      freshenWorktree: (targetWorktreePath, targetProject, targetIssue) =>
        this.freshenWorktree(targetWorktreePath, targetProject, targetIssue),
      linearSync: this.linearSync,
      releaseLease: (projectId, issueId) => this.releaseIssueSessionLease(projectId, issueId),
      isRequestedChangesRunType,
      lowerCaseFirst,
    });

    this.assertLaunchLease(run, "before recording the active thread");
    if (!this.db.issueSessions.updateRunThreadWithLease(
      { projectId: run.projectId, linearIssueId: run.linearIssueId, leaseId },
      run.id,
      { threadId, turnId, ...(parentThreadId ? { parentThreadId } : {}) },
    )) {
      this.logger.warn({ runId: run.id, issueId: run.linearIssueId }, "Skipping run thread update after losing issue-session lease");
      this.releaseIssueSessionLease(run.projectId, run.linearIssueId);
      return;
    }

    // Reset zombie recovery counter — this run started successfully
    if (issue.zombieRecoveryAttempts > 0) {
      this.db.issueSessions.upsertIssueWithLease(
        { projectId: item.projectId, linearIssueId: item.issueId, leaseId },
        {
          projectId: item.projectId,
          linearIssueId: item.issueId,
          zombieRecoveryAttempts: 0,
          lastZombieRecoveryAt: null,
        },
      );
    }

    this.logger.info(
      { issueKey: issue.issueKey, runType, threadId, turnId },
      `Started ${runType} run`,
    );

    // Emit Linear activity + plan
    const freshIssue = this.db.issues.getIssue(item.projectId, item.issueId) ?? issue;
    void this.linearSync.emitActivity(freshIssue, buildRunStartedActivity(runType));
    void this.linearSync.syncSession(freshIssue, { activeRunType: runType });
  }

  // ─── Pre-run branch freshening ────────────────────────────────────

  /**
   * Fetch origin and rebase the worktree onto the latest base branch.
   *
   * Risks mitigated:
   * - Dirty worktree from interrupted run → stash before, pop after
   * - Conflicts → abort rebase, throw so the run fails with a clear reason
   * - Already up-to-date → no-op
   * - Keep publishing explicit: the orchestrator updates the local worktree
   *   only; the agent/run owns any later branch push.
   */
  private async freshenWorktree(
    worktreePath: string,
    project: { github?: { baseBranch?: string }; repoPath: string },
    issue: IssueRecord,
  ): Promise<void> {
    const gitBin = this.config.runner.gitBin;
    const baseBranch = project.github?.baseBranch ?? "main";

    // Stash any uncommitted changes from a previous interrupted run
    const stashResult = await execCommand(gitBin, ["-C", worktreePath, "stash"], { timeoutMs: 30_000 });
    const didStash = stashResult.exitCode === 0 && !stashResult.stdout?.includes("No local changes");

    // Fetch latest base
    const fetchResult = await execCommand(gitBin, ["-C", worktreePath, "fetch", "origin", baseBranch], { timeoutMs: 60_000 });
    if (fetchResult.exitCode !== 0) {
      this.logger.warn({ issueKey: issue.issueKey, stderr: fetchResult.stderr?.slice(0, 300) }, "Pre-run fetch failed, proceeding with current base");
      if (didStash) await execCommand(gitBin, ["-C", worktreePath, "stash", "pop"], { timeoutMs: 10_000 });
      return;
    }

    // Check if rebase is needed: is HEAD already on top of origin/baseBranch?
    const mergeBaseResult = await execCommand(gitBin, ["-C", worktreePath, "merge-base", "--is-ancestor", `origin/${baseBranch}`, "HEAD"], { timeoutMs: 10_000 });
    if (mergeBaseResult.exitCode === 0) {
      // Already up-to-date — no rebase needed
      this.logger.debug({ issueKey: issue.issueKey }, "Pre-run freshen: branch already up to date");
      if (didStash) await execCommand(gitBin, ["-C", worktreePath, "stash", "pop"], { timeoutMs: 10_000 });
      return;
    }

    // Rebase onto latest base
    const rebaseResult = await execCommand(gitBin, ["-C", worktreePath, "rebase", `origin/${baseBranch}`], { timeoutMs: 120_000 });
    if (rebaseResult.exitCode !== 0) {
      // Abort the failed rebase and restore state — then let the agent run
      // proceed. The agent can resolve the conflict itself (the workflow
      // prompt tells it to rebase and handle conflicts).
      await execCommand(gitBin, ["-C", worktreePath, "rebase", "--abort"], { timeoutMs: 10_000 });
      if (didStash) await execCommand(gitBin, ["-C", worktreePath, "stash", "pop"], { timeoutMs: 10_000 });
      this.logger.warn({ issueKey: issue.issueKey, baseBranch }, "Pre-run freshen: rebase conflict, agent will resolve");
      return;
    }

    this.logger.info({ issueKey: issue.issueKey, baseBranch }, "Pre-run freshen: rebased locally onto latest base");

    // Restore stashed changes
    if (didStash) await execCommand(gitBin, ["-C", worktreePath, "stash", "pop"], { timeoutMs: 10_000 });
  }

  private async resetWorktreeToTrackedBranch(
    worktreePath: string,
    branchName: string,
    issue: Pick<IssueRecord, "issueKey">,
  ): Promise<void> {
    const gitBin = this.config.runner.gitBin;
    const branchFetch = await execCommand(gitBin, ["-C", worktreePath, "fetch", "origin", branchName], { timeoutMs: 60_000 });
    const hasRemoteBranch = branchFetch.exitCode === 0;

    await execCommand(gitBin, ["-C", worktreePath, "rebase", "--abort"], { timeoutMs: 10_000 });
    await execCommand(gitBin, ["-C", worktreePath, "merge", "--abort"], { timeoutMs: 10_000 });
    await execCommand(gitBin, ["-C", worktreePath, "cherry-pick", "--abort"], { timeoutMs: 10_000 });
    await execCommand(gitBin, ["-C", worktreePath, "am", "--abort"], { timeoutMs: 10_000 });
    await execCommand(gitBin, ["-C", worktreePath, "reset", "--hard", "HEAD"], { timeoutMs: 30_000 });
    await execCommand(gitBin, ["-C", worktreePath, "clean", "-fd"], { timeoutMs: 30_000 });

    const checkoutTarget = hasRemoteBranch ? `origin/${branchName}` : branchName;
    const checkoutResult = await execCommand(
      gitBin,
      ["-C", worktreePath, "checkout", "-B", branchName, checkoutTarget],
      { timeoutMs: 30_000 },
    );
    if (checkoutResult.exitCode !== 0) {
      throw new Error(
        `Failed to restore ${branchName} worktree state: ${checkoutResult.stderr?.slice(0, 300) ?? "git checkout failed"}`,
      );
    }

    const resetTarget = hasRemoteBranch ? `origin/${branchName}` : "HEAD";
    const resetResult = await execCommand(gitBin, ["-C", worktreePath, "reset", "--hard", resetTarget], { timeoutMs: 30_000 });
    if (resetResult.exitCode !== 0) {
      throw new Error(
        `Failed to reset ${branchName} worktree state: ${resetResult.stderr?.slice(0, 300) ?? "git reset failed"}`,
      );
    }

    await execCommand(gitBin, ["-C", worktreePath, "clean", "-fd"], { timeoutMs: 30_000 });
    this.logger.debug({ issueKey: issue.issueKey, branchName, hasRemoteBranch }, "Reset issue worktree to tracked branch state");
  }

  private async restoreIdleWorktree(
    issue: Pick<IssueRecord, "issueKey" | "worktreePath" | "branchName">,
  ): Promise<void> {
    if (!issue.worktreePath || !issue.branchName) return;
    try {
      await this.resetWorktreeToTrackedBranch(issue.worktreePath, issue.branchName, issue);
    } catch (error) {
      this.logger.warn(
        {
          issueKey: issue.issueKey,
          branchName: issue.branchName,
          worktreePath: issue.worktreePath,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to restore idle worktree after interrupted run",
      );
    }
  }

  // ─── Notification handler ─────────────────────────────────────────

  async handleCodexNotification(notification: CodexNotification): Promise<void> {
    // threadId is present on turn-level notifications but NOT on item-level ones.
    // Fall back to the tracked active thread for item/delta notifications.
    let threadId = typeof notification.params.threadId === "string" ? notification.params.threadId : undefined;
    if (!threadId) {
      threadId = this.activeThreadId;
    }
    if (!threadId) return;

    // Track the active thread from turn/started so item notifications can find it
    if (notification.method === "turn/started" && threadId) {
      this.activeThreadId = threadId;
    }

    const run = this.db.runs.getRunByThreadId(threadId);
    if (!run) return;
    if (!this.heartbeatIssueSessionLease(run.projectId, run.linearIssueId)) {
      this.logger.warn({ runId: run.id, issueId: run.linearIssueId }, "Ignoring Codex notification after losing issue-session lease");
      return;
    }

    const turnId = typeof notification.params.turnId === "string" ? notification.params.turnId : undefined;
    if (this.config.runner.codex.persistExtendedHistory) {
      this.db.runs.saveThreadEvent({
        runId: run.id,
        threadId,
        ...(turnId ? { turnId } : {}),
        method: notification.method,
        eventJson: JSON.stringify(notification.params),
      });
    }

    // Emit ephemeral progress activity to Linear for notable in-flight events
    this.linearSync.maybeEmitProgress(notification, run);

    // Sync codex plan to Linear session when it updates
    if (notification.method === "turn/plan/updated") {
      const issue = this.db.issues.getIssue(run.projectId, run.linearIssueId);
      if (issue) {
        void this.linearSync.syncCodexPlan(issue, notification.params);
      }
    }

    if (notification.method !== "turn/completed") return;

    const thread = await this.readThreadWithRetry(threadId);
    const issue = this.db.issues.getIssue(run.projectId, run.linearIssueId);
    if (!issue) return;

    const completedTurnId = extractTurnId(notification.params);
    const status = resolveRunCompletionStatus(notification.params);

    if (status === "failed") {
      const nextState: FactoryState = isRequestedChangesRunType(run.runType) ? "escalated" : "failed";
      const updated = this.withHeldIssueSessionLease(run.projectId, run.linearIssueId, (lease) => {
        this.db.issueSessions.finishRunWithLease(lease, run.id, {
          status: "failed",
          threadId,
          ...(completedTurnId ? { turnId: completedTurnId } : {}),
          failureReason: "Codex reported the turn completed in a failed state",
        });
        this.db.issueSessions.upsertIssueWithLease(lease, {
          projectId: run.projectId,
          linearIssueId: run.linearIssueId,
          activeRunId: null,
          factoryState: nextState,
        });
        return true;
      });
      if (!updated) {
        this.logger.warn({ runId: run.id, issueId: run.linearIssueId }, "Skipping failed-turn cleanup after losing issue-session lease");
        this.releaseIssueSessionLease(run.projectId, run.linearIssueId);
        return;
      }
      this.feed?.publish({
        level: "error",
        kind: "turn",
        issueKey: issue.issueKey,
        projectId: run.projectId,
        stage: run.runType,
        status: "failed",
        summary: `Turn failed for ${run.runType}`,
      });
      const failedIssue = this.db.issues.getIssue(run.projectId, run.linearIssueId) ?? issue;
      void this.linearSync.emitActivity(failedIssue, buildRunFailureActivity(run.runType));
      void this.linearSync.syncSession(failedIssue, { activeRunType: run.runType });
      this.linearSync.clearProgress(run.id);
      this.activeThreadId = undefined;
      this.releaseIssueSessionLease(run.projectId, run.linearIssueId);
      return;
    }

    await this.runFinalizer.finalizeCompletedRun({
      source: "notification",
      run,
      issue,
      thread,
      threadId,
      ...(completedTurnId ? { completedTurnId } : {}),
      withHeldLease: (projectId, linearIssueId, fn) => this.withHeldIssueSessionLease(projectId, linearIssueId, fn),
      releaseLease: (projectId, linearIssueId) => this.releaseIssueSessionLease(projectId, linearIssueId),
      failRunAndClear: (targetRun, message, nextState) => this.failRunAndClear(targetRun, message, nextState),
      verifyReactiveRunAdvancedBranch: (targetRun, targetIssue) => this.verifyReactiveRunAdvancedBranch(targetRun, targetIssue),
      verifyReviewFixAdvancedHead: (targetRun, targetIssue) => this.verifyReviewFixAdvancedHead(targetRun, targetIssue),
      verifyPublishedRunOutcome: (targetRun, targetIssue) => this.verifyPublishedRunOutcome(targetRun, targetIssue),
      refreshIssueAfterReactivePublish: (targetRun, targetIssue) => this.refreshIssueAfterReactivePublish(targetRun, targetIssue),
      resolvePostRunFollowUp: (targetRun, targetIssue) => this.resolvePostRunFollowUp(targetRun, targetIssue),
      resolveCompletedRunState,
      resolveRecoverableRunState: resolveRecoverablePostRunState,
      appendWakeEventWithLease: (lease, targetIssue, runType, context, dedupeScope) =>
        this.appendWakeEventWithLease(lease, targetIssue, runType, context, dedupeScope),
    });
    this.activeThreadId = undefined;
  }

  // ─── Active status for query ──────────────────────────────────────

  async getActiveRunStatus(issueKey: string) {
    const issue = this.db.issues.getIssueByKey(issueKey);
    if (!issue?.activeRunId) return undefined;

    const run = this.db.runs.getRunById(issue.activeRunId);
    if (!run?.threadId) return undefined;

    const trackedIssue = this.db.issueToTrackedIssue(issue);
    const thread = await this.codex.readThread(run.threadId, true).catch(() => undefined);

    return {
      issue: trackedIssue,
      run,
      ...(thread ? { liveThread: summarizeCurrentThread(thread) } : {}),
    };
  }

  // ─── Reconciliation ───────────────────────────────────────────────

  async reconcileActiveRuns(): Promise<void> {
    for (const run of this.db.runs.listRunningRuns()) {
      await this.reconcileRun(run);
    }
    // Preemptively detect stuck merge-queue PRs (conflicts visible on
    // GitHub) and dispatch queue_repair before the Steward evicts.
    await this.queueHealthMonitor.reconcile();
    // Advance issues stuck in pr_open whose stored PR metadata already
    // shows they should transition (e.g. approved PR, missed webhook).
    await this.idleReconciler.reconcile();
    await this.reconcileMergedLinearCompletion();
  }

  private async reconcileMergedLinearCompletion(): Promise<void> {
    for (const issue of this.db.issues.listIssues()) {
      if (issue.prState !== "merged") continue;
      if (issue.currentLinearStateType?.trim().toLowerCase() === "completed") continue;

      const linear = await this.linearProvider.forProject(issue.projectId).catch(() => undefined);
      if (!linear) continue;

      try {
        const liveIssue = await linear.getIssue(issue.linearIssueId);
        const targetState = resolvePreferredCompletedLinearState(liveIssue);
        if (!targetState) continue;

        const normalizedCurrent = liveIssue.stateName?.trim().toLowerCase();
        if (normalizedCurrent === targetState.trim().toLowerCase()) {
          this.db.issues.upsertIssue({
            projectId: issue.projectId,
            linearIssueId: issue.linearIssueId,
            ...(liveIssue.stateName ? { currentLinearState: liveIssue.stateName } : {}),
            ...(liveIssue.stateType ? { currentLinearStateType: liveIssue.stateType } : {}),
          });
          continue;
        }

        const updated = await linear.setIssueState(issue.linearIssueId, targetState);
        this.db.issues.upsertIssue({
          projectId: issue.projectId,
          linearIssueId: issue.linearIssueId,
          ...(updated.stateName ? { currentLinearState: updated.stateName } : {}),
          ...(updated.stateType ? { currentLinearStateType: updated.stateType } : {}),
        });
      } catch (error) {
        this.logger.warn(
          { issueKey: issue.issueKey, error: error instanceof Error ? error.message : String(error) },
          "Failed to reconcile merged issue to a completed Linear state",
        );
      }
    }
  }

  // advanceIdleIssue is now on IdleIssueReconciler — delegate for internal callers
  private advanceIdleIssue(
    issue: IssueRecord,
    newState: FactoryState,
    options?: {
      pendingRunType?: RunType;
      pendingRunContext?: Record<string, unknown>;
      clearFailureProvenance?: boolean;
    },
  ): void {
    this.idleReconciler.advanceIdleIssue(issue, newState, options);
  }

  /**
   * After a zombie/stale run is cleared, decide whether to re-enqueue
   * or escalate. Checks: PR already merged → done; budget exhausted →
   * escalate; backoff delay not elapsed → skip.
   */
  private recoverOrEscalate(issue: IssueRecord, runType: RunType, reason: string): void {
    this.runRecovery.recoverOrEscalate({
      issue,
      runType,
      reason,
      isRequestedChangesRunType,
      withHeldLease: (projectId, linearIssueId, fn) => this.withHeldIssueSessionLease(projectId, linearIssueId, fn),
      appendWakeEventWithLease: (lease, targetIssue, pendingRunType, context, dedupeScope) =>
        this.appendWakeEventWithLease(lease, targetIssue, pendingRunType, context, dedupeScope),
    });
  }

  private async reconcileRun(run: RunRecord): Promise<void> {
    const issue = this.db.issues.getIssue(run.projectId, run.linearIssueId);
    if (!issue) return;
    let recoveryLease = this.claimLeaseForReconciliation(run.projectId, run.linearIssueId);
    if (recoveryLease === "skip" && await this.reclaimForeignRecoveryLeaseIfSafe(run, issue)) {
      recoveryLease = true;
    }
    if (recoveryLease === "skip") return;
    const acquiredRecoveryLease = recoveryLease === true;

    // If the issue reached a terminal state while this run was active
    // (e.g. pr_merged processed, DB manually edited), just release the run.
    if (TERMINAL_STATES.has(issue.factoryState)) {
      this.withHeldIssueSessionLease(run.projectId, run.linearIssueId, () => {
        this.db.runs.finishRun(run.id, { status: "released", failureReason: "Issue reached terminal state during active run" });
        this.db.issues.upsertIssue({ projectId: run.projectId, linearIssueId: run.linearIssueId, activeRunId: null });
      });
      this.logger.info({ issueKey: issue.issueKey, runId: run.id, factoryState: issue.factoryState }, "Reconciliation: released run on terminal issue");
      const releasedIssue = this.db.issues.getIssue(run.projectId, run.linearIssueId) ?? issue;
      void this.linearSync.syncSession(releasedIssue, { activeRunType: run.runType });
      this.releaseIssueSessionLease(run.projectId, run.linearIssueId);
      return;
    }

    // Zombie run: claimed in DB but Codex never started (no thread).
    if (!run.threadId) {
      this.logger.warn(
        { issueKey: issue.issueKey, runId: run.id, runType: run.runType },
        "Zombie run detected (no thread)",
      );
      this.withHeldIssueSessionLease(run.projectId, run.linearIssueId, () => {
        this.db.runs.finishRun(run.id, { status: "failed", failureReason: "Zombie: never started (no thread after restart)" });
        this.db.issues.upsertIssue({ projectId: run.projectId, linearIssueId: run.linearIssueId, activeRunId: null });
      });
      this.recoverOrEscalate(issue, run.runType, "zombie");
      const recoveredIssue = this.db.issues.getIssue(run.projectId, run.linearIssueId) ?? issue;
      void this.linearSync.emitActivity(recoveredIssue, buildRunFailureActivity(run.runType, "The Codex turn never started before PatchRelay restarted."));
      void this.linearSync.syncSession(recoveredIssue, { activeRunType: run.runType });
      this.releaseIssueSessionLease(run.projectId, run.linearIssueId);
      return;
    }

    // Read Codex state — thread may not exist after app-server restart.
    let thread: CodexThreadSummary | undefined;
    try {
      thread = await this.readThreadWithRetry(run.threadId);
    } catch {
      this.logger.warn(
        { issueKey: issue.issueKey, runId: run.id, runType: run.runType, threadId: run.threadId },
        "Stale thread during reconciliation",
      );
      this.withHeldIssueSessionLease(run.projectId, run.linearIssueId, () => {
        this.db.runs.finishRun(run.id, { status: "failed", failureReason: "Stale thread after restart" });
        this.db.issues.upsertIssue({ projectId: run.projectId, linearIssueId: run.linearIssueId, activeRunId: null });
      });
      this.recoverOrEscalate(issue, run.runType, "stale_thread");
      const recoveredIssue = this.db.issues.getIssue(run.projectId, run.linearIssueId) ?? issue;
      void this.linearSync.emitActivity(recoveredIssue, buildRunFailureActivity(run.runType, "PatchRelay lost the active Codex thread after restart and needs to recover."));
      void this.linearSync.syncSession(recoveredIssue, { activeRunType: run.runType });
      this.releaseIssueSessionLease(run.projectId, run.linearIssueId);
      return;
    }

    // Check Linear state (non-fatal — token refresh may fail)
    const linear = await this.linearProvider.forProject(run.projectId).catch(() => undefined);
    if (linear) {
      const linearIssue = await linear.getIssue(run.linearIssueId).catch(() => undefined);
      if (linearIssue) {
        const stopState = resolveAuthoritativeLinearStopState(linearIssue);
        if (stopState?.isFinal) {
          this.withHeldIssueSessionLease(run.projectId, run.linearIssueId, () => {
            this.db.runs.finishRun(run.id, { status: "released" });
            this.db.issues.upsertIssue({
              projectId: run.projectId,
              linearIssueId: run.linearIssueId,
              activeRunId: null,
              currentLinearState: stopState.stateName,
              factoryState: "done",
            });
          });
          this.feed?.publish({
            level: "info",
            kind: "stage",
            issueKey: issue.issueKey,
            projectId: run.projectId,
            stage: "done",
            status: "reconciled",
            summary: `Linear state ${stopState.stateName} \u2192 done`,
          });
          const doneIssue = this.db.issues.getIssue(run.projectId, run.linearIssueId) ?? issue;
          void this.linearSync.syncSession(doneIssue, { activeRunType: run.runType });
          this.releaseIssueSessionLease(run.projectId, run.linearIssueId);
          return;
        }
      }
    }

    const latestTurn = getThreadTurns(thread).at(-1);

    // Handle interrupted turn — fail the run rather than retrying indefinitely.
    // The agent may have partially completed work (commits, PR) before interruption.
    // Reactive loops (CI repair, review fix) will handle follow-up if needed.
    if (latestTurn?.status === "interrupted") {
      this.logger.warn(
        { issueKey: issue.issueKey, runType: run.runType, threadId: run.threadId },
        "Run has interrupted turn — marking as failed",
      );
      // Interrupted runs are not real failures — undo the budget increment.
      const repairedCounters = this.withHeldIssueSessionLease(issue.projectId, issue.linearIssueId, (lease) => {
        if (run.runType === "ci_repair" && issue.ciRepairAttempts > 0) {
          this.db.issueSessions.upsertIssueWithLease(lease, {
            projectId: issue.projectId,
            linearIssueId: issue.linearIssueId,
            ciRepairAttempts: issue.ciRepairAttempts - 1,
          });
        } else if (run.runType === "queue_repair" && issue.queueRepairAttempts > 0) {
          this.db.issueSessions.upsertIssueWithLease(lease, {
            projectId: issue.projectId,
            linearIssueId: issue.linearIssueId,
            queueRepairAttempts: issue.queueRepairAttempts - 1,
          });
        }
        if (run.runType === "ci_repair" || run.runType === "queue_repair") {
          this.db.issueSessions.upsertIssueWithLease(lease, {
            projectId: issue.projectId,
            linearIssueId: issue.linearIssueId,
            lastAttemptedFailureHeadSha: null,
            lastAttemptedFailureSignature: null,
          });
        }
        return true;
      });
      if (!repairedCounters) {
        this.logger.warn({ runId: run.id, issueId: run.linearIssueId }, "Skipping interrupted-run recovery after losing issue-session lease");
        this.releaseIssueSessionLease(run.projectId, run.linearIssueId);
        return;
      }
      if (isRequestedChangesRunType(run.runType)) {
        const refreshedIssue = await this.refreshIssueAfterReactivePublish(run, this.db.issues.getIssue(run.projectId, run.linearIssueId) ?? issue);
        const project = this.config.projects.find((entry) => entry.id === run.projectId);
        const retryContext = project
          ? await this.resolveRequestedChangesWakeContext(
              refreshedIssue,
              run.runType,
              run.runType === "branch_upkeep"
                ? {
                    branchUpkeepRequired: true,
                    reviewFixMode: "branch_upkeep",
                    wakeReason: "branch_upkeep",
                  }
                : undefined,
              project,
            )
          : undefined;
        const retryRunType = resolveRequestedChangesMode(run.runType, retryContext) === "branch_upkeep"
          ? "branch_upkeep"
          : "review_fix";
        const recoveredState = resolveRecoverablePostRunState(refreshedIssue) ?? "failed";
        const interruptedMessage = "Requested-changes run was interrupted before PatchRelay could verify that a new PR head was published";
        this.failRunAndClear(run, interruptedMessage, recoveredState);
        await this.restoreIdleWorktree(issue);
        const recoveredIssue = this.db.issues.getIssue(run.projectId, run.linearIssueId) ?? refreshedIssue;
        if (recoveredState === "changes_requested") {
          this.db.issues.upsertIssue({
            projectId: run.projectId,
            linearIssueId: run.linearIssueId,
            pendingRunType: retryRunType,
            pendingRunContextJson: retryContext ? JSON.stringify(retryContext) : null,
          });
          this.feed?.publish({
            level: "warn",
            kind: "workflow",
            issueKey: issue.issueKey,
            projectId: run.projectId,
            stage: run.runType,
            status: "retry_queued",
            summary: "Requested-changes run was interrupted; PatchRelay will retry from fresh GitHub truth",
          });
          this.enqueueIssue(run.projectId, run.linearIssueId);
        } else {
          this.feed?.publish({
            level: "error",
            kind: "workflow",
            issueKey: issue.issueKey,
            projectId: run.projectId,
            stage: run.runType,
            status: "escalated",
            summary: interruptedMessage,
          });
        }
        void this.linearSync.emitActivity(recoveredIssue, buildRunFailureActivity(run.runType, interruptedMessage));
        void this.linearSync.syncSession(recoveredIssue, { activeRunType: run.runType });
        this.releaseIssueSessionLease(run.projectId, run.linearIssueId);
        return;
      }
      const recoveredState = resolveRecoverablePostRunState(this.db.issues.getIssue(run.projectId, run.linearIssueId) ?? issue);
      this.failRunAndClear(run, "Codex turn was interrupted", recoveredState);
      await this.restoreIdleWorktree(issue);
      const failedIssue = this.db.issues.getIssue(run.projectId, run.linearIssueId) ?? issue;
      if (recoveredState) {
        this.feed?.publish({
          level: "info",
          kind: "stage",
          issueKey: issue.issueKey,
          projectId: run.projectId,
          stage: recoveredState,
          status: "reconciled",
          summary: `Interrupted ${run.runType} recovered \u2192 ${recoveredState}`,
        });
      } else {
        void this.linearSync.emitActivity(failedIssue, buildRunFailureActivity(run.runType, "The Codex turn was interrupted."));
      }
      void this.linearSync.syncSession(failedIssue, { activeRunType: run.runType });
      this.releaseIssueSessionLease(run.projectId, run.linearIssueId);
      return;
    }

    // Handle completed turn discovered during reconciliation
    if (latestTurn?.status === "completed") {
      await this.runFinalizer.finalizeCompletedRun({
        source: "reconciliation",
        run,
        issue,
        thread,
        threadId: run.threadId,
        ...(latestTurn.id ? { completedTurnId: latestTurn.id } : {}),
        withHeldLease: (projectId, linearIssueId, fn) => this.withHeldIssueSessionLease(projectId, linearIssueId, fn),
        releaseLease: (projectId, linearIssueId) => this.releaseIssueSessionLease(projectId, linearIssueId),
        failRunAndClear: (targetRun, message, nextState) => this.failRunAndClear(targetRun, message, nextState),
        verifyReactiveRunAdvancedBranch: (targetRun, targetIssue) => this.verifyReactiveRunAdvancedBranch(targetRun, targetIssue),
        verifyReviewFixAdvancedHead: (targetRun, targetIssue) => this.verifyReviewFixAdvancedHead(targetRun, targetIssue),
        verifyPublishedRunOutcome: (targetRun, targetIssue) => this.verifyPublishedRunOutcome(targetRun, targetIssue),
        refreshIssueAfterReactivePublish: (targetRun, targetIssue) => this.refreshIssueAfterReactivePublish(targetRun, targetIssue),
        resolvePostRunFollowUp: (targetRun, targetIssue) => this.resolvePostRunFollowUp(targetRun, targetIssue),
        resolveCompletedRunState,
        resolveRecoverableRunState: resolveRecoverablePostRunState,
        appendWakeEventWithLease: (lease, targetIssue, runType, context, dedupeScope) =>
          this.appendWakeEventWithLease(lease, targetIssue, runType, context, dedupeScope),
      });
      return;
    }

    if (acquiredRecoveryLease) this.releaseIssueSessionLease(run.projectId, run.linearIssueId);
  }

  // ─── Internal helpers ─────────────────────────────────────────────

  private escalate(issue: IssueRecord, runType: string, reason: string): void {
    this.runRecovery.escalate({
      issue,
      runType,
      reason,
      withHeldLease: (projectId, linearIssueId, fn) => this.withHeldIssueSessionLease(projectId, linearIssueId, fn),
    });
  }

  private failRunAndClear(run: RunRecord, message: string, nextState: FactoryState = "failed"): void {
    this.runRecovery.failRunAndClear({
      run,
      message,
      nextState,
      withHeldLease: (projectId, linearIssueId, fn) => this.withHeldIssueSessionLease(projectId, linearIssueId, fn),
      getHeldLease: (projectId, linearIssueId) => this.getHeldIssueSessionLease(projectId, linearIssueId),
    });
  }

  private resolveBranchOwnerForStateTransition(newState: FactoryState, pendingRunType?: RunType): BranchOwner | undefined {
    return resolveBranchOwnerForStateTransition(newState, pendingRunType);
  }

  private async verifyReactiveRunAdvancedBranch(run: RunRecord, issue: IssueRecord): Promise<string | undefined> {
    if (run.runType !== "ci_repair" && run.runType !== "queue_repair") {
      return undefined;
    }
    if (!issue.prNumber || issue.prState !== "open" || !issue.lastGitHubFailureHeadSha) {
      return undefined;
    }
    const project = this.config.projects.find((entry) => entry.id === run.projectId);
    if (!project?.github?.repoFullName) {
      return undefined;
    }
    try {
      const pr = await this.loadRemotePrState(project.github.repoFullName, issue.prNumber);
      if (!pr || pr.state?.toUpperCase() !== "OPEN") return undefined;
      if (!pr.headRefOid || pr.headRefOid !== issue.lastGitHubFailureHeadSha) return undefined;
      return `Repair finished but PR #${issue.prNumber} is still on failing head ${issue.lastGitHubFailureHeadSha.slice(0, 8)}`;
    } catch (error) {
      this.logger.debug({
        issueKey: issue.issueKey,
        prNumber: issue.prNumber,
        error: error instanceof Error ? error.message : String(error),
      }, "Failed to verify PR head advancement after repair");
      return undefined;
    }
  }

  private async verifyReviewFixAdvancedHead(run: RunRecord, issue: IssueRecord): Promise<string | undefined> {
    if (!isRequestedChangesRunType(run.runType)) {
      return undefined;
    }
    if (!issue.prNumber || issue.prState !== "open") {
      return undefined;
    }
    if (!run.sourceHeadSha) {
      return `Requested-changes run finished for PR #${issue.prNumber} without a recorded starting head SHA. PatchRelay cannot verify that a new head was published.`;
    }
    const project = this.config.projects.find((entry) => entry.id === run.projectId);
    if (!project?.github?.repoFullName) {
      return undefined;
    }
    try {
      const pr = await this.loadRemotePrState(project.github.repoFullName, issue.prNumber);
      if (!pr || pr.state?.toUpperCase() !== "OPEN") return undefined;
      if (!pr.headRefOid) {
        return `Requested-changes run finished for PR #${issue.prNumber} but GitHub did not report a current head SHA.`;
      }
      if (pr.headRefOid === run.sourceHeadSha) {
        return `Requested-changes run finished for PR #${issue.prNumber} without pushing a new head; PatchRelay must not hand the same SHA back to review.`;
      }
      return undefined;
    } catch (error) {
      this.logger.debug({
        issueKey: issue.issueKey,
        prNumber: issue.prNumber,
        error: error instanceof Error ? error.message : String(error),
      }, "Failed to verify PR head advancement after requested-changes work");
      return undefined;
    }
  }

  private async refreshIssueAfterReactivePublish(run: RunRecord, issue: IssueRecord): Promise<IssueRecord> {
    if (run.runType !== "ci_repair" && run.runType !== "queue_repair" && !isRequestedChangesRunType(run.runType)) {
      return this.db.issues.getIssue(run.projectId, run.linearIssueId) ?? issue;
    }
    if (!issue.prNumber) {
      return this.db.issues.getIssue(run.projectId, run.linearIssueId) ?? issue;
    }
    const project = this.config.projects.find((entry) => entry.id === run.projectId);
    const repoFullName = project?.github?.repoFullName;
    if (!repoFullName) {
      return this.db.issues.getIssue(run.projectId, run.linearIssueId) ?? issue;
    }

    try {
      const pr = await this.loadRemotePrState(repoFullName, issue.prNumber);
      if (!pr) {
        return this.db.issues.getIssue(run.projectId, run.linearIssueId) ?? issue;
      }

      const nextPrState = normalizeRemotePrState(pr.state);
      const nextReviewState = normalizeRemoteReviewDecision(pr.reviewDecision);
      const gateCheckName = project?.gateChecks?.find((entry) => entry.trim())?.trim() ?? "verify";
      const headAdvanced = Boolean(pr.headRefOid && pr.headRefOid !== issue.lastGitHubFailureHeadSha);
      const reviewFixHeadAdvanced = isRequestedChangesRunType(run.runType)
        && Boolean(pr.headRefOid && run.sourceHeadSha && pr.headRefOid !== run.sourceHeadSha);

      this.upsertIssueIfLeaseHeld(
        run.projectId,
        run.linearIssueId,
        {
        projectId: run.projectId,
        linearIssueId: run.linearIssueId,
        ...(nextPrState ? { prState: nextPrState } : {}),
        ...(pr.headRefOid ? { prHeadSha: pr.headRefOid } : {}),
        ...(nextReviewState ? { prReviewState: nextReviewState } : {}),
        ...((headAdvanced || reviewFixHeadAdvanced)
          ? {
              prCheckStatus: "pending",
              lastGitHubFailureSource: null,
              lastGitHubFailureHeadSha: null,
              lastGitHubFailureSignature: null,
              lastGitHubFailureCheckName: null,
              lastGitHubFailureCheckUrl: null,
              lastGitHubFailureContextJson: null,
              lastGitHubFailureAt: null,
              lastQueueIncidentJson: null,
              lastAttemptedFailureHeadSha: null,
              lastAttemptedFailureSignature: null,
              lastGitHubCiSnapshotHeadSha: pr.headRefOid ?? null,
              lastGitHubCiSnapshotGateCheckName: gateCheckName,
              lastGitHubCiSnapshotGateCheckStatus: "pending",
              lastGitHubCiSnapshotJson: null,
              lastGitHubCiSnapshotSettledAt: null,
            }
          : {}),
        },
        "reactive publish refresh",
      );
    } catch (error) {
      this.logger.debug({
        issueKey: issue.issueKey,
        prNumber: issue.prNumber,
        error: error instanceof Error ? error.message : String(error),
      }, "Failed to refresh PR state after reactive publish");
    }

    return this.db.issues.getIssue(run.projectId, run.linearIssueId) ?? issue;
  }

  private async loadRemotePrState(
    repoFullName: string,
    prNumber: number,
  ): Promise<RemotePrState | undefined> {
    const { stdout, exitCode } = await execCommand("gh", [
      "pr", "view", String(prNumber),
      "--repo", repoFullName,
      "--json", "headRefOid,state,reviewDecision,mergeStateStatus",
    ], { timeoutMs: 10_000 });
    if (exitCode !== 0) return undefined;
    return JSON.parse(stdout) as RemotePrState;
  }

  private async resolveRequestedChangesWakeContext(
    issue: IssueRecord,
    runType: RunType,
    context: Record<string, unknown> | undefined,
    project: { github?: { repoFullName?: string; baseBranch?: string } },
  ): Promise<Record<string, unknown> | undefined> {
    if (runType === "branch_upkeep" || isBranchUpkeepRequired(context)) {
      return context;
    }
    if (!issue.prNumber || issue.prState !== "open" || issue.prReviewState !== "changes_requested") {
      return context;
    }

    const repoFullName = project.github?.repoFullName;
    if (!repoFullName) {
      return context;
    }

    try {
      const pr = await this.loadRemotePrState(repoFullName, issue.prNumber);
      if (!pr) return context;

      const nextPrState = normalizeRemotePrState(pr.state);
      const nextReviewState = normalizeRemoteReviewDecision(pr.reviewDecision);
      this.upsertIssueIfLeaseHeld(
        issue.projectId,
        issue.linearIssueId,
        {
        projectId: issue.projectId,
        linearIssueId: issue.linearIssueId,
        ...(nextPrState ? { prState: nextPrState } : {}),
        ...(pr.headRefOid ? { prHeadSha: pr.headRefOid } : {}),
        ...(nextReviewState ? { prReviewState: nextReviewState } : {}),
        },
        "review-fix wake refresh",
      );

      if (nextPrState !== "open") return context;
      if (nextReviewState && nextReviewState !== "changes_requested") return context;
      if (!isDirtyMergeStateStatus(pr.mergeStateStatus)) return context;

      return buildReviewFixBranchUpkeepContext(
        issue.prNumber,
        project.github?.baseBranch ?? "main",
        pr,
        context,
      );
    } catch (error) {
      this.logger.debug({
        issueKey: issue.issueKey,
        prNumber: issue.prNumber,
        error: error instanceof Error ? error.message : String(error),
      }, "Failed to resolve requested-changes wake context");
      return context;
    }
  }

  private async resolvePostRunFollowUp(
    run: Pick<RunRecord, "runType" | "projectId">,
    issue: IssueRecord,
    projectOverride?: { github?: { repoFullName?: string; baseBranch?: string } } | undefined,
  ): Promise<PostRunFollowUp | undefined> {
    if (run.runType !== "review_fix") {
      return undefined;
    }
    if (!issue.prNumber || issue.prState !== "open") {
      return undefined;
    }
    if (issue.prReviewState !== "changes_requested") {
      return undefined;
    }

    const project = projectOverride ?? this.config.projects.find((entry) => entry.id === run.projectId);
    const repoFullName = project?.github?.repoFullName;
    if (!repoFullName) {
      return undefined;
    }

    try {
      const pr = await this.loadRemotePrState(repoFullName, issue.prNumber);
      if (!pr) return undefined;

      const nextPrState = normalizeRemotePrState(pr.state);
      const nextReviewState = normalizeRemoteReviewDecision(pr.reviewDecision);
      this.upsertIssueIfLeaseHeld(
        issue.projectId,
        issue.linearIssueId,
        {
        projectId: issue.projectId,
        linearIssueId: issue.linearIssueId,
        ...(nextPrState ? { prState: nextPrState } : {}),
        ...(pr.headRefOid ? { prHeadSha: pr.headRefOid } : {}),
        ...(nextReviewState ? { prReviewState: nextReviewState } : {}),
        },
        "post-run follow-up refresh",
      );

      if (nextPrState !== "open") return undefined;
      if (nextReviewState && nextReviewState !== "changes_requested") return undefined;
      if (!isDirtyMergeStateStatus(pr.mergeStateStatus)) return undefined;

      return {
        pendingRunType: "branch_upkeep",
        factoryState: "changes_requested",
        context: buildReviewFixBranchUpkeepContext(
          issue.prNumber,
          project?.github?.baseBranch ?? "main",
          pr,
        ),
        summary: `PR #${issue.prNumber} is still dirty after review fix; queued branch upkeep`,
      };
    } catch (error) {
      this.logger.debug({
        issueKey: issue.issueKey,
        prNumber: issue.prNumber,
        error: error instanceof Error ? error.message : String(error),
      }, "Failed to resolve post-run PR upkeep");
      return undefined;
    }
  }

  private async verifyPublishedRunOutcome(
    run: RunRecord,
    issue: IssueRecord,
    projectOverride?: { github?: { repoFullName?: string; baseBranch?: string } } | undefined,
  ): Promise<string | undefined> {
    if (run.runType !== "implementation") {
      return undefined;
    }
    const project = projectOverride ?? this.config.projects.find((entry) => entry.id === run.projectId);
    const baseBranch = project?.github?.baseBranch ?? "main";
    const deliveryMode = resolveImplementationDeliveryMode(issue, undefined, run.promptText);
    if (deliveryMode === "linear_only") {
      if (issue.prNumber !== undefined) {
        return `Planning-only implementation should not open a PR, but PR #${issue.prNumber} was observed`;
      }
      return this.describeLocalImplementationOutcome(issue, baseBranch, deliveryMode);
    }
    if (issue.prNumber && issue.prState && issue.prState !== "closed") {
      return undefined;
    }

    if (project?.github?.repoFullName && issue.branchName) {
      try {
        const { stdout, exitCode } = await execCommand("gh", [
          "pr",
          "list",
          "--repo",
          project.github.repoFullName,
          "--head",
          issue.branchName,
          "--state",
          "all",
          "--json",
          "number,url,state,author,headRefOid",
        ], { timeoutMs: 10_000 });
        if (exitCode === 0) {
          const matches = JSON.parse(stdout) as Array<{
            number?: number;
            url?: string;
            state?: string;
            headRefOid?: string;
            author?: { login?: string };
          }>;
          const pr = matches[0];
          if (pr?.number) {
            this.upsertIssueIfLeaseHeld(
              issue.projectId,
              issue.linearIssueId,
              {
              projectId: issue.projectId,
              linearIssueId: issue.linearIssueId,
              prNumber: pr.number,
              ...(pr.url ? { prUrl: pr.url } : {}),
              ...(pr.state ? { prState: pr.state.toLowerCase() } : {}),
              ...(pr.headRefOid ? { prHeadSha: pr.headRefOid } : {}),
              ...(pr.author?.login ? { prAuthorLogin: pr.author.login } : {}),
              },
              "published PR verification refresh",
            );
            return undefined;
          }
        }
      } catch (error) {
        this.logger.debug({
          issueKey: issue.issueKey,
          branchName: issue.branchName,
          repoFullName: project.github.repoFullName,
          error: error instanceof Error ? error.message : String(error),
        }, "Failed to verify published PR state after implementation");
      }
    }

    const details = await this.describeLocalImplementationOutcome(issue, baseBranch, deliveryMode);
    return details ?? `Implementation completed without opening a PR for branch ${issue.branchName ?? issue.linearIssueId}`;
  }

  private async describeLocalImplementationOutcome(
    issue: IssueRecord,
    baseBranch: string,
    deliveryMode: ImplementationDeliveryMode = "publish_pr",
  ): Promise<string | undefined> {
    if (!issue.worktreePath) {
      return undefined;
    }

    try {
      const status = await execCommand(this.config.runner.gitBin, [
        "-C",
        issue.worktreePath,
        "status",
        "--short",
      ], { timeoutMs: 10_000 });
      const dirtyEntries = status.exitCode === 0
        ? status.stdout.split("\n").map((line) => line.trim()).filter(Boolean)
        : [];
      if (dirtyEntries.length > 0) {
        if (deliveryMode === "linear_only") {
          return `Planning-only implementation should not modify the repo; worktree still has ${dirtyEntries.length} uncommitted change(s)`;
        }
        return `Implementation completed without opening a PR; worktree still has ${dirtyEntries.length} uncommitted change(s)`;
      }
    } catch {
      // Best effort only.
    }

    try {
      const ahead = await execCommand(this.config.runner.gitBin, [
        "-C",
        issue.worktreePath,
        "rev-list",
        "--count",
        `origin/${baseBranch}..HEAD`,
      ], { timeoutMs: 10_000 });
      if (ahead.exitCode === 0) {
        const count = Number(ahead.stdout.trim());
        if (Number.isFinite(count) && count > 0) {
          if (deliveryMode === "linear_only") {
            return `Planning-only implementation should not create repo commits; worktree is ${count} local commit(s) ahead of origin/${baseBranch}`;
          }
          return `Implementation completed with ${count} local commit(s) ahead of origin/${baseBranch} but no PR was observed`;
        }
      }
    } catch {
      // Best effort only.
    }

    return undefined;
  }


  private async readThreadWithRetry(threadId: string, maxRetries = 3): Promise<CodexThreadSummary> {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        return await this.codex.readThread(threadId, true);
      } catch {
        if (attempt === maxRetries - 1) throw new Error(`Failed to read thread ${threadId} after ${maxRetries} attempts`);
        await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
      }
    }
    throw new Error(`Failed to read thread ${threadId}`);
  }

  private getHeldIssueSessionLease(projectId: string, linearIssueId: string):
    | { projectId: string; linearIssueId: string; leaseId: string }
    | undefined {
    return this.leaseService.getHeldLease(projectId, linearIssueId);
  }

  private withHeldIssueSessionLease<T>(
    projectId: string,
    linearIssueId: string,
    fn: (lease: { projectId: string; linearIssueId: string; leaseId: string }) => T,
  ): T | undefined {
    return this.leaseService.withHeldLease(projectId, linearIssueId, fn);
  }

  private upsertIssueIfLeaseHeld(
    projectId: string,
    linearIssueId: string,
    params: Parameters<PatchRelayDatabase["upsertIssue"]>[0],
    context: string,
  ): IssueRecord | undefined {
    const lease = this.getHeldIssueSessionLease(projectId, linearIssueId);
    if (!lease) {
      this.logger.warn({ projectId, linearIssueId, context }, "Skipping issue write without a held issue-session lease");
      return undefined;
    }
    const updated = this.db.issueSessions.upsertIssueWithLease(lease, params);
    if (!updated) {
      this.logger.warn({ projectId, linearIssueId, context }, "Skipping issue write after losing issue-session lease");
    }
    return updated;
  }

  private assertLaunchLease(run: Pick<RunRecord, "id" | "projectId" | "linearIssueId">, phase: string): void {
    if (this.heartbeatIssueSessionLease(run.projectId, run.linearIssueId)) {
      return;
    }
    const error = new Error(`Lost issue-session lease ${phase}`);
    error.name = "IssueSessionLeaseLostError";
    this.logger.warn({ runId: run.id, issueId: run.linearIssueId, phase }, "Aborting run launch after losing issue-session lease");
    throw error;
  }

  private acquireIssueSessionLease(projectId: string, linearIssueId: string): string | undefined {
    return this.leaseService.acquire(projectId, linearIssueId);
  }

  private forceAcquireIssueSessionLease(projectId: string, linearIssueId: string): string | undefined {
    return this.leaseService.forceAcquire(projectId, linearIssueId);
  }

  private claimLeaseForReconciliation(projectId: string, linearIssueId: string): boolean | "owned" | "skip" {
    return this.leaseService.claimForReconciliation(projectId, linearIssueId);
  }

  private async reclaimForeignRecoveryLeaseIfSafe(run: RunRecord, issue: IssueRecord): Promise<boolean> {
    return await this.leaseService.reclaimForeignRecoveryLeaseIfSafe(run, issue);
  }

  private heartbeatIssueSessionLease(projectId: string, linearIssueId: string): boolean {
    return this.leaseService.heartbeat(projectId, linearIssueId);
  }

  private releaseIssueSessionLease(projectId: string, linearIssueId: string): void {
    this.leaseService.release(projectId, linearIssueId);
  }
}

/**
 * Determine post-run factory state from current PR metadata.
 * Used by both the normal completion path and reconciliation.
 */
function resolvePostRunState(issue: IssueRecord): FactoryState | undefined {
  if (ACTIVE_RUN_STATES.has(issue.factoryState) && issue.prNumber) {
    // Check merged first — a merged PR is both approved and merged,
    // and "done" must take priority over "awaiting_queue".
    if (issue.prState === "merged") return "done";
    if (issue.prReviewState === "approved") return "awaiting_queue";
    return "pr_open";
  }
  return undefined;
}

function resolveCompletedRunState(issue: IssueRecord, run: Pick<RunRecord, "runType" | "promptText">): FactoryState | undefined {
  if (run.runType === "implementation" && resolveImplementationDeliveryMode(issue, undefined, run.promptText) === "linear_only") {
    return "done";
  }
  return resolvePostRunState(issue);
}

function resolveRecoverablePostRunState(issue: IssueRecord): FactoryState | undefined {
  if (!issue.prNumber) {
    return resolvePostRunState(issue);
  }
  if (issue.prState === "merged") return "done";
  if (issue.prState === "open") {
    const reactiveIntent = deriveIssueSessionReactiveIntent({
      prNumber: issue.prNumber,
      prState: issue.prState,
      prReviewState: issue.prReviewState,
      prCheckStatus: issue.prCheckStatus,
      latestFailureSource: issue.lastGitHubFailureSource,
    });
    if (reactiveIntent) return reactiveIntent.compatibilityFactoryState;
    if (issue.prReviewState === "approved") return "awaiting_queue";
    return "pr_open";
  }
  return resolvePostRunState(issue);
}

function normalizeRemotePrState(value: string | undefined): "open" | "closed" | "merged" | undefined {
  const normalized = value?.trim().toUpperCase();
  if (normalized === "OPEN") return "open";
  if (normalized === "CLOSED") return "closed";
  if (normalized === "MERGED") return "merged";
  return undefined;
}

function normalizeRemoteReviewDecision(value: string | undefined): "approved" | "changes_requested" | "commented" | undefined {
  const normalized = value?.trim().toUpperCase();
  if (normalized === "APPROVED") return "approved";
  if (normalized === "CHANGES_REQUESTED") return "changes_requested";
  if (normalized === "REVIEW_REQUIRED") return "commented";
  return undefined;
}

function isDirtyMergeStateStatus(value: string | undefined): boolean {
  return value?.trim().toUpperCase() === "DIRTY";
}

function buildReviewFixBranchUpkeepContext(
  prNumber: number,
  baseBranch: string,
  pr: RemotePrState,
  context?: Record<string, unknown>,
): Record<string, unknown> {
  const promptContext = [
    `The requested code change may already be present, but GitHub still reports PR #${prNumber} as ${String(pr.mergeStateStatus)} against latest ${baseBranch}.`,
    `This turn is branch upkeep on the existing PR branch: update onto latest ${baseBranch}, resolve any conflicts, rerun the narrowest relevant verification, and push a newer head.`,
    "Do not stop just because the requested code change is already present. Review can only move forward after a new pushed head.",
  ].join(" ");

  return {
    ...(context ?? {}),
    branchUpkeepRequired: true,
    reviewFixMode: "branch_upkeep",
    wakeReason: "branch_upkeep",
    promptContext,
    ...(pr.mergeStateStatus ? { mergeStateStatus: pr.mergeStateStatus } : {}),
    ...(pr.headRefOid ? { failingHeadSha: pr.headRefOid } : {}),
    baseBranch,
  };
}
