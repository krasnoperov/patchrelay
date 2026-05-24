import type { Logger } from "pino";
import type { GitOperations, CIRunner, GitHubPRApi, EvictionReporter, SpeculativeBranchBuilder } from "./interfaces.ts";
import type { QueueStore } from "./store.ts";
import type { QueueBlockState, QueueReconcileResult, QueueRuntimeStatus, ReconcileEvent, ReconcileEventSummary } from "./types.ts";
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
  // The queue never blocks on main CI, so this stays null; kept for status-shape stability.
  private currentQueueBlock: QueueBlockState | null = null;

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
  ) {}

  async start(): Promise<void> {
    this.logger.info({ pollIntervalMs: this.config.pollIntervalMs }, "Steward service starting");
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

  getCurrentQueueBlock(): QueueBlockState | null {
    return this.currentQueueBlock;
  }

  getGitHubPolicy() {
    return this.policy.getSnapshot();
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

  private scheduleStaleTickWarning(startedAt: string): void {
    this.clearStaleTickTimer();
    const timer = setTimeout(() => {
      if (!this.tickInProgress || this.lastTickStartedAt !== startedAt) return;
      const runtime = this.getRuntimeStatus();
      this.logger.warn(
        {
          startedAt,
          tickAgeMs: runtime.tickAgeMs,
          staleTickThresholdMs: runtime.staleTickThresholdMs,
          lastReconcileEvent: runtime.lastReconcileEvent,
        },
        "Reconcile tick appears stale",
      );
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
    this.scheduleStaleTickWarning(this.lastTickStartedAt);
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
          const isWarn = event.action === "evicted" || event.action === "spec_build_conflict"
            || event.action === "ci_failed"
            || event.action === "merge_rejected" || event.action === "budget_exhausted";
          const isDebug = event.action === "ci_pending" || event.action === "retry_gated"
            || event.action === "fetch_started";
          const level: "warn" | "debug" | "info" = isWarn ? "warn" : isDebug ? "debug" : "info";
          this.logger[level]({ ...event }, `Queue: ${event.action} PR #${event.prNumber}`);
        },
      });
      // The queue never blocks on main CI — main health is information-only.
      this.currentQueueBlock = null;
      this.lastTickOutcome = "succeeded";
    } catch (error) {
      this.lastTickOutcome = "failed";
      this.currentQueueBlock = null;
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
    ...(event.specBranch ? { specBranch: event.specBranch } : {}),
  };
}
