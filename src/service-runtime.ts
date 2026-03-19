import type { Logger } from "pino";
import type { CodexAppServerClient } from "./codex-app-server.ts";
import type { ActiveStageRunReconciler, ReadyIssueSource } from "./workflow-ports.ts";
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

export interface ServiceRuntimeOptions {
  reconcileIntervalMs?: number;
  reconcileTimeoutMs?: number;
}

type LegacyReconcileActiveStageRuns = () => Promise<void>;
type LegacyListIssuesReadyForExecution = () => Array<{ projectId: string; linearIssueId: string }>;
type LegacyProcessWebhookEvent = (eventId: number) => Promise<void>;
type LegacyProcessIssue = (item: RuntimeIssueQueueItem) => Promise<void>;

function toReconciler(value: ActiveStageRunReconciler | LegacyReconcileActiveStageRuns): ActiveStageRunReconciler {
  if (typeof value === "function") {
    return {
      reconcileActiveStageRuns: value,
    };
  }
  return value;
}

function toReadyIssueSource(value: ReadyIssueSource | LegacyListIssuesReadyForExecution): ReadyIssueSource {
  if (typeof value === "function") {
    return {
      listIssuesReadyForExecution: value,
    };
  }
  return value;
}

function toWebhookProcessor(value: WebhookEventProcessor | LegacyProcessWebhookEvent): WebhookEventProcessor {
  if (typeof value === "function") {
    return {
      processWebhookEvent: value,
    };
  }
  return value;
}

function toIssueProcessor(value: IssueExecutionProcessor | LegacyProcessIssue): IssueExecutionProcessor {
  if (typeof value === "function") {
    return {
      processIssue: value,
    };
  }
  return value;
}

function makeIssueQueueKey(item: RuntimeIssueQueueItem): string {
  return `${item.projectId}${ISSUE_KEY_DELIMITER}${item.issueId}`;
}

// ServiceRuntime is the coordination seam for the harness. It is responsible for
// startup reconciliation, queue ownership, and handing eligible work to the stage runner.
export class ServiceRuntime {
  readonly webhookQueue: SerialWorkQueue<number>;
  readonly issueQueue: SerialWorkQueue<RuntimeIssueQueueItem>;
  private ready = false;
  private startupError: string | undefined;
  private reconcileTimer: ReturnType<typeof setTimeout> | undefined;
  private reconcileInProgress = false;

  constructor(
    private readonly codex: CodexAppServerClient,
    private readonly logger: Logger,
    stageRunReconciler: ActiveStageRunReconciler | LegacyReconcileActiveStageRuns,
    readyIssueSource: ReadyIssueSource | LegacyListIssuesReadyForExecution,
    webhookProcessor: WebhookEventProcessor | LegacyProcessWebhookEvent,
    issueProcessor: IssueExecutionProcessor | LegacyProcessIssue,
    private readonly options: ServiceRuntimeOptions = {},
  ) {
    this.stageRunReconciler = toReconciler(stageRunReconciler);
    this.readyIssueSource = toReadyIssueSource(readyIssueSource);
    this.webhookProcessor = toWebhookProcessor(webhookProcessor);
    this.issueProcessor = toIssueProcessor(issueProcessor);
    this.webhookQueue = new SerialWorkQueue((eventId) => this.webhookProcessor.processWebhookEvent(eventId), logger, (eventId) => String(eventId));
    this.issueQueue = new SerialWorkQueue((item) => this.issueProcessor.processIssue(item), logger, makeIssueQueueKey);
  }

  private readonly stageRunReconciler: ActiveStageRunReconciler;
  private readonly readyIssueSource: ReadyIssueSource;
  private readonly webhookProcessor: WebhookEventProcessor;
  private readonly issueProcessor: IssueExecutionProcessor;

  async start(): Promise<void> {
    try {
      await this.codex.start();
      // Reconciliation happens before new work is enqueued so restart recovery can
      // resolve or release any previously claimed work deterministically.
      await this.stageRunReconciler.reconcileActiveStageRuns();
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

  stop(): void {
    this.ready = false;
    this.clearBackgroundReconcile();
    void this.codex.stop();
  }

  enqueueWebhookEvent(eventId: number, options?: { priority?: boolean }): void {
    this.webhookQueue.enqueue(eventId, options);
  }

  enqueueIssue(projectId: string, issueId: string): void {
    this.issueQueue.enqueue({ projectId, issueId });
  }

  getReadiness() {
    return {
      ready: this.ready && this.codex.isStarted(),
      codexStarted: this.codex.isStarted(),
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
    if (!this.ready || !this.codex.isStarted()) {
      return;
    }
    if (this.reconcileInProgress) {
      this.scheduleBackgroundReconcile();
      return;
    }

    this.reconcileInProgress = true;
    try {
      await promiseWithTimeout(
        this.stageRunReconciler.reconcileActiveStageRuns(),
        this.options.reconcileTimeoutMs ?? DEFAULT_RECONCILE_TIMEOUT_MS,
        "Background active-stage reconciliation",
      );
    } catch (error) {
      this.logger.warn(
        {
          error: error instanceof Error ? error.message : String(error),
        },
        "Background active-stage reconciliation failed",
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
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}
