import type { Logger } from "pino";
import type { GitHubAppBotIdentity } from "./github-app-token.ts";
import type { CodexAppServerClient, CodexNotification } from "./codex-app-server.ts";
import type { PatchRelayDatabase } from "./db.ts";
import type { IssueRecord, RunRecord } from "./db-types.ts";
import type { FactoryState, RunType } from "./factory-state.ts";
import type { OperatorEventFeed } from "./operator-feed.ts";
import { summarizeCurrentThread } from "./run-reporting.ts";
import {
  buildRunStartedActivity,
} from "./linear-session-reporting.ts";
import { CompletionCheckService } from "./completion-check.ts";
import { PublicationRecapService } from "./publication-recap.ts";
import { WorktreeManager } from "./worktree-manager.ts";
import type {
  AppConfig,
  CodexThreadSummary,
  LinearClientProvider,
} from "./types.ts";
import { MergedLinearCompletionReconciler } from "./merged-linear-completion-reconciler.ts";
import { MainBranchHealthMonitor } from "./main-branch-health-monitor.ts";
import { QueueHealthMonitor } from "./queue-health-monitor.ts";
import { IdleIssueReconciler } from "./idle-reconciliation.ts";
import { LinearSessionSync } from "./linear-session-sync.ts";
import { IssueSessionLeaseService } from "./issue-session-lease-service.ts";
import { InterruptedRunRecovery } from "./interrupted-run-recovery.ts";
import { RunCompletionPolicy } from "./run-completion-policy.ts";
import { RunFinalizer } from "./run-finalizer.ts";
import { RunLauncher } from "./run-launcher.ts";
import { RunNotificationHandler } from "./run-notification-handler.ts";
import { RunReconciler } from "./run-reconciler.ts";
import { RunRecoveryService } from "./run-recovery-service.ts";
import { RunWakePlanner, type PendingRunWake } from "./run-wake-planner.ts";
import { getRemainingZombieRecoveryDelayMs } from "./zombie-recovery.ts";
import { classifyIssue } from "./issue-class.ts";
import { loadConfig } from "./config.ts";

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

function isResolvedDependencyState(stateType?: string): boolean {
  return stateType === "completed" || stateType?.trim().toLowerCase() === "done";
}

interface RunThreadPorts {
  readThreadWithRetry: (threadId: string, maxRetries?: number) => Promise<CodexThreadSummary>;
}

interface RunLeasePorts {
  withHeldLease: <T>(
    projectId: string,
    linearIssueId: string,
    fn: (lease: { projectId: string; linearIssueId: string; leaseId: string }) => T,
  ) => T | undefined;
  releaseLease: (projectId: string, linearIssueId: string) => void;
  heartbeatLease: (projectId: string, linearIssueId: string) => boolean;
  getHeldLease: (
    projectId: string,
    linearIssueId: string,
  ) => { projectId: string; linearIssueId: string; leaseId: string } | undefined;
}

interface RunRecoveryPorts {
  failRunAndClear: (run: RunRecord, message: string, nextState?: FactoryState) => void;
  restoreIdleWorktree: (issue: Pick<IssueRecord, "issueKey" | "worktreePath" | "branchName">) => Promise<void>;
  recoverOrEscalate: (issue: IssueRecord, runType: RunType, reason: string) => void;
}

