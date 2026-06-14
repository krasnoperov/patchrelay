import type { Logger } from "pino";
import type { CodexAppServerClient } from "./codex-app-server.ts";
import { SerialWorkQueue } from "./service-queue.ts";
import { retrySqliteLockedQueueFailure } from "./queue-failure-policy.ts";
import { isSqliteSchemaReadError } from "./sqlite-errors.ts";

const ISSUE_KEY_DELIMITER = "::";
const DEFAULT_RECONCILE_INTERVAL_MS = 5_000;
const DEFAULT_RECONCILE_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_ACTIVE_ISSUE_RUNS = 4;
const DEFAULT_ISSUE_RUN_CAPACITY_RETRY_DELAY_MS = 5_000;
const EVENT_LOOP_MONITOR_INTERVAL_MS = 1_000;

export interface RuntimeIssueQueueItem {
  projectId: string;
  issueId: string;
}

export interface WebhookEventProcessor {
  processWebhookEvent(eventId: number): Promise<void>;
}

export interface IssueExecutionProcessor {
  processIssue(item: RuntimeIssueQueueItem): Promise<void>;
}

export interface ActiveRunReconciler {
  reconcileActiveRuns(): Promise<void>;
}

export interface ReadyIssueSource {
  listIssuesReadyForExecution(): Array<{ projectId: string; linearIssueId: string }>;
  countActiveIssueRuns?(): number;
}

export interface ServiceRuntimeOptions {
  reconcileIntervalMs?: number;
  reconcileTimeoutMs?: number;
  maxActiveIssueRuns?: number;
  issueRunCapacityRetryDelayMs?: number;
  assertStorageReady?: () => void;
  describeStorage?: () => Record<string, unknown>;
}

function makeIssueQueueKey(item: RuntimeIssueQueueItem): string {
  return `${item.projectId}${ISSUE_KEY_DELIMITER}${item.issueId}`;
}

export class ServiceRuntime {
  readonly webhookQueue: SerialWorkQueue<number>;
  readonly issueQueue: SerialWorkQueue<RuntimeIssueQueueItem>;
  private ready = false;
  private linearConnected = false;
  private githubAppAuthHealthy = true;
  private githubAppAuthError: string | undefined;
  private startupError: string | undefined;
  private reconcileTimer: ReturnType<typeof setTimeout> | undefined;
  private eventLoopMonitorTimer: ReturnType<typeof setInterval> | undefined;
  private eventLoopMonitorExpectedAt = 0;
  private eventLoopLagMs = 0;
  private reconcileInProgress = false;

  constructor(
    private readonly codex: CodexAppServerClient,
    private readonly logger: Logger,
    private readonly runReconciler: ActiveRunReconciler,
    private readonly readyIssueSource: ReadyIssueSource,
    webhookProcessor: WebhookEventProcessor,
    issueProcessor: IssueExecutionProcessor,
    private readonly options: ServiceRuntimeOptions = {},
  ) {
    this.webhookQueue = new SerialWorkQueue((eventId) => webhookProcessor.processWebhookEvent(eventId), logger, (eventId) => String(eventId));
    this.issueQueue = new SerialWorkQueue((item) => this.processIssueWithCapacity(item, issueProcessor), logger, makeIssueQueueKey, {
      retryOnError: (error, _item, attempt) => {
        if (error instanceof IssueRunCapacityFullError) {
          return {
            delayMs: this.getIssueRunCapacityRetryDelayMs(),
            logLevel: "debug",
            message: "Issue run capacity is full; keeping item queued for retry",
          };
        }
        return retrySqliteLockedQueueFailure(error, attempt);
      },
    });
  }

