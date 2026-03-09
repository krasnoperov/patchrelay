import path from "node:path";
import type { Logger } from "pino";
import { CodexAppServerClient, type CodexNotification } from "./codex-app-server.js";
import { PatchRelayDatabase } from "./db.js";
import { resolveProject, triggerEventAllowed } from "./project-resolution.js";
import { SerialWorkQueue } from "./service-queue.js";
import { ServiceStageFinalizer } from "./service-stage-finalizer.js";
import { type IssueQueueItem, ServiceStageRunner } from "./service-stage-runner.js";
import { acceptIncomingWebhook } from "./service-webhooks.js";
import { summarizeCurrentThread } from "./stage-reporting.js";
import type { AppConfig, LinearWebhookPayload, StageReport, StageRunRecord, TrackedIssueRecord } from "./types.js";
import { safeJsonParse } from "./utils.js";
import { normalizeWebhook } from "./webhooks.js";
import { resolveWorkflowStage } from "./workflow-policy.js";

const ISSUE_KEY_DELIMITER = "::";

function makeIssueQueueKey(item: IssueQueueItem): string {
  return `${item.projectId}${ISSUE_KEY_DELIMITER}${item.issueId}`;
}

export class PatchRelayService {
  readonly webhookQueue: SerialWorkQueue<number>;
  readonly issueQueue: SerialWorkQueue<IssueQueueItem>;
  private readonly stageRunner: ServiceStageRunner;
  private readonly stageFinalizer: ServiceStageFinalizer;

  constructor(
    readonly config: AppConfig,
    readonly db: PatchRelayDatabase,
    readonly codex: CodexAppServerClient,
    readonly logger: Logger,
  ) {
    this.stageRunner = new ServiceStageRunner(config, db, codex, logger);
    this.stageFinalizer = new ServiceStageFinalizer(db, codex, (projectId, issueId) => this.enqueueIssue(projectId, issueId));
    this.webhookQueue = new SerialWorkQueue((eventId) => this.processWebhookEvent(eventId), logger, (eventId) => String(eventId));
    this.issueQueue = new SerialWorkQueue((item) => this.processIssue(item), logger, makeIssueQueueKey);
    this.codex.on("notification", (notification: CodexNotification) => {
      void this.stageFinalizer.handleCodexNotification(notification);
    });
  }

  async start(): Promise<void> {
    await this.codex.start();
    await this.stageFinalizer.reconcileActiveStageRuns();
    for (const issue of this.db.listIssuesReadyForExecution()) {
      this.enqueueIssue(issue.projectId, issue.linearIssueId);
    }
  }

  stop(): void {
    void this.codex.stop();
  }

  async acceptWebhook(params: {
    webhookId: string;
    headers: Record<string, string | string[] | undefined>;
    rawBody: Buffer;
  }): Promise<{
    status: number;
    body: Record<string, string | number | boolean>;
  }> {
    const result = await acceptIncomingWebhook({
      config: this.config,
      db: this.db,
      logger: this.logger,
      webhookId: params.webhookId,
      headers: params.headers,
      rawBody: params.rawBody,
    });
    if (result.accepted) {
      this.webhookQueue.enqueue(result.accepted.id);
    }
    return {
      status: result.status,
      body: result.body,
    };
  }

  async processWebhookEvent(webhookEventId: number): Promise<void> {
    const event = this.db.getWebhookEvent(webhookEventId);
    if (!event) {
      return;
    }

    const payload = safeJsonParse<LinearWebhookPayload>(event.payloadJson);
    if (!payload) {
      this.db.markWebhookProcessed(webhookEventId, "failed");
      throw new Error(`Stored webhook payload is invalid JSON: event ${webhookEventId}`);
    }

    const normalized = normalizeWebhook({
      webhookId: event.webhookId,
      payload,
    });
    const project = resolveProject(this.config, normalized.issue);
    if (!project) {
      this.db.markWebhookProcessed(webhookEventId, "processed");
      return;
    }

    this.db.assignWebhookProject(webhookEventId, project.id);
    const desiredStage = triggerEventAllowed(project, normalized.triggerEvent)
      ? resolveWorkflowStage(project, normalized.issue.stateName)
      : undefined;

    this.db.recordDesiredStage({
      projectId: project.id,
      linearIssueId: normalized.issue.id,
      ...(normalized.issue.identifier ? { issueKey: normalized.issue.identifier } : {}),
      ...(normalized.issue.title ? { title: normalized.issue.title } : {}),
      ...(normalized.issue.url ? { issueUrl: normalized.issue.url } : {}),
      ...(normalized.issue.stateName ? { currentLinearState: normalized.issue.stateName } : {}),
      ...(desiredStage ? { desiredStage } : {}),
      ...(desiredStage ? { desiredWebhookId: normalized.webhookId } : {}),
      lastWebhookAt: new Date().toISOString(),
    });

    this.db.markWebhookProcessed(webhookEventId, "processed");
    if (desiredStage) {
      this.enqueueIssue(project.id, normalized.issue.id);
    }
  }

  async processIssue(item: IssueQueueItem): Promise<void> {
    await this.stageRunner.run(item);
  }

  async getIssueOverview(issueKey: string) {
    const result = this.db.getIssueOverview(issueKey);
    if (!result) {
      return undefined;
    }

    const latestStageRun = this.db.getLatestStageRunForIssue(result.issue.projectId, result.issue.linearIssueId);
    let liveThread;
    if (result.activeStageRun?.threadId) {
      liveThread = await this.codex.readThread(result.activeStageRun.threadId, true).catch(() => undefined);
    }

    return {
      ...result,
      ...(latestStageRun ? { latestStageRun } : {}),
      ...(liveThread ? { liveThread: summarizeCurrentThread(liveThread) } : {}),
    };
  }

  async getIssueReport(issueKey: string): Promise<
    | {
        issue: TrackedIssueRecord;
        stages: Array<{
          stageRun: StageRunRecord;
          report?: StageReport;
        }>;
      }
    | undefined
  > {
    const issue = this.db.getTrackedIssueByKey(issueKey);
    if (!issue) {
      return undefined;
    }

    return {
      issue,
      stages: this.db.listStageRunsForIssue(issue.projectId, issue.linearIssueId).map((stageRun) => ({
        stageRun,
        ...(stageRun.reportJson ? { report: JSON.parse(stageRun.reportJson) as StageReport } : {}),
      })),
    };
  }

  async getStageEvents(issueKey: string, stageRunId: number) {
    const issue = this.db.getTrackedIssueByKey(issueKey);
    if (!issue) {
      return undefined;
    }

    const stageRun = this.db.getStageRun(stageRunId);
    if (!stageRun || stageRun.projectId !== issue.projectId || stageRun.linearIssueId !== issue.linearIssueId) {
      return undefined;
    }

    return {
      issue,
      stageRun,
      events: this.db.listThreadEvents(stageRunId).map((event) => ({
        ...event,
        parsedEvent: safeJsonParse<Record<string, unknown>>(event.eventJson),
      })),
    };
  }

  async getActiveStageStatus(issueKey: string) {
    return await this.stageFinalizer.getActiveStageStatus(issueKey);
  }

  private enqueueIssue(projectId: string, issueId: string): void {
    this.issueQueue.enqueue({ projectId, issueId });
  }
}
