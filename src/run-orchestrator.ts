import type { Logger } from "pino";
import type { GitHubAppBotIdentity } from "./github-app-token.ts";
import type { CodexAppServerClient, CodexNotification } from "./codex-app-server.ts";
import type { PatchRelayDatabase } from "./db.ts";
import type { BranchOwner, IssueRecord, RunRecord } from "./db-types.ts";
import { TERMINAL_STATES, type FactoryState, type RunType } from "./factory-state.ts";
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
import { getThreadTurns } from "./codex-thread-utils.ts";
import { QueueHealthMonitor } from "./queue-health-monitor.ts";
import { IdleIssueReconciler, resolveBranchOwnerForStateTransition } from "./idle-reconciliation.ts";
import { LinearSessionSync } from "./linear-session-sync.ts";
import { IssueSessionLeaseService } from "./issue-session-lease-service.ts";
import { InterruptedRunRecovery, resolveRecoverablePostRunState } from "./interrupted-run-recovery.ts";
import { RunCompletionPolicy } from "./run-completion-policy.ts";
import { RunFinalizer } from "./run-finalizer.ts";
import { RunLauncher } from "./run-launcher.ts";
import { RunRecoveryService } from "./run-recovery-service.ts";
import { RunWakePlanner, type PendingRunWake } from "./run-wake-planner.ts";
import { getRemainingZombieRecoveryDelayMs } from "./zombie-recovery.ts";

function lowerCaseFirst(value: string): string {
  return value ? `${value.slice(0, 1).toLowerCase()}${value.slice(1)}` : value;
}

function isRequestedChangesRunType(runType: RunType): boolean {
  return runType === "review_fix" || runType === "branch_upkeep";
}

function shouldDelayZombieRecoveryLaunch(
  issue: Pick<IssueRecord, "zombieRecoveryAttempts" | "lastZombieRecoveryAt">,
  issueSession: Pick<{ lastRunType?: RunType | undefined }, "lastRunType"> | undefined,
  runType: RunType,
): number {
  if (issue.zombieRecoveryAttempts <= 0) return 0;
  if (issueSession?.lastRunType !== runType) return 0;
  return getRemainingZombieRecoveryDelayMs(issue.lastZombieRecoveryAt, issue.zombieRecoveryAttempts);
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
  private readonly interruptedRunRecovery: InterruptedRunRecovery;
  private readonly runCompletionPolicy: RunCompletionPolicy;
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
    this.runCompletionPolicy = new RunCompletionPolicy(
      config,
      db,
      logger,
      (projectId, linearIssueId, fn) => this.withHeldIssueSessionLease(projectId, linearIssueId, fn),
    );
    this.runFinalizer = new RunFinalizer(
      db,
      logger,
      this.linearSync,
      this.enqueueIssue,
      (projectId, linearIssueId, fn) => this.withHeldIssueSessionLease(projectId, linearIssueId, fn),
      (projectId, linearIssueId) => this.releaseIssueSessionLease(projectId, linearIssueId),
      (lease, issue, runType, context, dedupeScope) => this.appendWakeEventWithLease(lease, issue, runType, context, dedupeScope),
      (run, message, nextState) => this.failRunAndClear(run, message, nextState),
      this.runCompletionPolicy,
      feed,
    );
    this.runLauncher = new RunLauncher(config, db, codex, logger, this.worktreeManager);
    this.runRecovery = new RunRecoveryService(
      db,
      logger,
      this.linearSync,
      (projectId, linearIssueId, fn) => this.withHeldIssueSessionLease(projectId, linearIssueId, fn),
      (projectId, linearIssueId) => this.getHeldIssueSessionLease(projectId, linearIssueId),
      (lease, issue, runType, context, dedupeScope) => this.appendWakeEventWithLease(lease, issue, runType, context, dedupeScope),
      (projectId, linearIssueId) => this.releaseIssueSessionLease(projectId, linearIssueId),
      (projectId, issueId) => this.enqueueIssue(projectId, issueId),
      (newState, pendingRunType) => this.resolveBranchOwnerForStateTransition(newState, pendingRunType),
      feed,
    );
    this.interruptedRunRecovery = new InterruptedRunRecovery(
      db,
      logger,
      this.linearSync,
      (projectId, linearIssueId, fn) => this.withHeldIssueSessionLease(projectId, linearIssueId, fn),
      (projectId, linearIssueId) => this.releaseIssueSessionLease(projectId, linearIssueId),
      (run, message, nextState) => this.failRunAndClear(run, message, nextState),
      (issue) => this.restoreIdleWorktree(issue),
      this.runCompletionPolicy,
      (projectId, issueId) => this.enqueueIssue(projectId, issueId),
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
    const remainingZombieDelayMs = shouldDelayZombieRecoveryLaunch(issue, issueSession, runType);
    if (remainingZombieDelayMs > 0) {
      this.logger.debug(
        { issueKey: issue.issueKey, runType, remainingZombieDelayMs },
        "Deferring recovered run launch until zombie backoff elapses",
      );
      this.releaseIssueSessionLease(item.projectId, item.issueId);
      return;
    }
    const effectiveContext = isRequestedChangesRunType(runType)
      ? await this.runCompletionPolicy.resolveRequestedChangesWakeContext(issue, runType, context)
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

  private async resetWorktreeToTrackedBranch(
    worktreePath: string,
    branchName: string,
    issue: Pick<IssueRecord, "issueKey">,
  ): Promise<void> {
    await this.worktreeManager.resetWorktreeToTrackedBranch(worktreePath, branchName, issue, this.logger);
  }

  private async restoreIdleWorktree(
    issue: Pick<IssueRecord, "issueKey" | "worktreePath" | "branchName">,
  ): Promise<void> {
    await this.worktreeManager.restoreIdleWorktree(issue, this.logger);
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
      resolveRecoverableRunState: resolveRecoverablePostRunState,
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
    // If this process still owns the live lease, launch may still be in flight
    // between worktree prep and Codex thread creation, so do not self-recover it.
    if (!run.threadId) {
      if (recoveryLease === "owned") {
        this.logger.debug(
          { issueKey: issue.issueKey, runId: run.id, runType: run.runType },
          "Skipping zombie reconciliation for locally-owned launch that has not created a thread yet",
        );
        return;
      }
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
      await this.interruptedRunRecovery.handle(run, issue);
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
        resolveRecoverableRunState: resolveRecoverablePostRunState,
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
    });
  }

  private failRunAndClear(run: RunRecord, message: string, nextState: FactoryState = "failed"): void {
    this.runRecovery.failRunAndClear({
      run,
      message,
      nextState,
    });
  }

  private resolveBranchOwnerForStateTransition(newState: FactoryState, pendingRunType?: RunType): BranchOwner | undefined {
    return resolveBranchOwnerForStateTransition(newState, pendingRunType);
  }

  private async resolveRequestedChangesWakeContext(
    issue: IssueRecord,
    runType: RunType,
    context: Record<string, unknown> | undefined,
  ): Promise<Record<string, unknown> | undefined> {
    return await this.runCompletionPolicy.resolveRequestedChangesWakeContext(issue, runType, context);
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

  private assertLaunchLease(run: Pick<RunRecord, "id" | "projectId" | "linearIssueId">, phase: string): void {
    if (this.heartbeatIssueSessionLease(run.projectId, run.linearIssueId)) {
      return;
    }
    const error = new Error(`Lost issue-session lease ${phase}`);
    error.name = "IssueSessionLeaseLostError";
    this.logger.warn({ runId: run.id, issueId: run.linearIssueId, phase }, "Aborting run launch after losing issue-session lease");
    throw error;
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
