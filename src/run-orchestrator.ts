import type { Logger } from "pino";
import type { GitHubAppBotIdentity } from "./github-app-token.ts";
import type { CodexAppServerClient, CodexNotification } from "./codex-app-server.ts";
import type { PatchRelayDatabase } from "./db.ts";
import type { IssueRecord, RunRecord } from "./db-types.ts";
import type { FactoryState, RunType } from "./factory-state.ts";
import { isRequestedChangesRunType } from "./reactive-pr-state.ts";
import type { OperatorEventFeed } from "./operator-feed.ts";
import { summarizeCurrentThread } from "./run-reporting.ts";
import {
  buildReviewRoundStartedActivity,
  buildRunStartedActivity,
} from "./linear-session-reporting.ts";
import { CompletionCheckService } from "./completion-check.ts";
import { WorktreeManager } from "./worktree-manager.ts";
import type {
  AppConfig,
  CodexThreadSummary,
  LinearClientProvider,
} from "./types.ts";
import { MergedLinearCompletionReconciler } from "./merged-linear-completion-reconciler.ts";
import { QueueHealthMonitor } from "./queue-health-monitor.ts";
import { IdleIssueReconciler } from "./idle-reconciliation.ts";
import { LinearSessionSync } from "./linear-session-sync.ts";
import { recoverLinearAgentActivityContext } from "./linear-agent-activity-recovery.ts";
import { IssueSessionLeaseService } from "./issue-session-lease-service.ts";
import { InterruptedRunRecovery } from "./interrupted-run-recovery.ts";
import { RunCompletionPolicy } from "./run-completion-policy.ts";
import { RunFinalizer } from "./run-finalizer.ts";
import { RunLauncher } from "./run-launcher.ts";
import { RunNotificationHandler } from "./run-notification-handler.ts";
import { RunReconciler } from "./run-reconciler.ts";
import { RunRecoveryService } from "./run-recovery-service.ts";
import { RunWakePlanner, type PendingRunWake } from "./run-wake-planner.ts";
import { WakeDispatcher } from "./wake-dispatcher.ts";
import { settleRun } from "./run-settlement.ts";
import { getRemainingZombieRecoveryDelayMs } from "./zombie-recovery.ts";
import { classifyIssue } from "./issue-class.ts";
import { buildIssueTriageHash, IssueTriageService } from "./issue-triage.ts";
import { loadConfig } from "./config.ts";
import { CodexThreadMaterializingError, isThreadMaterializingError } from "./codex-thread-errors.ts";
import { emitTelemetry, noopTelemetry, type PatchRelayTelemetry, type RunSkipReason } from "./telemetry.ts";
import { LinearIssueProjectionService } from "./linear-issue-projection.ts";
import { RunAdmissionController } from "./run-admission-controller.ts";

const WRITER = "run-orchestrator";

