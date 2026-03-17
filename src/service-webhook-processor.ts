import type { Logger } from "pino";
import type { CodexAppServerClient } from "./codex-app-server.ts";
import type { EventReceiptStoreProvider, IssueControlStoreProvider, ObligationStoreProvider, RunLeaseStoreProvider } from "./ledger-ports.ts";
import type { LinearInstallationStoreProvider } from "./installation-ports.ts";
import type { OperatorEventFeed } from "./operator-feed.ts";
import type { StageEventLogStoreProvider } from "./stage-event-ports.ts";
import type { IssueWorkflowCoordinatorProvider, IssueWorkflowQueryStoreProvider } from "./workflow-ports.ts";
import type { WebhookEventStoreProvider } from "./webhook-event-ports.ts";
import { resolveProject, trustedActorAllowed } from "./project-resolution.ts";
import { StageAgentActivityPublisher } from "./stage-agent-activity-publisher.ts";
import { StageTurnInputDispatcher } from "./stage-turn-input-dispatcher.ts";
import type { IssueQueueItem } from "./service-stage-runner.ts";
import type { AppConfig, IssueMetadata, LinearClientProvider, LinearWebhookPayload, NormalizedEvent } from "./types.ts";
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
      IssueWorkflowCoordinatorProvider &
      IssueWorkflowQueryStoreProvider &
      LinearInstallationStoreProvider &
      StageEventLogStoreProvider,
    private readonly linearProvider: LinearClientProvider,
    codex: CodexAppServerClient,
    private readonly enqueueIssue: (projectId: IssueQueueItem["projectId"], issueId: IssueQueueItem["issueId"]) => void,
    private readonly logger: Logger,
    private readonly feed?: OperatorEventFeed,
  ) {
    const turnInputDispatcher = new StageTurnInputDispatcher(stores, codex, logger);
    const agentActivity = new StageAgentActivityPublisher(config, linearProvider, logger);
    this.desiredStageRecorder = new WebhookDesiredStageRecorder(stores);
    this.agentSessionHandler = new AgentSessionWebhookHandler(stores, turnInputDispatcher, agentActivity, feed);
    this.commentHandler = new CommentWebhookHandler(stores, turnInputDispatcher, feed);
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

      let normalized = normalizeWebhook({
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
        this.feed?.publish({
          level: "info",
          kind: "webhook",
          status: normalized.triggerEvent,
          summary: `Received ${normalized.triggerEvent} webhook`,
        });
        this.installationHandler.handle(normalized);
        this.stores.webhookEvents.markWebhookProcessed(webhookEventId, "processed");
        this.markEventReceiptProcessed(event.webhookId, "processed");
        return;
      }

      let project = resolveProject(this.config, normalized.issue);
      if (!project) {
        const routed = await this.tryHydrateProjectRoute(normalized);
        if (routed) {
          normalized = routed.normalized;
          project = routed.project;
        }
      }
      if (!project) {
        const unresolvedIssue = normalized.issue;
        if (!unresolvedIssue) {
          this.stores.webhookEvents.markWebhookProcessed(webhookEventId, "failed");
          this.markEventReceiptProcessed(event.webhookId, "failed");
          throw new Error(`Normalized issue context disappeared before routing webhook ${event.webhookId}`);
        }
        this.feed?.publish({
          level: "warn",
          kind: "webhook",
          issueKey: unresolvedIssue.identifier,
          status: "ignored",
          summary: "Ignored webhook with no matching project route",
          detail: normalized.triggerEvent,
        });
        this.logger.info(
          {
            webhookEventId,
            webhookId: event.webhookId,
            issueKey: unresolvedIssue.identifier,
            issueId: unresolvedIssue.id,
            teamId: unresolvedIssue.teamId,
            teamKey: unresolvedIssue.teamKey,
            triggerEvent: normalized.triggerEvent,
          },
          "Ignoring webhook because no project route matched the Linear issue",
        );
        this.stores.webhookEvents.markWebhookProcessed(webhookEventId, "processed");
        this.markEventReceiptProcessed(event.webhookId, "processed");
        return;
      }
      const routedIssue = normalized.issue;
      if (!routedIssue) {
        this.stores.webhookEvents.markWebhookProcessed(webhookEventId, "failed");
        this.markEventReceiptProcessed(event.webhookId, "failed");
        throw new Error(`Normalized issue context disappeared while routing webhook ${event.webhookId}`);
      }

      if (!trustedActorAllowed(project, normalized.actor)) {
        this.feed?.publish({
          level: "warn",
          kind: "webhook",
          issueKey: routedIssue.identifier,
          projectId: project.id,
          status: "ignored",
          summary: "Ignored webhook from an untrusted actor",
          detail: normalized.actor?.name ?? normalized.actor?.email ?? normalized.triggerEvent,
        });
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
        this.assignEventReceiptContext(event.webhookId, project.id, routedIssue.id);
        this.markEventReceiptProcessed(event.webhookId, "processed");
        return;
      }

      this.stores.webhookEvents.assignWebhookProject(webhookEventId, project.id);
      const receipt = this.ensureEventReceipt(event, project.id, routedIssue.id);
      const hydrated = await this.hydrateIssueContext(project.id, normalized);
      const hydratedIssue = hydrated.issue ?? routedIssue;
      const issueState = this.desiredStageRecorder.record(project, hydrated, receipt ? { eventReceiptId: receipt.id } : undefined);
      const observation = describeWebhookObservation(hydrated, issueState.delegatedToPatchRelay);
      if (observation) {
        this.feed?.publish({
          level: "info",
          kind: observation.kind,
          issueKey: hydratedIssue.identifier,
          projectId: project.id,
          ...(observation.status ? { status: observation.status } : {}),
          summary: observation.summary,
          ...(observation.detail ? { detail: observation.detail } : {}),
        });
      }

      await this.agentSessionHandler.handle({
        normalized: hydrated,
        project,
        issue: issueState.issue,
        desiredStage: issueState.desiredStage,
        delegatedToPatchRelay: issueState.delegatedToPatchRelay,
      });
      await this.commentHandler.handle(hydrated, project);

      this.stores.webhookEvents.markWebhookProcessed(webhookEventId, "processed");
      this.markEventReceiptProcessed(event.webhookId, "processed");
      if (issueState.desiredStage) {
        this.feed?.publish({
          level: "info",
          kind: "stage",
          issueKey: hydratedIssue.identifier,
          projectId: project.id,
          stage: issueState.desiredStage,
          status: "queued",
          summary: `Queued ${issueState.desiredStage} workflow`,
          detail: `Triggered by ${hydrated.triggerEvent}${hydratedIssue.stateName ? ` from ${hydratedIssue.stateName}` : ""}.`,
        });
        this.logger.info(
          {
          webhookEventId,
          webhookId: event.webhookId,
          projectId: project.id,
          issueKey: hydratedIssue.identifier,
          issueId: hydratedIssue.id,
          desiredStage: issueState.desiredStage,
          delegatedToPatchRelay: issueState.delegatedToPatchRelay,
          },
          "Recorded desired stage from webhook and enqueued issue execution",
        );
        this.enqueueIssue(project.id, hydratedIssue.id);
        return;
      }

      this.logger.info(
        {
          webhookEventId,
          webhookId: event.webhookId,
          projectId: project.id,
          issueKey: hydratedIssue.identifier,
          issueId: hydratedIssue.id,
          triggerEvent: hydrated.triggerEvent,
          delegatedToPatchRelay: issueState.delegatedToPatchRelay,
        },
        "Processed webhook without enqueuing a new stage run",
      );
    } catch (error) {
      this.stores.webhookEvents.markWebhookProcessed(webhookEventId, "failed");
      this.markEventReceiptProcessed(event.webhookId, "failed");
      const err = error instanceof Error ? error : new Error(String(error));
      this.feed?.publish({
        level: "error",
        kind: "webhook",
        projectId: event.projectId ?? undefined,
        status: "failed",
        summary: "Failed to process webhook",
        detail: sanitizeDiagnosticText(err.message),
      });
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

  private async hydrateIssueContext(projectId: string, normalized: NormalizedEvent): Promise<NormalizedEvent> {
    if (!normalized.issue) {
      return normalized;
    }

    if (normalized.triggerEvent !== "agentSessionCreated" && normalized.triggerEvent !== "agentPrompted") {
      return normalized;
    }

    if (hasCompleteIssueContext(normalized.issue)) {
      return normalized;
    }

    const linear = await this.linearProvider.forProject(projectId);
    if (!linear) {
      return normalized;
    }

    try {
      const liveIssue = await linear.getIssue(normalized.issue.id);
      return {
        ...normalized,
        issue: mergeIssueMetadata(normalized.issue, liveIssue),
      };
    } catch (error) {
      this.logger.warn(
        {
          projectId,
          issueId: normalized.issue.id,
          triggerEvent: normalized.triggerEvent,
          error: sanitizeDiagnosticText(error instanceof Error ? error.message : String(error)),
        },
        "Failed to hydrate sparse Linear issue context for agent session webhook",
      );
      return normalized;
    }
  }

  private async tryHydrateProjectRoute(
    normalized: NormalizedEvent,
  ): Promise<{ project: AppConfig["projects"][number]; normalized: NormalizedEvent } | undefined> {
    if (!normalized.issue) {
      return undefined;
    }

    if (normalized.triggerEvent !== "agentSessionCreated" && normalized.triggerEvent !== "agentPrompted") {
      return undefined;
    }

    for (const candidate of this.config.projects) {
      const linear = await this.linearProvider.forProject(candidate.id);
      if (!linear) {
        continue;
      }

      try {
        const liveIssue = await linear.getIssue(normalized.issue.id);
        const hydrated = {
          ...normalized,
          issue: mergeIssueMetadata(normalized.issue, liveIssue),
        };
        const resolved = resolveProject(this.config, hydrated.issue);
        if (resolved) {
          return {
            project: resolved,
            normalized: hydrated,
          };
        }
      } catch (error) {
        this.logger.debug(
          {
            candidateProjectId: candidate.id,
            issueId: normalized.issue.id,
            triggerEvent: normalized.triggerEvent,
            error: sanitizeDiagnosticText(error instanceof Error ? error.message : String(error)),
          },
          "Failed to hydrate Linear issue context while resolving project route",
        );
      }
    }

    return undefined;
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

function hasCompleteIssueContext(issue: IssueMetadata): boolean {
  return Boolean(issue.stateName && issue.delegateId && issue.teamId && issue.teamKey);
}

function mergeIssueMetadata(
  issue: IssueMetadata,
  liveIssue: {
    identifier?: string;
    title?: string;
    url?: string;
    teamId?: string;
    teamKey?: string;
    stateId?: string;
    stateName?: string;
    delegateId?: string;
    delegateName?: string;
    labelIds?: string[];
    labels?: Array<{ id: string; name: string }>;
  },
): IssueMetadata {
  return {
    ...issue,
    ...(issue.identifier ? {} : liveIssue.identifier ? { identifier: liveIssue.identifier } : {}),
    ...(issue.title ? {} : liveIssue.title ? { title: liveIssue.title } : {}),
    ...(issue.url ? {} : liveIssue.url ? { url: liveIssue.url } : {}),
    ...(issue.teamId ? {} : liveIssue.teamId ? { teamId: liveIssue.teamId } : {}),
    ...(issue.teamKey ? {} : liveIssue.teamKey ? { teamKey: liveIssue.teamKey } : {}),
    ...(issue.stateId ? {} : liveIssue.stateId ? { stateId: liveIssue.stateId } : {}),
    ...(issue.stateName ? {} : liveIssue.stateName ? { stateName: liveIssue.stateName } : {}),
    ...(issue.delegateId ? {} : liveIssue.delegateId ? { delegateId: liveIssue.delegateId } : {}),
    ...(issue.delegateName ? {} : liveIssue.delegateName ? { delegateName: liveIssue.delegateName } : {}),
    labelNames: issue.labelNames.length > 0 ? issue.labelNames : (liveIssue.labels ?? []).map((label) => label.name),
  };
}

function describeWebhookObservation(
  normalized: NormalizedEvent,
  delegatedToPatchRelay: boolean,
): {
  kind: "webhook" | "agent" | "comment";
  status?: string | undefined;
  summary: string;
  detail?: string | undefined;
} | undefined {
  switch (normalized.triggerEvent) {
    case "delegateChanged":
      return delegatedToPatchRelay
        ? {
            kind: "agent",
            status: "delegated",
            summary: "Delegated to PatchRelay",
            detail: normalized.issue?.stateName ? `Current Linear state: ${normalized.issue.stateName}.` : undefined,
          }
        : {
            kind: "agent",
            status: "undelegated",
            summary: "Delegation moved away from PatchRelay",
          };
    case "agentSessionCreated":
      return {
        kind: "agent",
        status: delegatedToPatchRelay ? "session" : "mention",
        summary: delegatedToPatchRelay ? "Opened a delegated agent session" : "Mentioned PatchRelay in Linear",
        detail: normalized.agentSession?.promptBody ?? normalized.agentSession?.promptContext,
      };
    case "agentPrompted":
      return {
        kind: "agent",
        status: "prompted",
        summary: "Received follow-up agent instructions",
        detail: normalized.agentSession?.promptBody ?? normalized.agentSession?.promptContext,
      };
    case "commentCreated":
    case "commentUpdated":
      return {
        kind: "comment",
        status: "received",
        summary: "Received a Linear comment",
        detail: normalized.comment?.userName ?? normalized.comment?.body,
      };
    case "statusChanged":
      return {
        kind: "webhook",
        status: "status_changed",
        summary: normalized.issue?.stateName ? `Linear state changed to ${normalized.issue.stateName}` : "Linear state changed",
      };
    default:
      return undefined;
  }
}
