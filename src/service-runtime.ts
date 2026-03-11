import type { Logger } from "pino";
import type { CodexAppServerClient } from "./codex-app-server.ts";
import { SerialWorkQueue } from "./service-queue.ts";

const ISSUE_KEY_DELIMITER = "::";

export interface RuntimeIssueQueueItem {
  projectId: string;
  issueId: string;
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
    private readonly reconcileActiveStageRuns: () => Promise<void>,
    private readonly listIssuesReadyForExecution: () => Array<{ projectId: string; linearIssueId: string }>,
    private readonly processWebhookEvent: (eventId: number) => Promise<void>,
    private readonly processIssue: (item: RuntimeIssueQueueItem) => Promise<void>,
  ) {
    this.webhookQueue = new SerialWorkQueue((eventId) => this.processWebhookEvent(eventId), logger, (eventId) => String(eventId));
    this.issueQueue = new SerialWorkQueue((item) => this.processIssue(item), logger, makeIssueQueueKey);
  }

  async start(): Promise<void> {
    try {
      await this.codex.start();
      await this.reconcileActiveStageRuns();
      for (const issue of this.listIssuesReadyForExecution()) {
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