function lowerCaseFirst(value: string): string {
  return value ? `${value.slice(0, 1).toLowerCase()}${value.slice(1)}` : value;
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
  /** Tracks last probe-failure feed event per issue to avoid spamming the operator feed. */
  private readonly queueHealthMonitor: QueueHealthMonitor;
  private readonly idleReconciler: IdleIssueReconciler;
  readonly linearSync: LinearSessionSync;
  private readonly workerId = `patchrelay:${process.pid}`;
  // Exposed so the WakeDispatcher (constructed in service.ts) can call
  // release on this same lease service. Kept on the orchestrator because
  // its construction depends on Codex thread access.
  readonly leaseService: IssueSessionLeaseService;
  private readonly runFinalizer: RunFinalizer;
  private readonly runLauncher: RunLauncher;
  private readonly runRecovery: RunRecoveryService;
  private readonly runWakePlanner: RunWakePlanner;
  private readonly interruptedRunRecovery: InterruptedRunRecovery;
  private readonly runCompletionPolicy: RunCompletionPolicy;
  private readonly completionCheck: CompletionCheckService;
  private readonly issueTriage: IssueTriageService;
  private readonly runNotificationHandler: RunNotificationHandler;
  private readonly runReconciler: RunReconciler;
  private readonly mergedLinearCompletionReconciler: MergedLinearCompletionReconciler;
  private readonly linearIssueProjection: LinearIssueProjectionService;
  private readonly runAdmission: RunAdmissionController;
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

  private readonly wakeDispatcher: WakeDispatcher;
  private readonly logger: Logger;
  private readonly feed: OperatorEventFeed | undefined;
  private readonly configPath: string | undefined;
  private readonly telemetry: PatchRelayTelemetry;

  constructor(
    private readonly config: AppConfig,
    private readonly db: PatchRelayDatabase,
    private readonly codex: CodexAppServerClient,
    private readonly linearProvider: LinearClientProvider,
    private readonly enqueueIssue: (projectId: string, issueId: string) => void,
    wakeDispatcherOrLogger: WakeDispatcher | Logger,
    loggerOrFeed?: Logger | OperatorEventFeed,
    feedOrConfigPath?: OperatorEventFeed | string,
    configPathOrUndefined?: string,
    telemetryOrUndefined?: PatchRelayTelemetry,
  ) {
    // Backward-compat: tests pass `(config, db, codex, lp, enqueue, logger, feed?, configPath?)`
    // (no dispatcher). Production passes `(..., enqueue, dispatcher, logger, feed?, configPath?)`.
    let logger: Logger;
    let feed: OperatorEventFeed | undefined;
    let configPath: string | undefined;
    const telemetry = telemetryOrUndefined ?? noopTelemetry;
    if (wakeDispatcherOrLogger instanceof WakeDispatcher) {
      this.wakeDispatcher = wakeDispatcherOrLogger;
      logger = loggerOrFeed as Logger;
      feed = feedOrConfigPath as OperatorEventFeed | undefined;
      configPath = configPathOrUndefined;
    } else {
      logger = wakeDispatcherOrLogger;
      feed = loggerOrFeed as OperatorEventFeed | undefined;
      configPath = feedOrConfigPath as string | undefined;
      // Construct a dispatcher with a stub releaseLease — the real one
      // gets wired below once the lease service exists. The stub is
      // never called before the wiring completes because the run()
      // loop is the only consumer of releaseRunAndDispatch.
      this.wakeDispatcher = new WakeDispatcher(
        db,
        enqueueIssue,
        (projectId, linearIssueId) => this.leaseService?.release(projectId, linearIssueId),
        logger,
        feed,
        telemetry,
      );
    }
    this.logger = logger;
    this.feed = feed;
    this.configPath = configPath;
    this.telemetry = telemetry;
    this.worktreeManager = new WorktreeManager(config);
    this.codexRuntimeConfig = config.runner.codex;
    this.linearSync = new LinearSessionSync(config, db, linearProvider, logger, feed);
    this.leaseService = new IssueSessionLeaseService(
      db,
      logger,
      this.workerId,
      this.threadPorts.readThreadWithRetry,
      telemetry,
    );
    this.activeSessionLeases = this.leaseService.activeSessionLeases;
    this.runCompletionPolicy = new RunCompletionPolicy(
      config,
      db,
      logger,
      this.leasePorts.withHeldLease,
    );
    this.completionCheck = new CompletionCheckService(codex, logger);
    this.issueTriage = new IssueTriageService(codex, logger);
    this.runFinalizer = new RunFinalizer(
      db,
      logger,
      this.linearSync,
      this.wakeDispatcher,
      this.leasePorts.withHeldLease,
      this.leasePorts.releaseLease,
      (lease, issue, runType, context, dedupeScope) => this.appendWakeEventWithLease(lease, issue, runType, context, dedupeScope),
      this.recoveryPorts.failRunAndClear,
      this.runCompletionPolicy,
      this.completionCheck,
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
      { interruptTurn: (options) => codex.interruptTurn(options) },
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
      (projectId) => this.config.projects.find((project) => project.id === projectId)?.github?.repoFullName,
      feed,
    );
    this.runWakePlanner = new RunWakePlanner(db);
    this.linearIssueProjection = new LinearIssueProjectionService(db, linearProvider, logger);
    this.runAdmission = new RunAdmissionController(db, this.linearIssueProjection);
    this.idleReconciler = new IdleIssueReconciler(
      db,
      config,
      this.wakeDispatcher,
      logger,
      feed,
      undefined,
      (issue) => this.linearSync.syncSession(issue),
      linearProvider,
    );
    this.mergedLinearCompletionReconciler = new MergedLinearCompletionReconciler(db, linearProvider, logger);
    this.queueHealthMonitor = new QueueHealthMonitor(db, config, {
      advanceIdleIssue: (issue, newState, options) => this.idleReconciler.advanceIdleIssue(issue, newState, options),
      wakeDispatcher: this.wakeDispatcher,
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
      .listCanonicalChildIssues(issue.projectId, issue.linearIssueId)
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

  private async classifyTrackedIssue(issue: IssueRecord): Promise<IssueRecord> {
    const childIssues = this.db.issues.listCanonicalChildIssues(issue.projectId, issue.linearIssueId);
    const classification = classifyIssue({ issue, childIssueCount: childIssues.length });
    const triageHash = buildIssueTriageHash({ issue, childIssues });
    const triageCacheFresh = issue.issueClassSource === "triage" && issue.issueTriageHash === triageHash;
    if (issue.issueClass === classification.issueClass && issue.issueClassSource === classification.issueClassSource) {
      if (classification.issueClassSource !== "triage" || triageCacheFresh) {
        return issue;
      }
    }
    if (classification.issueClassSource === "heuristic" || (classification.issueClassSource === "triage" && !triageCacheFresh)) {
      try {
        const triage = await this.issueTriage.classify({ issue, childIssues });
        if (triage) {
          // The triage verdict is an external classifier response; persist it
          // unconditionally so a benign version bump during the (slow) triage
          // call cannot discard the result.
          const triageCommit = this.db.issueSessions.commitIssueState({
            writer: WRITER,
            update: {
              projectId: issue.projectId,
              linearIssueId: issue.linearIssueId,
              issueClass: triage.issueClass,
              issueClassSource: "triage",
              issueTriageHash: triageHash,
              issueTriageResultJson: JSON.stringify(triage),
            },
          });
          return triageCommit.outcome === "applied" ? triageCommit.issue : issue;
        }
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        this.logger.warn(
          { issueKey: issue.issueKey, linearIssueId: issue.linearIssueId, error: err.message },
          "Issue triage failed; falling back to heuristic classification",
        );
      }
    }
    const fallbackClassification = classification.issueClassSource === "triage" && !triageCacheFresh
      ? { issueClass: "implementation" as const, issueClassSource: "heuristic" as const }
      : classification;
    const fallbackCommit = this.db.issueSessions.commitIssueState({
      writer: WRITER,
      expectedVersion: issue.version,
      update: {
        projectId: issue.projectId,
        linearIssueId: issue.linearIssueId,
        issueClass: fallbackClassification.issueClass,
        issueClassSource: fallbackClassification.issueClassSource,
      },
      // A concurrent writer is newer truth; the next pass reclassifies.
      onConflict: () => undefined,
    });
    if (fallbackCommit.outcome === "applied") {
      return fallbackCommit.issue;
    }
    return (fallbackCommit.outcome === "conflict_skipped" ? fallbackCommit.issue : undefined) ?? issue;
  }

  // ─── Run ────────────────────────────────────────────────────────

  async run(item: { projectId: string; issueId: string }): Promise<void> {
    emitTelemetry(this.telemetry, {
      type: "queue.dequeued",
      projectId: item.projectId,
      linearIssueId: item.issueId,
    });
    emitTelemetry(this.telemetry, {
      type: "run.dequeued",
      projectId: item.projectId,
      linearIssueId: item.issueId,
    });
    await this.refreshCodexRuntimeConfig();

    const project = this.config.projects.find((p) => p.id === item.projectId);
    if (!project) {
      this.emitRunSkipped(item, "project_not_configured");
      this.logger.info(
        { projectId: item.projectId, linearIssueId: item.issueId, reason: "project_not_configured" },
        "Skipped issue run: project missing from config",
      );
      return;
    }

    // Each early-return below logs `{ issueKey, reason }` so the
    // operator-feed and log streams can explain why an issue with a
    // pending wake didn't actually run. The original incident
    // (LSR-495) was undiagnosable because these guards were silent.
    if (this.leaseService.hasLocalLease(item.projectId, item.issueId)) {
      this.emitRunSkipped(item, "lease_held_locally");
      this.logger.info(
        { projectId: item.projectId, linearIssueId: item.issueId, reason: "lease_held_locally" },
        "Skipped issue run: another in-process call still holds the lease",
      );
      return;
    }

    const initialIssue = this.db.issues.getIssue(item.projectId, item.issueId);
    if (!initialIssue) {
      this.emitRunSkipped(item, "issue_missing");
      this.logger.info(
        { projectId: item.projectId, linearIssueId: item.issueId, reason: "issue_missing" },
        "Skipped issue run: issue row not found",
      );
      return;
    }
    if (initialIssue.activeRunId !== undefined) {
      this.emitActiveRunBlockerInvariant(initialIssue);
      this.emitRunSkipped(item, "active_run_present", initialIssue, { activeRunId: initialIssue.activeRunId });
      this.logger.info(
        { issueKey: initialIssue.issueKey, projectId: item.projectId, reason: "active_run_present", activeRunId: initialIssue.activeRunId },
        "Skipped issue run: an active run is already in flight",
      );
      return;
    }
    const issue = await this.classifyTrackedIssue(initialIssue);
    if (!issue) {
      this.emitRunSkipped(item, "classification_dropped_issue");
      this.logger.info(
        { projectId: item.projectId, linearIssueId: item.issueId, reason: "classification_dropped_issue" },
        "Skipped issue run: classification returned no issue",
      );
      return;
    }
    if (issue.activeRunId !== undefined) {
      this.emitActiveRunBlockerInvariant(issue);
      this.emitRunSkipped(item, "active_run_present_post_classify", issue, { activeRunId: issue.activeRunId });
      this.logger.info(
        { issueKey: issue.issueKey, projectId: item.projectId, reason: "active_run_present_post_classify", activeRunId: issue.activeRunId },
        "Skipped issue run: an active run appeared during classification",
      );
      return;
    }
    const issueSession = this.db.issueSessions.getIssueSession(item.projectId, item.issueId);

    const leaseId = this.leaseService.acquire(item.projectId, item.issueId);
    if (!leaseId) {
      this.emitRunSkipped(item, "lease_acquire_failed", issue);
      this.logger.info({ issueKey: issue.issueKey, projectId: item.projectId, reason: "lease_acquire_failed" }, "Skipped issue run: another worker holds the session lease");
      return;
    }

    if (issue.prState === "merged") {
      this.db.issueSessions.commitIssueState({
        writer: WRITER,
        lease: { projectId: issue.projectId, linearIssueId: issue.linearIssueId, leaseId },
        update: { projectId: issue.projectId, linearIssueId: issue.linearIssueId, pendingRunType: null, factoryState: "done" },
      });
      this.leaseService.release(item.projectId, item.issueId);
      return;
    }

    const wakeIssue = this.materializeLegacyPendingWake(issue, { projectId: item.projectId, linearIssueId: item.issueId, leaseId });
    const wake = this.resolveRunWake(wakeIssue);
    if (!wake) {
      this.emitRunSkipped(item, "no_wake_derivable", issue);
      this.logger.info(
        { issueKey: issue.issueKey, projectId: item.projectId, reason: "no_wake_derivable" },
        "Skipped issue run: no actionable wake derivable from pending events",
      );
      this.leaseService.release(item.projectId, item.issueId);
      return;
    }
    const { runType, context, resumeThread } = wake;
    const admission = await this.runAdmission.check({
      projectId: item.projectId,
      linearIssueId: item.issueId,
      runType,
    });
    if (!admission.allowed) {
      this.db.issueSessions.clearPendingIssueSessionEventsRespectingActiveLease(item.projectId, item.issueId);
      this.releaseIssueSessionLease(item.projectId, item.issueId);
      this.emitRunSkipped(item, admission.reason, issue, { runType, ...admission });
      if (admission.reason === "dependency_refresh_failed") {
        this.logger.info(
          { issueKey: issue.issueKey, projectId: item.projectId, knownDependencyRows: admission.knownDependencyRows },
          "Skipped implementation launch because dependency refresh failed for an issue with known blockers",
        );
      } else {
        this.logger.info(
          { issueKey: issue.issueKey, blockerCount: admission.blockerCount },
          "Skipped implementation launch because the issue is blocked",
        );
      }
      return;
    }
    const remainingZombieDelayMs = shouldDelayZombieRecoveryLaunch(issue, issueSession, runType);
    if (remainingZombieDelayMs > 0) {
      this.emitRunSkipped(item, "zombie_backoff", issue, { runType, remainingDelayMs: remainingZombieDelayMs });
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
    const launchIssue = this.db.issues.getIssue(item.projectId, item.issueId) ?? issue;
    const inactiveRequestedChangesWakeReason = this.resolveInactiveRequestedChangesWakeReason(launchIssue, runType, baseContext);
    if (inactiveRequestedChangesWakeReason) {
      const lease = { projectId: item.projectId, linearIssueId: item.issueId, leaseId };
      const requestedChangesEventIds = this.db.issueSessions
        .listIssueSessionEvents(item.projectId, item.issueId, { pendingOnly: true })
        .filter((event) => wake.eventIds.includes(event.id) && event.eventType === "review_changes_requested")
        .map((event) => event.id);
      const dismissed = this.db.issueSessions.dismissIssueSessionEventsWithLease(lease, requestedChangesEventIds);
      if (!dismissed) {
        this.releaseIssueSessionLease(item.projectId, item.issueId);
        this.emitRunSkipped(item, "lease_lost_dismissing_inactive_requested_changes_wake", issue, { runType });
        this.logger.info(
          { issueKey: issue.issueKey, projectId: item.projectId, reason: "lease_lost_dismissing_inactive_requested_changes_wake" },
          "Skipped issue run: lost lease while dismissing inactive requested-changes wake",
        );
        return;
      }
      this.db.issueSessions.setIssueSessionLastWakeReasonWithLease(lease, wake.wakeReason ?? null);
      this.feed?.publish({
        level: "info",
        kind: "stage",
        issueKey: issue.issueKey,
        projectId: item.projectId,
        stage: runType,
        status: "skipped",
        summary: inactiveRequestedChangesWakeReason,
      });
      this.logger.info(
        {
          issueKey: issue.issueKey,
          projectId: item.projectId,
          runType,
          reason: "inactive_requested_changes_wake",
          prReviewState: launchIssue.prReviewState,
          prState: launchIssue.prState,
        },
        "Skipped issue run: requested-changes wake is no longer active",
      );
      this.emitRunSkipped(item, "inactive_requested_changes_wake", issue, { runType });
      this.releaseIssueSessionLease(item.projectId, item.issueId);
      this.wakeDispatcher.dispatchIfWakePending(item.projectId, item.issueId);
      return;
    }
    const recoveredLinearActivityContext = await recoverLinearAgentActivityContext({
      linearProvider: this.linearProvider,
      projectId: issue.projectId,
      agentSessionId: issue.agentSessionId,
      context: baseContext,
      issueKey: issue.issueKey,
      logger: this.logger,
    });
    const baseContextWithRecoveredActivity = recoveredLinearActivityContext
      ? { ...baseContext, ...recoveredLinearActivityContext }
      : baseContext;
    const coordinationContext = runType === "implementation"
      ? this.buildRelatedIssueContext(issue)
      : undefined;
    const effectiveContext = coordinationContext
      ? { ...coordinationContext, ...baseContextWithRecoveredActivity }
      : baseContextWithRecoveredActivity;
    const sourceHeadSha = typeof effectiveContext?.failureHeadSha === "string"
      ? effectiveContext.failureHeadSha
      : typeof effectiveContext?.headSha === "string"
        ? effectiveContext.headSha
        : issue.prHeadSha;
    const budgetExceeded = this.runWakePlanner.budgetExceeded(issue, project, runType, isRequestedChangesRunType);
    if (budgetExceeded) {
      this.emitRunSkipped(item, "budget_exceeded", issue, { runType });
      this.escalate(issue, runType, budgetExceeded);
      return;
    }

    if (!this.runWakePlanner.incrementAttemptCounters(
      issue,
      { projectId: issue.projectId, linearIssueId: issue.linearIssueId, leaseId },
      runType,
      isRequestedChangesRunType,
    )) {
      this.emitRunSkipped(item, "lease_lost_incrementing_attempts", issue, { runType });
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
      this.emitRunSkipped(item, "claim_failed", issue, { runType });
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
      this.db.issueSessions.commitIssueState({
        writer: WRITER,
        lease: { projectId: item.projectId, linearIssueId: item.issueId, leaseId },
        update: {
          projectId: item.projectId,
          linearIssueId: item.issueId,
          zombieRecoveryAttempts: 0,
          lastZombieRecoveryAt: null,
        },
      });
    }

    this.logger.info(
      { issueKey: issue.issueKey, runType, threadId, turnId },
      `Started ${runType} run`,
    );

    // Emit Linear activity + plan
    const freshIssue = this.db.issues.getIssue(item.projectId, item.issueId) ?? issue;
    const reviewComments = Array.isArray(effectiveContext?.reviewComments) ? effectiveContext.reviewComments : undefined;
    const reviewRoundActivity = runType === "review_fix"
      ? buildReviewRoundStartedActivity({
          round: Math.max(1, freshIssue.reviewFixAttempts),
          ...(typeof effectiveContext?.reviewerName === "string" ? { reviewerName: effectiveContext.reviewerName } : {}),
          ...(reviewComments ? { commentCount: reviewComments.length } : {}),
          ...(typeof sourceHeadSha === "string" ? { headSha: sourceHeadSha } : {}),
        })
      : undefined;
    void this.linearSync.emitActivity(freshIssue, reviewRoundActivity ?? buildRunStartedActivity(runType));
    void this.linearSync.syncSession(freshIssue, { activeRunType: runType });
  }

  private async resetWorktreeToTrackedBranch(
    worktreePath: string,
    branchName: string,
    issue: Pick<IssueRecord, "issueKey">,
  ): Promise<void> {
    await this.worktreeManager.resetWorktreeToTrackedBranch(worktreePath, branchName, issue, this.logger);
  }

  private emitRunSkipped(
    item: { projectId: string; issueId: string },
    reason: RunSkipReason,
    issue?: IssueRecord | undefined,
    details?: {
      runType?: RunType | undefined;
      activeRunId?: number | undefined;
      blockerCount?: number | undefined;
      remainingDelayMs?: number | undefined;
    },
  ): void {
    emitTelemetry(this.telemetry, {
      type: "run.skipped",
      projectId: item.projectId,
      linearIssueId: item.issueId,
      ...(issue?.issueKey ? { issueKey: issue.issueKey } : {}),
      reason,
      ...(details?.runType ? { runType: details.runType } : {}),
      ...(details?.activeRunId !== undefined ? { activeRunId: details.activeRunId } : {}),
      ...(details?.blockerCount !== undefined ? { blockerCount: details.blockerCount } : {}),
      ...(details?.remainingDelayMs !== undefined ? { remainingDelayMs: details.remainingDelayMs } : {}),
    });
  }

  private emitActiveRunBlockerInvariant(issue: IssueRecord): void {
    if (issue.activeRunId === undefined) return;
    const blockerCount = this.db.issues.countUnresolvedBlockers(issue.projectId, issue.linearIssueId);
    if (blockerCount === 0) return;
    emitTelemetry(this.telemetry, {
      type: "health.invariant",
      invariant: "active_run_with_unresolved_blocker",
      status: "observed",
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      ...(issue.issueKey ? { issueKey: issue.issueKey } : {}),
      runId: issue.activeRunId,
      blockerCount,
      detail: "Run dequeue found an active run while blockers are unresolved",
    });
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
    // Settle any issue whose active slot is pinned to an already-terminal
    // run (post-run finalize interrupted by restart). Must run before the
    // idle reconciler so the freed issue is routed in this same pass.
    this.settleDanglingActiveRuns();
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

  // Settle a dangling active slot: an issue still pointing at an
  // already-terminal run via `activeRunId`. The post-run finalize was
  // interrupted (almost always a restart between marking the run
  // terminal and clearing the slot), so the run can never drive the
  // session forward, yet every idle/recovery pass skips the issue
  // because `activeRunId` is set. settleRun is idempotent and its slot
  // clear is a predicate-guarded versioned commit, so no age gate is
  // needed — it cannot destructively race the notification finalizer.
  // The idle reconciler then routes the issue from GitHub truth (e.g. a
  // missed changes_requested → review_fix).
  private settleDanglingActiveRuns(): void {
    for (const issue of this.db.issues.listIssuesWithTerminalActiveRun()) {
      if (issue.activeRunId === undefined) continue;
      const run = this.db.runs.getRunById(issue.activeRunId);
      if (!run) continue;
      const lease = this.claimLeaseForReconciliation(run.projectId, run.linearIssueId);
      // "skip" → a live lease owns the session (a worker is mid-finalize or
      // mid-launch); settleRun could not corrupt its writes, but deferring
      // lets the owner land its richer post-run state first. "owned" → an
      // outer local scope holds it, so we must not release it here.
      if (lease === "skip") continue;
      try {
        // No `finish` outcome: the run is already terminal, and settleRun
        // leaves a run that raced back to non-terminal status untouched.
        const settled = this.withHeldIssueSessionLease(run.projectId, run.linearIssueId, (held) =>
          settleRun({ db: this.db, run, lease: held }),
        );
        if (settled?.slotCleared) {
          this.logger.warn(
            { issueKey: issue.issueKey, runId: run.id, runType: run.runType, runStatus: run.status },
            "Cleared dangling active-run slot left by a terminal run; idle reconcile will resume the issue",
          );
          this.feed?.publish({
            level: "warn",
            kind: "workflow",
            issueKey: issue.issueKey,
            projectId: run.projectId,
            stage: run.runType,
            status: "recovered",
            summary: `Cleared stuck active slot: run #${run.id} was ${run.status} but still held the issue`,
          });
        }
      } finally {
        if (lease !== "owned") this.releaseIssueSessionLease(run.projectId, run.linearIssueId);
      }
    }
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

  private resolveInactiveRequestedChangesWakeReason(
    issue: IssueRecord,
    runType: RunType,
    context: Record<string, unknown> | undefined,
  ): string | undefined {
    if (runType !== "review_fix" || context?.branchUpkeepRequired === true) {
      return undefined;
    }
    if (issue.prState && issue.prState !== "open") {
      return `Skipping requested-changes run because PR #${issue.prNumber ?? "unknown"} is ${issue.prState}`;
    }
    if (issue.prReviewState && issue.prReviewState !== "changes_requested") {
      return `Skipping requested-changes run because PR #${issue.prNumber ?? "unknown"} review state is ${issue.prReviewState}`;
    }
    return undefined;
  }

  private async readThreadWithRetry(threadId: string, maxRetries = 3): Promise<CodexThreadSummary> {
    let lastError: unknown;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        return await this.codex.readThread(threadId, true);
      } catch (error) {
        lastError = error;
        if (attempt === maxRetries - 1) {
          if (isThreadMaterializingError(error)) {
            throw new CodexThreadMaterializingError(threadId, maxRetries, error);
          }
          throw new Error(`Failed to read thread ${threadId} after ${maxRetries} attempts`, { cause: error });
        }
        await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
      }
    }
    if (isThreadMaterializingError(lastError)) {
      throw new CodexThreadMaterializingError(threadId, maxRetries, lastError);
    }
    throw new Error(`Failed to read thread ${threadId}`, { cause: lastError });
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
