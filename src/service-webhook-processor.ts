import type { Logger } from "pino";
import type { CodexAppServerClient } from "./codex-app-server.ts";
import type { EventReceiptStoreProvider, IssueControlStoreProvider, ObligationStoreProvider, RunLeaseStoreProvider } from "./ledger-ports.ts";
import type { LinearInstallationStoreProvider } from "./installation-ports.ts";
import type { StageEventLogStoreProvider } from "./stage-event-ports.ts";
import type { IssueWorkflowWebhookStoreProvider } from "./workflow-ports.ts";
import type { WebhookEventStoreProvider } from "./webhook-event-ports.ts";
import { resolveProject, trustedActorAllowed } from "./project-resolution.ts";
import { StageAgentActivityPublisher } from "./stage-agent-activity-publisher.ts";
import { StageTurnInputDispatcher } from "./stage-turn-input-dispatcher.ts";
import type { IssueQueueItem } from "./service-stage-runner.ts";
import type { AppConfig, LinearClientProvider, LinearWebhookPayload } from "./types.ts";
import { safeJsonParse, sanitizeDiagnosticText } from "./utils.ts";
import { AgentSessionWebhookHandler } from "./webhook-agent-session-handler.ts";
import { CommentWebhookHandler } from "./webhook-comment-handler.ts";
import { WebhookDesiredStageRecorder } from "./webhook-desired-stage-recorder.ts";
import { InstallationWebhookHandler } from "./webhook-installation-handler.ts";
import { normalizeWebhook } from "./webhooks.ts";

export class ServiceWebhookProcessor {
  private readonly desiredStageRecorder: WebhookDesiredStageRecorder;
  private readonly agentSessionHandler: AgentSessionWebhookHandler;
  private readonly commentHandler: CommentWebhookHandler;
  private readonly installationHandler: InstallationWebhookHandler;

  constructor(
    private readonly config: AppConfig,
    private readonly stores: WebhookEventStoreProvider &
      EventReceiptStoreProvider &
      IssueControlStoreProvider &
      ObligationStoreProvider &
      RunLeaseStoreProvider &
      IssueWorkflowWebhookStoreProvider &
      LinearInstallationStoreProvider &
      StageEventLogStoreProvider,
    linearProvider: LinearClientProvider,
    codex: CodexAppServerClient,
    private readonly enqueueIssue: (projectId: IssueQueueItem["projectId"], issueId: IssueQueueItem["issueId"]) => void,
    private readonly logger: Logger,
  ) {
    const turnInputDispatcher = new StageTurnInputDispatcher(stores, codex, logger);
    const agentActivity = new StageAgentActivityPublisher(linearProvider, logger);
    this.desiredStageRecorder = new WebhookDesiredStageRecorder(stores);
    this.agentSessionHandler = new AgentSessionWebhookHandler(stores, turnInputDispatcher, agentActivity);
    this.commentHandler = new CommentWebhookHandler(stores, turnInputDispatcher);
    this.installationHandler = new InstallationWebhookHandler(config, stores, logger);
  }

