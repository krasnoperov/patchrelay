import type { Logger } from "pino";
import type { CodexAppServerClient } from "./codex-app-server.ts";
import type { LinearInstallationStoreProvider } from "./installation-ports.ts";
import type { StageEventQueryStoreProvider, StageTurnInputStoreProvider } from "./stage-event-ports.ts";
import type { IssueWorkflowWebhookStoreProvider } from "./workflow-ports.ts";
import type { WebhookEventStoreProvider } from "./webhook-event-ports.ts";
import { resolveProject, trustedActorAllowed } from "./project-resolution.ts";
import { StageAgentActivityPublisher } from "./stage-agent-activity-publisher.ts";
import { StageTurnInputDispatcher } from "./stage-turn-input-dispatcher.ts";
import type { IssueQueueItem } from "./service-stage-runner.ts";
import type { AppConfig, LinearClientProvider, LinearWebhookPayload } from "./types.ts";
import { safeJsonParse } from "./utils.ts";
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
      IssueWorkflowWebhookStoreProvider &
      LinearInstallationStoreProvider &
      StageTurnInputStoreProvider &
      StageEventQueryStoreProvider,
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
      return;
    }

    const payload = safeJsonParse<LinearWebhookPayload>(event.payloadJson);
    if (!payload) {
      this.stores.webhookEvents.markWebhookProcessed(webhookEventId, "failed");
      throw new Error(`Stored webhook payload is invalid JSON: event ${webhookEventId}`);
    }

    const normalized = normalizeWebhook({
      webhookId: event.webhookId,
      payload,
    });
    if (!normalized.issue) {
      this.installationHandler.handle(normalized);
      this.stores.webhookEvents.markWebhookProcessed(webhookEventId, "processed");
      return;
    }

    const project = resolveProject(this.config, normalized.issue);
    if (!project) {
      this.stores.webhookEvents.markWebhookProcessed(webhookEventId, "processed");
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
      return;
    }

    this.stores.webhookEvents.assignWebhookProject(webhookEventId, project.id);
    const issueState = this.desiredStageRecorder.record(project, normalized);

    await this.agentSessionHandler.handle({
      normalized,
      project,
      issue: issueState.issue,
      desiredStage: issueState.desiredStage,
      delegatedToPatchRelay: issueState.delegatedToPatchRelay,
    });
    await this.commentHandler.handle(normalized, project.id);

    this.stores.webhookEvents.markWebhookProcessed(webhookEventId, "processed");
    if (issueState.desiredStage) {
      this.enqueueIssue(project.id, normalized.issue.id);
    }
  }
}
