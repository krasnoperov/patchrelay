import type { Logger } from "pino";
import type { GitOperations, CIRunner, GitHubPRApi, EvictionReporter, SpeculativeBranchBuilder } from "./interfaces.ts";
import type { QueueStore } from "./store.ts";
import type { QueueReconcileResult, QueueRuntimeStatus, ReconcileEvent, ReconcileEventSummary } from "./types.ts";
import type { StewardConfig } from "./config.ts";
import type { GitHubPolicyCache } from "./github-policy.ts";
import { reconcile } from "./reconciler.ts";

export class MergeStewardRuntime {
  private tickTimer: ReturnType<typeof setTimeout> | undefined;
  private staleTickTimer: ReturnType<typeof setTimeout> | undefined;
  private tickInProgress = false;
  private lastTickStartedAt: string | null = null;
  private lastTickCompletedAt: string | null = null;
  private lastTickOutcome: QueueRuntimeStatus["lastTickOutcome"] = "idle";
  private lastTickError: string | null = null;
  private lastReconcileEvent: ReconcileEventSummary | null = null;
  private watchdogTickStartedAt: string | null = null;

  constructor(
    private readonly config: StewardConfig,
    private readonly policy: GitHubPolicyCache,
    private readonly store: QueueStore,
    private readonly git: GitOperations,
    private readonly ci: CIRunner,
    private readonly github: GitHubPRApi,
    private readonly eviction: EvictionReporter,
    private readonly specBuilder: SpeculativeBranchBuilder,
    private readonly logger: Logger,
    private readonly beforeTick?: (() => Promise<void>) | undefined,
    private readonly onReconcileWatchdog?: ((runtime: QueueRuntimeStatus) => Promise<void> | void) | undefined,
  ) {}

  async start(): Promise<void> {
    this.logger.info({ pollIntervalMs: this.config.pollIntervalMs }, "Steward service starting");
    await this.recoverTerminalQueueLabels();
    this.scheduleNextTick();
  }

