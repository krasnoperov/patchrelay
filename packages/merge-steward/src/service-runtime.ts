import type { Logger } from "pino";
import type { GitOperations, CIRunner, GitHubPRApi, EvictionReporter, SpeculativeBranchBuilder } from "./interfaces.ts";
import type { QueueStore } from "./store.ts";
import type { CheckResult, QueueBlockState, QueueRuntimeStatus, ReconcileEvent } from "./types.ts";
import type { StewardConfig } from "./config.ts";
import { reconcile } from "./reconciler.ts";

export class MergeStewardRuntime {
  private tickTimer: ReturnType<typeof setTimeout> | undefined;
  private tickInProgress = false;
  private lastTickStartedAt: string | null = null;
  private lastTickCompletedAt: string | null = null;
  private lastTickOutcome: QueueRuntimeStatus["lastTickOutcome"] = "idle";
  private lastTickError: string | null = null;
  private currentQueueBlock: QueueBlockState | null = null;

  constructor(
    private readonly config: StewardConfig,
    private readonly store: QueueStore,
    private readonly git: GitOperations,
    private readonly ci: CIRunner,
    private readonly github: GitHubPRApi,
    private readonly eviction: EvictionReporter,
    private readonly specBuilder: SpeculativeBranchBuilder,
    private readonly logger: Logger,
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
    const deadline = Date.now() + 10_000;
    while (this.tickInProgress && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    this.logger.info("Steward service stopped");
  }

  async triggerReconcile(): Promise<{ started: boolean; runtime: QueueRuntimeStatus }> {
    const started = await this.runTick();
    return {
      started,
      runtime: this.getRuntimeStatus(),
    };
  }

  getRuntimeStatus(): QueueRuntimeStatus {
    return {
      tickInProgress: this.tickInProgress,
      lastTickStartedAt: this.lastTickStartedAt,
      lastTickCompletedAt: this.lastTickCompletedAt,
      lastTickOutcome: this.lastTickOutcome,
      lastTickError: this.lastTickError,
    };
  }

  getCurrentQueueBlock(): QueueBlockState | null {
    return this.currentQueueBlock;
  }

  private scheduleNextTick(): void {
    if (this.tickTimer) {
      clearTimeout(this.tickTimer);
    }
    this.tickTimer = setTimeout(() => void this.runTick(), this.config.pollIntervalMs);
    this.tickTimer.unref?.();
  }

  private async runTick(): Promise<boolean> {
    if (this.tickInProgress) return false;
    this.tickInProgress = true;
    this.lastTickStartedAt = new Date().toISOString();
    this.lastTickOutcome = "running";
    this.lastTickError = null;
    try {
      let tickQueueBlockEvent: ReconcileEvent | null = null;
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
        onEvent: (event) => {
          const isWarn = event.action === "evicted" || event.action === "spec_build_conflict"
            || event.action === "ci_failed"
            || event.action === "merge_rejected" || event.action === "budget_exhausted";
          const isDebug = event.action === "ci_pending" || event.action === "retry_gated"
            || event.action === "fetch_started";
          const level = isWarn ? "warn" : isDebug ? "debug" : "info";
          this.logger[level]({ ...event }, `Queue: ${event.action} PR #${event.prNumber}`);

          if (event.action === "main_broken" && tickQueueBlockEvent === null) {
            tickQueueBlockEvent = event;
          }
        },
      });
      this.currentQueueBlock = tickQueueBlockEvent ? await this.describeMainBroken(tickQueueBlockEvent) : null;
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
      this.tickInProgress = false;
      this.lastTickCompletedAt = new Date().toISOString();
      this.scheduleNextTick();
    }
    return true;
  }

  private async describeMainBroken(event: ReconcileEvent): Promise<QueueBlockState> {
    const baseRef = `origin/${this.config.baseBranch}`;
    let baseSha: string | null = null;
    try {
      baseSha = await this.git.headSha(baseRef);
    } catch {
      try {
        baseSha = await this.git.headSha(this.config.baseBranch);
      } catch {
        baseSha = event.baseSha ?? null;
      }
    }

    const checkRef = event.baseSha ?? baseSha ?? baseRef;
    let checks: CheckResult[] = [];
    try {
      checks = await this.github.listChecksForRef(checkRef);
    } catch {
      checks = [];
    }

    return {
      reason: "main_broken",
      entryId: event.entryId,
      headPrNumber: event.prNumber,
      baseBranch: this.config.baseBranch,
      baseSha,
      observedAt: event.at,
      failingChecks: event.failingChecks ?? checks.filter((check) => check.conclusion === "failure"),
      pendingChecks: event.pendingChecks ?? checks.filter((check) => check.conclusion === "pending"),
    };
  }
}