  async processWebhookEvent(webhookEventId: number): Promise<void> {
    const event = this.stores.webhookEvents.getWebhookEvent(webhookEventId);
    if (!event) {
      this.logger.warn({ webhookEventId }, "Webhook event was not found during processing");
      return;
    }

    try {
      const payload = safeJsonParse<LinearWebhookPayload>(event.payloadJson);
      if (!payload) {
        this.stores.webhookEvents.markWebhookProcessed(webhookEventId, "failed");
        this.markEventReceiptProcessed(event.webhookId, "failed");
        throw new Error(`Stored webhook payload is invalid JSON: event ${webhookEventId}`);
      }

      const normalized = normalizeWebhook({
        webhookId: event.webhookId,
        payload,
      });
      this.logger.info(
        {
          webhookEventId,
          webhookId: event.webhookId,
          eventType: normalized.eventType,
          triggerEvent: normalized.triggerEvent,
          issueKey: normalized.issue?.identifier,
          issueId: normalized.issue?.id,
        },
        "Processing stored webhook event",
      );
      if (!normalized.issue) {
        this.installationHandler.handle(normalized);
        this.stores.webhookEvents.markWebhookProcessed(webhookEventId, "processed");
        this.markEventReceiptProcessed(event.webhookId, "processed");
        return;
      }

      const project = resolveProject(this.config, normalized.issue);
      if (!project) {
        this.logger.info(
          {
            webhookEventId,
            webhookId: event.webhookId,
            issueKey: normalized.issue.identifier,
            issueId: normalized.issue.id,
            teamId: normalized.issue.teamId,
            teamKey: normalized.issue.teamKey,
            triggerEvent: normalized.triggerEvent,
          },
          "Ignoring webhook because no project route matched the Linear issue",
        );
        this.stores.webhookEvents.markWebhookProcessed(webhookEventId, "processed");
        this.markEventReceiptProcessed(event.webhookId, "processed");
        return;
      }

      if (!trustedActorAllowed(project, normalized.actor)) {
        this.logger.info(
          {
            webhookId: normalized.webhookId,
            projectId: project.id,
            triggerEvent: normalized.triggerEvent,
            actorId: normalized.actor?.id,
            actorName: normalized.actor?.name,
            actorEmail: normalized.actor?.email,
          },
          "Ignoring webhook from untrusted Linear actor",
        );
        this.stores.webhookEvents.markWebhookProcessed(webhookEventId, "processed");
        this.assignEventReceiptContext(event.webhookId, project.id, normalized.issue.id);
        this.markEventReceiptProcessed(event.webhookId, "processed");
        return;
      }

      this.stores.webhookEvents.assignWebhookProject(webhookEventId, project.id);
      const receipt = this.ensureEventReceipt(event, project.id, normalized.issue.id);
      const issueState = this.desiredStageRecorder.record(project, normalized, receipt ? { eventReceiptId: receipt.id } : undefined);

      await this.agentSessionHandler.handle({
        normalized,
        project,
        issue: issueState.issue,
        desiredStage: issueState.desiredStage,
        delegatedToPatchRelay: issueState.delegatedToPatchRelay,
      });
      await this.commentHandler.handle(normalized, project);

      this.stores.webhookEvents.markWebhookProcessed(webhookEventId, "processed");
      this.markEventReceiptProcessed(event.webhookId, "processed");
      if (issueState.desiredStage) {
        this.logger.info(
          {
            webhookEventId,
            webhookId: event.webhookId,
            projectId: project.id,
            issueKey: normalized.issue.identifier,
            issueId: normalized.issue.id,
            desiredStage: issueState.desiredStage,
            delegatedToPatchRelay: issueState.delegatedToPatchRelay,
          },
          "Recorded desired stage from webhook and enqueued issue execution",
        );
        this.enqueueIssue(project.id, normalized.issue.id);
        return;
      }

      this.logger.info(
        {
          webhookEventId,
          webhookId: event.webhookId,
          projectId: project.id,
          issueKey: normalized.issue.identifier,
          issueId: normalized.issue.id,
          triggerEvent: normalized.triggerEvent,
          delegatedToPatchRelay: issueState.delegatedToPatchRelay,
        },
        "Processed webhook without enqueuing a new stage run",
      );
    } catch (error) {
      this.stores.webhookEvents.markWebhookProcessed(webhookEventId, "failed");
      this.markEventReceiptProcessed(event.webhookId, "failed");
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.error(
        {
          webhookEventId,
          webhookId: event.webhookId,
          issueId: event.issueId,
          projectId: event.projectId,
          error: sanitizeDiagnosticText(err.message),
          stack: err.stack,
        },
        "Failed to process Linear webhook event",
      );
      throw err;
    }
  }

  private assignEventReceiptContext(webhookId: string, projectId?: string, linearIssueId?: string): void {
    const receipt = this.lookupEventReceipt(webhookId);
    if (!receipt) {
      return;
    }
    this.stores.eventReceipts.assignEventReceiptContext(receipt.id, {
      ...(projectId ? { projectId } : {}),
      ...(linearIssueId ? { linearIssueId } : {}),
    });
  }

  private markEventReceiptProcessed(webhookId: string, status: "processed" | "failed"): void {
    const receipt = this.lookupEventReceipt(webhookId);
    if (!receipt) {
      return;
    }
    this.stores.eventReceipts.markEventReceiptProcessed(receipt.id, status);
  }

  private lookupEventReceipt(webhookId: string) {
    return this.stores.eventReceipts.getEventReceiptBySourceExternalId("linear-webhook", webhookId);
  }

  private ensureEventReceipt(
    event: { webhookId: string; eventType: string; receivedAt: string; headersJson: string; payloadJson: string },
    projectId?: string,
    linearIssueId?: string,
  ) {
    const existing = this.lookupEventReceipt(event.webhookId);
    if (existing) {
      this.assignEventReceiptContext(event.webhookId, projectId, linearIssueId);
      return existing;
    }

    const inserted = this.stores.eventReceipts.insertEventReceipt({
      source: "linear-webhook",
      externalId: event.webhookId,
      eventType: event.eventType,
      receivedAt: event.receivedAt,
      acceptanceStatus: "accepted",
      ...(projectId ? { projectId } : {}),
      ...(linearIssueId ? { linearIssueId } : {}),
      headersJson: event.headersJson,
      payloadJson: event.payloadJson,
    });
    return this.stores.eventReceipts.getEventReceipt(inserted.id);
  }
}
