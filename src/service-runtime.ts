import type { Logger } from "pino";
import type { CodexAppServerClient } from "./codex-app-server.ts";
import type { ActiveStageRunReconciler, ReadyIssueSource } from "./db-ports.ts";
import { SerialWorkQueue } from "./service-queue.ts";

const ISSUE_KEY_DELIMITER = "::";

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

export class ServiceRuntime {
  readonly webhookQueue: SerialWorkQueue<number>;
  readonly issueQueue: SerialWorkQueue<RuntimeIssueQueueItem>;
  private ready = false;
  private startupError: string | undefined;

  constructor(
    private readonly codex: CodexAppServerClient,
    private readonly logger: Logger,
    stageRunReconciler: ActiveStageRunReconciler | LegacyReconcileActiveStageRuns,
    readyIssueSource: ReadyIssueSource | LegacyListIssuesReadyForExecution,
    webhookProcessor: WebhookEventProcessor | LegacyProcessWebhookEvent,
    issueProcessor: IssueExecutionProcessor | LegacyProcessIssue,
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
      await this.stageRunReconciler.reconcileActiveStageRuns();
      for (const issue of this.readyIssueSource.listIssuesReadyForExecution()) {
        this.enqueueIssue(issue.projectId, issue.linearIssueId);
      }
      this.ready = true;
      this.startupError = undefined;
    } catch (error) {
      this.ready = false;
      this.startupError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  stop(): void {
    this.ready = false;
    void this.codex.stop();
  }

  enqueueWebhookEvent(eventId: number): void {
    this.webhookQueue.enqueue(eventId);
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
}