export class RunOrchestrator {
  private readonly worktreeManager: WorktreeManager;
  private readonly mainBranchHealthMonitor: MainBranchHealthMonitor;
  /** Tracks last probe-failure feed event per issue to avoid spamming the operator feed. */
  private readonly queueHealthMonitor: QueueHealthMonitor;
  private readonly idleReconciler: IdleIssueReconciler;
  readonly linearSync: LinearSessionSync;
  private readonly workerId = `patchrelay:${process.pid}`;
  private readonly leaseService: IssueSessionLeaseService;
  private readonly runFinalizer: RunFinalizer;
  private readonly runLauncher: RunLauncher;
  private readonly runRecovery: RunRecoveryService;
  private readonly runWakePlanner: RunWakePlanner;
  private readonly interruptedRunRecovery: InterruptedRunRecovery;
  private readonly runCompletionPolicy: RunCompletionPolicy;
  private readonly completionCheck: CompletionCheckService;
  private readonly publicationRecap: PublicationRecapService;
  private readonly runNotificationHandler: RunNotificationHandler;
  private readonly runReconciler: RunReconciler;
  private readonly mergedLinearCompletionReconciler: MergedLinearCompletionReconciler;
  private codexRuntimeConfig: AppConfig["runner"]["codex"];
  private readonly threadPorts: RunThreadPorts = {
    readThreadWithRetry: (threadId, maxRetries) => this.readThreadWithRetry(threadId, maxRetries),
  };
  private readonly leasePorts: RunLeasePorts = {
    withHeldLease: (projectId, linearIssueId, fn) => this.withHeldIssueSessionLease(projectId, linearIssueId, fn),
    releaseLease: (projectId, linearIssueId) => this.releaseIssueSessionLease(projectId, linearIssueId),
    heartbeatLease: (projectId, linearIssueId) => this.heartbeatIssueSessionLease(projectId, linearIssueId),
    getHeldLease: (projectId, linearIssueId) => this.getHeldIssueSessionLease(projectId, linearIssueId),
  };
  private readonly recoveryPorts: RunRecoveryPorts = {
    failRunAndClear: (run, message, nextState) => this.failRunAndClear(run, message, nextState),
    restoreIdleWorktree: (issue) => this.restoreIdleWorktree(issue),
    recoverOrEscalate: (issue, runType, reason) => this.recoverOrEscalate(issue, runType, reason),
  };
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
    private readonly configPath?: string,
  ) {
    this.worktreeManager = new WorktreeManager(config);
    this.codexRuntimeConfig = config.runner.codex;
    this.linearSync = new LinearSessionSync(config, db, linearProvider, logger, feed);
    this.leaseService = new IssueSessionLeaseService(
      db,
      logger,
      this.workerId,
      this.threadPorts.readThreadWithRetry,
    );
    this.activeSessionLeases = this.leaseService.activeSessionLeases;
    this.runCompletionPolicy = new RunCompletionPolicy(
      config,
      db,
      logger,
      this.leasePorts.withHeldLease,
    );
    this.completionCheck = new CompletionCheckService(codex, logger);
    this.publicationRecap = new PublicationRecapService(codex, logger);
    this.runFinalizer = new RunFinalizer(
      db,
      logger,
      this.linearSync,
      this.enqueueIssue,
      this.leasePorts.withHeldLease,
      this.leasePorts.releaseLease,
      (lease, issue, runType, context, dedupeScope) => this.appendWakeEventWithLease(lease, issue, runType, context, dedupeScope),
      this.recoveryPorts.failRunAndClear,
      this.runCompletionPolicy,
      this.completionCheck,
      this.publicationRecap,
      feed,
    );
    this.runLauncher = new RunLauncher(config, db, codex, logger, this.worktreeManager);
    this.runNotificationHandler = new RunNotificationHandler(
      config,
      db,
      logger,
      this.linearSync,
      this.runFinalizer,
      this.threadPorts.readThreadWithRetry,
      this.leasePorts.withHeldLease,
      this.leasePorts.heartbeatLease,
      this.leasePorts.releaseLease,
      feed,
    );
    this.runRecovery = new RunRecoveryService(
      db,
      logger,
      this.linearSync,
      this.leasePorts.withHeldLease,
      this.leasePorts.getHeldLease,
      (lease, issue, runType, context, dedupeScope) => this.appendWakeEventWithLease(lease, issue, runType, context, dedupeScope),
      this.leasePorts.releaseLease,
      (projectId, issueId) => this.enqueueIssue(projectId, issueId),
      feed,
    );
    this.interruptedRunRecovery = new InterruptedRunRecovery(
      db,
      logger,
      this.linearSync,
      this.leasePorts.withHeldLease,
      this.leasePorts.releaseLease,
      this.recoveryPorts.failRunAndClear,
      this.recoveryPorts.restoreIdleWorktree,
      this.runCompletionPolicy,
      (projectId, issueId) => this.enqueueIssue(projectId, issueId),
      feed,
    );
    this.runReconciler = new RunReconciler(
      db,
      logger,
      linearProvider,
      this.linearSync,
      this.interruptedRunRecovery,
      this.runFinalizer,
      this.leasePorts.withHeldLease,
      this.leasePorts.releaseLease,
      this.threadPorts.readThreadWithRetry,
      this.recoveryPorts.recoverOrEscalate,
      feed,
    );
    this.runWakePlanner = new RunWakePlanner(db);
    this.idleReconciler = new IdleIssueReconciler(db, config, {
      enqueueIssue: (projectId, issueId) => this.enqueueIssue(projectId, issueId),
    }, logger, feed);
    this.mainBranchHealthMonitor = new MainBranchHealthMonitor(
      db,
      config,
      linearProvider,
      (projectId, issueId) => this.enqueueIssue(projectId, issueId),
      logger,
      feed,
    );
    this.mergedLinearCompletionReconciler = new MergedLinearCompletionReconciler(db, linearProvider, logger);
    this.queueHealthMonitor = new QueueHealthMonitor(db, config, {
      advanceIdleIssue: (issue, newState, options) => this.idleReconciler.advanceIdleIssue(issue, newState, options),
      enqueueIssue: (projectId, issueId) => this.enqueueIssue(projectId, issueId),
    }, logger, feed);
  }

  private async refreshCodexRuntimeConfig(): Promise<void> {
    if (!this.configPath) {
      return;
    }

    try {
      const freshConfig = loadConfig(this.configPath, { profile: "service" });
      if (
        this.codexRuntimeConfig.model === freshConfig.runner.codex.model &&
        this.codexRuntimeConfig.modelProvider === freshConfig.runner.codex.modelProvider &&
        this.codexRuntimeConfig.reasoningEffort === freshConfig.runner.codex.reasoningEffort
      ) {
        return;
      }
      this.codexRuntimeConfig = freshConfig.runner.codex;
      this.codex.setRuntimeConfig(this.codexRuntimeConfig);
    } catch (error) {
      this.logger.warn(
        {
          error: error instanceof Error ? error.message : String(error),
          configPath: this.configPath,
        },
        "Failed to reload patchrelay runtime config before run; using previous codex configuration",
      );
    }
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

  private buildRelatedIssueContext(issue: IssueRecord): Record<string, unknown> | undefined {
    const unresolvedBlockers = this.db.issues
      .listIssueDependencies(issue.projectId, issue.linearIssueId)
      .filter((entry) => !isResolvedDependencyState(entry.blockerCurrentLinearStateType))
      .map((entry) => ({
        linearIssueId: entry.blockerLinearIssueId,
        ...(entry.blockerIssueKey ? { issueKey: entry.blockerIssueKey } : {}),
        ...(entry.blockerTitle ? { title: entry.blockerTitle } : {}),
        ...(entry.blockerCurrentLinearState ? { stateName: entry.blockerCurrentLinearState } : {}),
        ...(entry.blockerCurrentLinearStateType ? { stateType: entry.blockerCurrentLinearStateType } : {}),
      }));

    const childIssues = this.db.issues
      .listChildIssues(issue.projectId, issue.linearIssueId)
      .map((entry) => ({
        linearIssueId: entry.linearIssueId,
        ...(entry.issueKey ? { issueKey: entry.issueKey } : {}),
        ...(entry.title ? { title: entry.title } : {}),
        factoryState: entry.factoryState,
        ...(entry.currentLinearState ? { currentLinearState: entry.currentLinearState } : {}),
        delegatedToPatchRelay: entry.delegatedToPatchRelay,
        hasOpenPr: entry.prNumber !== undefined && entry.prState !== "closed" && entry.prState !== "merged",
      }));

    if (unresolvedBlockers.length === 0 && childIssues.length === 0) {
      return {};
    }

    return {
      ...(unresolvedBlockers.length > 0 ? { unresolvedBlockers } : {}),
      ...(childIssues.length > 0 ? { childIssues } : {}),
    };
  }

  private classifyTrackedIssue(issue: IssueRecord): IssueRecord {
    const childIssueCount = this.db.issues.listChildIssues(issue.projectId, issue.linearIssueId).length;
    const classification = classifyIssue({ issue, childIssueCount });
    if (issue.issueClass === classification.issueClass && issue.issueClassSource === classification.issueClassSource) {
      return issue;
    }
    return this.db.issues.upsertIssue({
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      issueClass: classification.issueClass,
      issueClassSource: classification.issueClassSource,
    });
  }

  // ─── Run ────────────────────────────────────────────────────────

  async run(item: { projectId: string; issueId: string }): Promise<void> {
    await this.refreshCodexRuntimeConfig();

    const project = this.config.projects.find((p) => p.id === item.projectId);
    if (!project) return;

    if (this.leaseService.hasLocalLease(item.projectId, item.issueId)) {
      return;
    }

    const initialIssue = this.db.issues.getIssue(item.projectId, item.issueId);
    const issue = initialIssue ? this.classifyTrackedIssue(initialIssue) : undefined;
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
    if (runType === "implementation" && this.db.issues.countUnresolvedBlockers(item.projectId, item.issueId) > 0) {
      this.db.issueSessions.clearPendingIssueSessionEventsRespectingActiveLease(item.projectId, item.issueId);
      this.releaseIssueSessionLease(item.projectId, item.issueId);
      this.logger.info({ issueKey: issue.issueKey }, "Skipped implementation launch because the issue is blocked");
      return;
    }
    const remainingZombieDelayMs = shouldDelayZombieRecoveryLaunch(issue, issueSession, runType);
    if (remainingZombieDelayMs > 0) {
      this.logger.debug(
        { issueKey: issue.issueKey, runType, remainingZombieDelayMs },
        "Deferring recovered run launch until zombie backoff elapses",
      );
      this.releaseIssueSessionLease(item.projectId, item.issueId);
      return;
    }
    const baseContext = isRequestedChangesRunType(runType)
      ? await this.runCompletionPolicy.resolveRequestedChangesWakeContext(issue, runType, context)
      : context;
    const coordinationContext = runType === "implementation"
      ? this.buildRelatedIssueContext(issue)
      : undefined;
    const effectiveContext = coordinationContext
      ? { ...coordinationContext, ...(baseContext ?? {}) }
      : baseContext;
    const sourceHeadSha = typeof effectiveContext?.failureHeadSha === "string"
      ? effectiveContext.failureHeadSha
      : typeof effectiveContext?.headSha === "string"
        ? effectiveContext.headSha
        : issue.prHeadSha;
    const budgetExceeded = this.runWakePlanner.budgetExceeded(issue, project, runType, isRequestedChangesRunType);
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
    await this.runNotificationHandler.handle(notification);
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
    await this.mainBranchHealthMonitor.reconcile();
    // Preemptively detect stuck merge-queue PRs (conflicts visible on
    // GitHub) and dispatch queue_repair before the Steward evicts.
    await this.queueHealthMonitor.reconcile();
    // Advance issues stuck in pr_open whose stored PR metadata already
    // shows they should transition (e.g. approved PR, missed webhook).
    await this.idleReconciler.reconcile();
    await this.mergedLinearCompletionReconciler.reconcile();
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
    await this.runReconciler.reconcile({ run, issue, recoveryLease });
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