  async start(): Promise<void> {
    try {
      await this.codex.start();
      this.startEventLoopMonitor();
      for (const issue of this.readyIssueSource.listIssuesReadyForExecution()) {
        this.enqueueIssue(issue.projectId, issue.linearIssueId);
      }
      this.ready = true;
      this.startupError = undefined;
      void this.runBackgroundReconcile();
    } catch (error) {
      this.ready = false;
      this.startupError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.ready = false;
    this.clearBackgroundReconcile();
    this.clearEventLoopMonitor();
    await this.codex.stop();
  }

  enqueueWebhookEvent(eventId: number, options?: { priority?: boolean }): void {
    this.webhookQueue.enqueue(eventId, options);
  }

  enqueueIssue(projectId: string, issueId: string): void {
    this.issueQueue.enqueue({ projectId, issueId });
  }

  setLinearConnected(connected: boolean): void {
    this.linearConnected = connected;
  }

  setGithubAppAuthHealthy(healthy: boolean, reason?: string): void {
    this.githubAppAuthHealthy = healthy;
    this.githubAppAuthError = healthy ? undefined : reason;
  }

  getReadiness() {
    return {
      ready: this.ready && this.codex.isStarted() && this.linearConnected && this.githubAppAuthHealthy,
      codexStarted: this.codex.isStarted(),
      linearConnected: this.linearConnected,
      githubAppAuthHealthy: this.githubAppAuthHealthy,
      eventLoopLagMs: this.eventLoopLagMs,
      ...(this.githubAppAuthError ? { githubAppAuthError: this.githubAppAuthError } : {}),
      ...(this.startupError ? { startupError: this.startupError } : {}),
    };
  }

  private startEventLoopMonitor(): void {
    this.clearEventLoopMonitor();
    this.eventLoopMonitorExpectedAt = Date.now() + EVENT_LOOP_MONITOR_INTERVAL_MS;
    const timer = setInterval(() => {
      const now = Date.now();
      this.eventLoopLagMs = Math.max(0, now - this.eventLoopMonitorExpectedAt);
      this.eventLoopMonitorExpectedAt = now + EVENT_LOOP_MONITOR_INTERVAL_MS;
    }, EVENT_LOOP_MONITOR_INTERVAL_MS);
    timer.unref?.();
    this.eventLoopMonitorTimer = timer;
  }

  private clearEventLoopMonitor(): void {
    if (this.eventLoopMonitorTimer !== undefined) {
      clearInterval(this.eventLoopMonitorTimer);
      this.eventLoopMonitorTimer = undefined;
    }
    this.eventLoopLagMs = 0;
  }

  private scheduleBackgroundReconcile(): void {
    this.clearBackgroundReconcile();
    const timer = setTimeout(() => {
      void this.runBackgroundReconcile();
    }, this.options.reconcileIntervalMs ?? DEFAULT_RECONCILE_INTERVAL_MS);
    timer.unref?.();
    this.reconcileTimer = timer;
  }

  private clearBackgroundReconcile(): void {
    if (this.reconcileTimer !== undefined) {
      clearTimeout(this.reconcileTimer);
      this.reconcileTimer = undefined;
    }
  }

  private async runBackgroundReconcile(): Promise<void> {
    if (!this.ready || !this.codex.isStarted()) return;
    if (this.reconcileInProgress) {
      this.scheduleBackgroundReconcile();
      return;
    }

    this.reconcileInProgress = true;
    try {
      await this.reconcileActiveRunsWithSchemaRetry();
      // Pick up issues that became ready outside the webhook path
      // (e.g. CLI retry, manual DB edits) without requiring a restart.
      for (const issue of this.readyIssueSource.listIssuesReadyForExecution()) {
        this.enqueueIssue(issue.projectId, issue.linearIssueId);
      }
    } catch (error) {
      this.logger.warn(
        {
          error: error instanceof Error ? error.message : String(error),
          storage: this.safeStorageDiagnostics(),
        },
        "Background active-run reconciliation failed",
      );
    } finally {
      this.reconcileInProgress = false;
      if (this.ready) {
        this.scheduleBackgroundReconcile();
      }
    }
  }

  private async reconcileActiveRunsWithSchemaRetry(): Promise<void> {
    try {
      await this.reconcileActiveRunsOnce();
    } catch (error) {
      if (!isSqliteSchemaReadError(error) || !this.options.assertStorageReady) {
        throw error;
      }
      this.options.assertStorageReady();
      await new Promise((resolve) => setTimeout(resolve, 100));
      await this.reconcileActiveRunsOnce();
    }
  }

  private async reconcileActiveRunsOnce(): Promise<void> {
    await promiseWithTimeout(
      this.runReconciler.reconcileActiveRuns(),
      this.options.reconcileTimeoutMs ?? DEFAULT_RECONCILE_TIMEOUT_MS,
      "Background active-run reconciliation",
    );
  }

  private safeStorageDiagnostics(): Record<string, unknown> | undefined {
    try {
      return this.options.describeStorage?.();
    } catch {
      return undefined;
    }
  }

  private getMaxActiveIssueRuns(): number {
    const configured = this.options.maxActiveIssueRuns ?? DEFAULT_MAX_ACTIVE_ISSUE_RUNS;
    return Math.max(1, Math.floor(configured));
  }

  private getIssueRunCapacityRetryDelayMs(): number {
    const configured = this.options.issueRunCapacityRetryDelayMs ?? DEFAULT_ISSUE_RUN_CAPACITY_RETRY_DELAY_MS;
    return Math.max(1, Math.floor(configured));
  }

  private getActiveIssueRunCount(): number {
    return Math.max(0, this.readyIssueSource.countActiveIssueRuns?.() ?? 0);
  }

  private async processIssueWithCapacity(item: RuntimeIssueQueueItem, processor: IssueExecutionProcessor): Promise<void> {
    const activeIssueRuns = this.getActiveIssueRunCount();
    const maxActiveIssueRuns = this.getMaxActiveIssueRuns();
    if (activeIssueRuns >= maxActiveIssueRuns) {
      throw new IssueRunCapacityFullError(activeIssueRuns, maxActiveIssueRuns);
    }
    await processor.processIssue(item);
  }
}

class IssueRunCapacityFullError extends Error {
  constructor(readonly activeIssueRuns: number, readonly maxActiveIssueRuns: number) {
    super(`active issue run capacity is full (${activeIssueRuns}/${maxActiveIssueRuns})`);
    this.name = "IssueRunCapacityFullError";
  }
}

function promiseWithTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timeout.unref?.();
    promise.then(
      (value) => { clearTimeout(timeout); resolve(value); },
      (error) => { clearTimeout(timeout); reject(error); },
    );
  });
}