  async stop(): Promise<void> {
    if (this.tickTimer) {
      clearTimeout(this.tickTimer);
      this.tickTimer = undefined;
    }
    this.clearStaleTickTimer();
    const deadline = Date.now() + 10_000;
    while (this.tickInProgress && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (this.tickInProgress) {
      this.logger.warn(
        { runtime: this.getRuntimeStatus() },
        "Stopping while a reconcile tick is still active; process restart will recover from durable queue state",
      );
    }
    this.logger.info("Steward service stopped");
  }

  async triggerReconcile(): Promise<QueueReconcileResult> {
    const started = await this.runTick();
    return {
      started,
      ...(!started ? { reason: "already_running" as const } : {}),
      runtime: this.getRuntimeStatus(),
    };
  }

  getRuntimeStatus(): QueueRuntimeStatus {
    const tickAgeMs = this.getTickAgeMs();
    const staleTickThresholdMs = this.config.reconcileStaleAfterMs;
    return {
      tickInProgress: this.tickInProgress,
      lastTickStartedAt: this.lastTickStartedAt,
      lastTickCompletedAt: this.lastTickCompletedAt,
      lastTickOutcome: this.lastTickOutcome,
      lastTickError: this.lastTickError,
      tickAgeMs,
      staleTickThresholdMs,
      staleTick: tickAgeMs !== null && tickAgeMs >= staleTickThresholdMs,
      lastReconcileEvent: this.lastReconcileEvent,
    };
  }

  getGitHubPolicy() {
    return this.policy.getSnapshot();
  }

  private async recoverTerminalQueueLabels(): Promise<void> {
    const managed = [this.config.queueTestingLabel, this.config.queueMergingLabel].filter(Boolean);
    if (managed.length === 0) return;

    // A crash can happen after the durable terminal transition but before the
    // best-effort label edit. At most the newest landing can be in that window;
    // checking three recent rows leaves margin without scanning queue history.
    for (const entry of this.store.listRecentTerminal(this.config.repoId, 3)) {
      try {
        const current = await this.github.listLabels(entry.prNumber);
        const remove = managed.filter((label) => current.includes(label));
        if (remove.length === 0) continue;
        await this.github.setLabels(entry.prNumber, { remove });
        this.logger.info({
          prNumber: entry.prNumber,
          entryId: entry.id,
          labels: remove,
        }, "Recovered stale queue labels from a terminal entry");
      } catch (error) {
        // Webhooks and later restarts provide another cleanup opportunity.
        this.logger.warn({
          prNumber: entry.prNumber,
          entryId: entry.id,
          err: error,
        }, "Could not recover terminal queue labels");
      }
    }
  }

  private scheduleNextTick(): void {
    if (this.tickTimer) {
      clearTimeout(this.tickTimer);
    }
    this.tickTimer = setTimeout(() => void this.runTick(), this.config.pollIntervalMs);
    this.tickTimer.unref?.();
  }

  private getTickAgeMs(): number | null {
    if (!this.tickInProgress || !this.lastTickStartedAt) return null;
    const startedMs = Date.parse(this.lastTickStartedAt);
    if (!Number.isFinite(startedMs)) return null;
    return Math.max(0, Date.now() - startedMs);
  }

  private scheduleReconcileWatchdog(startedAt: string): void {
    this.clearStaleTickTimer();
    const timer = setTimeout(() => {
      if (!this.tickInProgress || this.lastTickStartedAt !== startedAt) return;
      this.staleTickTimer = undefined;
      this.watchdogTickStartedAt = startedAt;
      this.lastTickOutcome = "failed";
      this.lastTickError = `Reconcile tick exceeded the ${this.config.reconcileStaleAfterMs}ms stale threshold; service restart requested.`;
      const runtime = this.getRuntimeStatus();
      this.logger.error(
        {
          startedAt,
          tickAgeMs: runtime.tickAgeMs,
          staleTickThresholdMs: runtime.staleTickThresholdMs,
          lastReconcileEvent: runtime.lastReconcileEvent,
        },
        "Reconcile watchdog detected a stuck tick; requesting service restart",
      );
      void (async () => {
        await this.onReconcileWatchdog?.(runtime);
      })().catch((error) => {
        this.logger.error(
          { startedAt, error: error instanceof Error ? error.message : String(error) },
          "Reconcile watchdog could not restart the service",
        );
      });
    }, this.config.reconcileStaleAfterMs);
    timer.unref?.();
    this.staleTickTimer = timer;
  }

  private clearStaleTickTimer(): void {
    if (this.staleTickTimer) {
      clearTimeout(this.staleTickTimer);
      this.staleTickTimer = undefined;
    }
  }

  private async runTick(): Promise<boolean> {
    if (this.tickInProgress) return false;
    this.tickInProgress = true;
    this.lastTickStartedAt = new Date().toISOString();
    this.lastTickOutcome = "running";
    this.lastTickError = null;
    this.lastReconcileEvent = null;
    this.watchdogTickStartedAt = null;
    const startedAt = this.lastTickStartedAt;
    this.scheduleReconcileWatchdog(startedAt);
    try {
      await this.beforeTick?.();
      await reconcile({
        store: this.store,
        repoId: this.config.repoId,
        baseBranch: this.config.baseBranch,
        remotePrefix: "origin/",
        git: this.git,
        ci: this.ci,
        github: this.github,
        specBuilder: this.specBuilder,
        speculativeDepth: this.config.speculativeDepth,
        eviction: this.eviction,
        flakyRetries: this.config.flakyRetries,
        policy: this.policy,
        queueStateLabels: {
          testing: this.config.queueTestingLabel,
          merging: this.config.queueMergingLabel,
        },
        onEvent: (event) => {
          this.lastReconcileEvent = summarizeReconcileEvent(event);
          const isWarn = event.action === "evicted" || event.action === "integration_build_conflict"
            || event.action === "ci_failed"
            || event.action === "merge_rejected" || event.action === "budget_exhausted";
          const isDebug = event.action === "ci_pending" || event.action === "retry_gated"
            || event.action === "fetch_started";
          const level: "warn" | "debug" | "info" = isWarn ? "warn" : isDebug ? "debug" : "info";
          this.logger[level]({ ...event }, `Queue: ${event.action} PR #${event.prNumber}`);
        },
      });
      if (this.watchdogTickStartedAt !== startedAt) {
        this.lastTickOutcome = "succeeded";
      }
    } catch (error) {
      this.lastTickOutcome = "failed";
      this.lastTickError = error instanceof Error
        ? `${error.message}${error.stack ? `\n${error.stack}` : ""}`
        : String(error);
      this.logger.error(
        { err: error instanceof Error ? { message: error.message, stack: error.stack } : error },
        "Reconcile tick failed",
      );
    } finally {
      this.clearStaleTickTimer();
      this.tickInProgress = false;
      this.lastTickCompletedAt = new Date().toISOString();
      this.scheduleNextTick();
    }
    return true;
  }
}

function summarizeReconcileEvent(event: ReconcileEvent): ReconcileEventSummary {
  return {
    at: event.at,
    entryId: event.entryId,
    prNumber: event.prNumber,
    action: event.action,
    ...(event.detail ? { detail: event.detail } : {}),
    ...(event.ciRunId ? { ciRunId: event.ciRunId } : {}),
    ...(event.candidateRef ? { candidateRef: event.candidateRef } : {}),
    ...(event.candidateKind ? { candidateKind: event.candidateKind } : {}),
    ...(event.candidateSha ? { candidateSha: event.candidateSha } : {}),
  };
}
