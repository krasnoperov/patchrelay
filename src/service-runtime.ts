import type { Logger } from "pino";
import type { CodexAppServerClient } from "./codex-app-server.ts";
import { SerialWorkQueue } from "./service-queue.ts";

const ISSUE_KEY_DELIMITER = "::";
const DEFAULT_RECONCILE_INTERVAL_MS = 5_000;
const DEFAULT_RECONCILE_TIMEOUT_MS = 60_000;

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
}

export interface ServiceRuntimeOptions {
  reconcileIntervalMs?: number;
  reconcileTimeoutMs?: number;
}

function makeIssueQueueKey(item: RuntimeIssueQueueItem): string {
  return `${item.projectId}${ISSUE_KEY_DELIMITER}${item.issueId}`;
}

export class ServiceRuntime {
  readonly webhookQueue: SerialWorkQueue<number>;
  readonly issueQueue: SerialWorkQueue<RuntimeIssueQueueItem>;
  private ready = false;
  private linearConnected = false;
  private startupError: string | undefined;
  private reconcileTimer: ReturnType<typeof setTimeout> | undefined;
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
    this.issueQueue = new SerialWorkQueue((item) => issueProcessor.processIssue(item), logger, makeIssueQueueKey);
  }

  async start(): Promise<void> {
    try {
      await this.codex.start();
      await this.runReconciler.reconcileActiveRuns();
      for (const issue of this.readyIssueSource.listIssuesReadyForExecution()) {
        this.enqueueIssue(issue.projectId, issue.linearIssueId);
      }
      this.ready = true;
      this.startupError = undefined;
      this.scheduleBackgroundReconcile();
    } catch (error) {
      this.ready = false;
      this.startupError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.ready = false;
    this.clearBackgroundReconcile();
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

  getReadiness() {
    return {
      ready: this.ready && this.codex.isStarted() && this.linearConnected,
      codexStarted: this.codex.isStarted(),
      linearConnected: this.linearConnected,
      ...(this.startupError ? { startupError: this.startupError } : {}),
    };
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
      await promiseWithTimeout(
        this.runReconciler.reconcileActiveRuns(),
        this.options.reconcileTimeoutMs ?? DEFAULT_RECONCILE_TIMEOUT_MS,
        "Background active-run reconciliation",
      );
      // Pick up issues that became ready outside the webhook path
      // (e.g. CLI retry, manual DB edits) without requiring a restart.
      for (const issue of this.readyIssueSource.listIssuesReadyForExecution()) {
        this.enqueueIssue(issue.projectId, issue.linearIssueId);
      }
    } catch (error) {
      this.logger.warn(
        { error: error instanceof Error ? error.message : String(error) },
        "Background active-run reconciliation failed",
      );
    } finally {
      this.reconcileInProgress = false;
      if (this.ready) {
        this.scheduleBackgroundReconcile();
      }
    }
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
