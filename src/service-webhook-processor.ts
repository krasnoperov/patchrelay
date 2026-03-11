import type { Logger } from "pino";
import type { CodexAppServerClient } from "./codex-app-server.ts";
import { isPatchRelayStatusComment } from "./linear-workflow.ts";
import { resolveProject, triggerEventAllowed, trustedActorAllowed } from "./project-resolution.ts";
import { StageAgentActivityPublisher } from "./stage-agent-activity-publisher.ts";
import { StageTurnInputDispatcher } from "./stage-turn-input-dispatcher.ts";
import type { IssueQueueItem } from "./service-stage-runner.ts";
import type {
  AppConfig,
  AgentSessionMetadata,
  LinearClientProvider,
  LinearWebhookPayload,
  NormalizedEvent,
  ProjectConfig,
  StageRunRecord,
  TrackedIssueRecord,
  WorkflowStage,
} from "./types.ts";
import { safeJsonParse } from "./utils.ts";
import { normalizeWebhook } from "./webhooks.ts";
import { listRunnableStates, resolveWorkflowStage } from "./workflow-policy.ts";
import type { PatchRelayDatabase } from "./db.ts";

function trimPrompt(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export class ServiceWebhookProcessor {
  private readonly turnInputDispatcher: StageTurnInputDispatcher;
  private readonly agentActivity: StageAgentActivityPublisher;

  constructor(
    private readonly config: AppConfig,
    private readonly db: PatchRelayDatabase,
    linearProvider: LinearClientProvider,
    codex: CodexAppServerClient,
    private readonly enqueueIssue: (projectId: IssueQueueItem["projectId"], issueId: IssueQueueItem["issueId"]) => void,
    private readonly logger: Logger,
  ) {
    this.turnInputDispatcher = new StageTurnInputDispatcher(db, codex, logger);
    this.agentActivity = new StageAgentActivityPublisher(linearProvider, logger);
  }

  async processWebhookEvent(webhookEventId: number): Promise<void> {
    const event = this.db.webhookEvents.getWebhookEvent(webhookEventId);
    if (!event) {
      return;
    }

    const payload = safeJsonParse<LinearWebhookPayload>(event.payloadJson);
    if (!payload) {
      this.db.webhookEvents.markWebhookProcessed(webhookEventId, "failed");
      throw new Error(`Stored webhook payload is invalid JSON: event ${webhookEventId}`);
    }

    const normalized = normalizeWebhook({
      webhookId: event.webhookId,
      payload,
    });
    if (!normalized.issue) {
      this.handleInstallationWebhook(normalized);
      this.db.webhookEvents.markWebhookProcessed(webhookEventId, "processed");
      return;
    }

    const project = resolveProject(this.config, normalized.issue);
    if (!project) {
      this.db.webhookEvents.markWebhookProcessed(webhookEventId, "processed");
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
      this.db.webhookEvents.markWebhookProcessed(webhookEventId, "processed");
      return;
    }

    this.db.webhookEvents.assignWebhookProject(webhookEventId, project.id);

    const issue = this.db.issueWorkflows.getTrackedIssue(project.id, normalized.issue.id);
    const activeStageRun = issue?.activeStageRunId ? this.db.issueWorkflows.getStageRun(issue.activeStageRunId) : undefined;
    const desiredStage = this.resolveDesiredStage(project, normalized, issue, activeStageRun);
    const launchInput = this.resolveLaunchInput(normalized.agentSession);

    this.db.issueWorkflows.recordDesiredStage({
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

    if (normalized.agentSession?.id) {
      this.db.issueWorkflows.setIssueActiveAgentSession(project.id, normalized.issue.id, normalized.agentSession.id);
    }
    if (launchInput && !activeStageRun && this.isDelegatedToPatchRelay(project, normalized)) {
      this.db.issueWorkflows.setIssuePendingLaunchInput(project.id, normalized.issue.id, launchInput);
    }

    await this.handleAgentSessionWebhook(
      normalized,
      project,
      issue ?? this.db.issueWorkflows.getTrackedIssue(project.id, normalized.issue.id),
      desiredStage,
    );
    await this.handleCommentWebhook(normalized, project.id);

    this.db.webhookEvents.markWebhookProcessed(webhookEventId, "processed");
    if (desiredStage) {
      this.enqueueIssue(project.id, normalized.issue.id);
    }
  }

  private resolveDesiredStage(
    project: ProjectConfig,
    normalized: NormalizedEvent,
    issue: TrackedIssueRecord | undefined,
    activeStageRun: StageRunRecord | undefined,
  ): WorkflowStage | undefined {
    const normalizedIssue = normalized.issue;
    if (!normalizedIssue) {
      return undefined;
    }

    const stageAllowed = triggerEventAllowed(project, normalized.triggerEvent);
    const delegatedToPatchRelay = this.isDelegatedToPatchRelay(project, normalized);
    let desiredStage: WorkflowStage | undefined;

    if (normalized.triggerEvent === "delegateChanged") {
      desiredStage = delegatedToPatchRelay ? resolveWorkflowStage(project, normalizedIssue.stateName) : undefined;
      if (!desiredStage) {
        return undefined;
      }
      if (!stageAllowed && !project.triggerEvents.includes("statusChanged")) {
        return undefined;
      }
    } else if (normalized.triggerEvent === "agentSessionCreated" || normalized.triggerEvent === "agentPrompted") {
      if (!delegatedToPatchRelay || !stageAllowed) {
        return undefined;
      }
      desiredStage = resolveWorkflowStage(project, normalizedIssue.stateName);
    } else if (stageAllowed) {
      desiredStage = resolveWorkflowStage(project, normalizedIssue.stateName);
    } else {
      return undefined;
    }

    if (activeStageRun && desiredStage === activeStageRun.stage) {
      return undefined;
    }
    if (issue?.desiredStage && desiredStage === issue.desiredStage) {
      return undefined;
    }
    return desiredStage;
  }

  private isDelegatedToPatchRelay(project: ProjectConfig, normalized: NormalizedEvent): boolean {
    const normalizedIssue = normalized.issue;
    if (!normalizedIssue) {
      return false;
    }

    const installation = this.db.linearInstallations.getLinearInstallationForProject(project.id);
    if (!installation?.actorId) {
      return false;
    }
    return normalizedIssue.delegateId === installation.actorId;
  }

  private resolveLaunchInput(agentSession: AgentSessionMetadata | undefined): string | undefined {
    const promptBody = trimPrompt(agentSession?.promptBody);
    if (promptBody) {
      return ["New Linear agent input received.", "", promptBody].join("\n");
    }

    const promptContext = trimPrompt(agentSession?.promptContext);
    if (promptContext) {
      return ["Linear provided this initial agent context.", "", promptContext].join("\n");
    }

    return undefined;
  }

  private async handleAgentSessionWebhook(
    normalized: NormalizedEvent,
    project: ProjectConfig,
    issue: TrackedIssueRecord | undefined,
    desiredStage: WorkflowStage | undefined,
  ): Promise<void> {
    if (!normalized.agentSession?.id) {
      return;
    }

    const promptBody = trimPrompt(normalized.agentSession.promptBody);
    const promptContext = trimPrompt(normalized.agentSession.promptContext);
    const activeStageRun = issue?.activeStageRunId ? this.db.issueWorkflows.getStageRun(issue.activeStageRunId) : undefined;
    const delegatedToPatchRelay = this.isDelegatedToPatchRelay(project, normalized);
    const runnableWorkflow = normalized.issue?.stateName ? resolveWorkflowStage(project, normalized.issue.stateName) : undefined;

    if (normalized.triggerEvent === "agentSessionCreated") {
      if (!delegatedToPatchRelay) {
        if (activeStageRun) {
          await this.agentActivity.publishForSession(project.id, normalized.agentSession.id, {
            type: "thought",
            body: `PatchRelay is already running the ${activeStageRun.stage} workflow for this issue. Delegate it to PatchRelay if you want automation to own the workflow, or keep replying here to steer the active run.`,
          });
          return;
        }

        const body = runnableWorkflow
          ? `PatchRelay received your mention. Delegate the issue to PatchRelay to start the ${runnableWorkflow} workflow from the current \`${normalized.issue?.stateName}\` state.`
          : `PatchRelay received your mention, but the issue is not in a runnable workflow state yet. Move it to one of: ${listRunnableStates(project).join(", ")}, then delegate it to PatchRelay.`;
        await this.agentActivity.publishForSession(project.id, normalized.agentSession.id, {
          type: "elicitation",
          body,
        });
        return;
      }

      if (!desiredStage && !activeStageRun) {
        const runnableStates = listRunnableStates(project).join(", ");
        await this.agentActivity.publishForSession(project.id, normalized.agentSession.id, {
          type: "elicitation",
          body: `PatchRelay is delegated, but the issue is not in a runnable workflow state. Move it to one of: ${runnableStates}.`,
        });
        return;
      }

      if (desiredStage) {
        await this.agentActivity.publishForSession(project.id, normalized.agentSession.id, {
          type: "thought",
          body: `PatchRelay received the delegation and is preparing the ${desiredStage} workflow.`,
        });
        return;
      }

      if (activeStageRun) {
        await this.agentActivity.publishForSession(project.id, normalized.agentSession.id, {
          type: "thought",
          body: `PatchRelay is already running the ${activeStageRun.stage} workflow for this issue.`,
        });
      }
      return;
    }

    if (normalized.triggerEvent !== "agentPrompted") {
      return;
    }

    if (activeStageRun && promptBody) {
      this.db.stageEvents.enqueueTurnInput({
        stageRunId: activeStageRun.id,
        ...(activeStageRun.threadId ? { threadId: activeStageRun.threadId } : {}),
        ...(activeStageRun.turnId ? { turnId: activeStageRun.turnId } : {}),
        source: `linear-agent-prompt:${normalized.agentSession.id}:${normalized.webhookId}`,
        body: ["New Linear agent prompt received while you are working.", "", promptBody].join("\n"),
      });
      await this.turnInputDispatcher.flush(activeStageRun);
      await this.agentActivity.publishForSession(project.id, normalized.agentSession.id, {
        type: "thought",
        body: `PatchRelay routed your follow-up instructions into the active ${activeStageRun.stage} workflow.`,
      });
      return;
    }

    if (!delegatedToPatchRelay && (promptBody || promptContext)) {
      const body = runnableWorkflow
        ? `PatchRelay received your prompt. Delegate the issue to PatchRelay to start the ${runnableWorkflow} workflow from the current \`${normalized.issue?.stateName}\` state.`
        : `PatchRelay received your prompt, but the issue is not in a runnable workflow state yet. Move it to one of: ${listRunnableStates(project).join(", ")}, then delegate it to PatchRelay.`;
      await this.agentActivity.publishForSession(project.id, normalized.agentSession.id, {
        type: "elicitation",
        body,
      });
      return;
    }

    if (!activeStageRun && desiredStage) {
      await this.agentActivity.publishForSession(project.id, normalized.agentSession.id, {
        type: "thought",
        body: `PatchRelay received your prompt and is preparing the ${desiredStage} workflow.`,
      });
      return;
    }

    if (!activeStageRun && !desiredStage && (promptBody || promptContext)) {
      const runnableStates = listRunnableStates(project).join(", ");
      await this.agentActivity.publishForSession(project.id, normalized.agentSession.id, {
        type: "elicitation",
        body: `PatchRelay received your prompt, but the issue is not in a runnable workflow state yet. Move it to one of: ${runnableStates}.`,
      });
    }
  }

  private async handleCommentWebhook(normalized: NormalizedEvent, projectId: string): Promise<void> {
    if ((normalized.triggerEvent !== "commentCreated" && normalized.triggerEvent !== "commentUpdated") || !normalized.comment?.body) {
      return;
    }

    const normalizedIssue = normalized.issue;
    if (!normalizedIssue) {
      return;
    }

    const issue = this.db.issueWorkflows.getTrackedIssue(projectId, normalizedIssue.id);
    if (!issue?.activeStageRunId) {
      return;
    }

    if (isPatchRelayStatusComment(normalized.comment.id, normalized.comment.body, issue.statusCommentId)) {
      return;
    }

    const stageRun = this.db.issueWorkflows.getStageRun(issue.activeStageRunId);
    if (!stageRun) {
      return;
    }

    const body = [
      "New Linear comment received while you are working.",
      normalized.comment.userName ? `Author: ${normalized.comment.userName}` : undefined,
      "",
      normalized.comment.body.trim(),
    ]
      .filter(Boolean)
      .join("\n");

    this.db.stageEvents.enqueueTurnInput({
      stageRunId: stageRun.id,
      ...(stageRun.threadId ? { threadId: stageRun.threadId } : {}),
      ...(stageRun.turnId ? { turnId: stageRun.turnId } : {}),
      source: `linear-comment:${normalized.comment.id}`,
      body,
    });
    await this.turnInputDispatcher.flush(stageRun);
  }

  private handleInstallationWebhook(normalized: NormalizedEvent): void {
    if (!normalized.installation) {
      return;
    }

    if (normalized.triggerEvent === "installationPermissionsChanged") {
      const matchingInstallations = normalized.installation.appUserId
        ? this.db.linearInstallations
            .listLinearInstallations()
            .filter((installation) => installation.actorId === normalized.installation?.appUserId)
        : [];
      const links = this.db.linearInstallations.listProjectInstallations();
      const impactedProjects = matchingInstallations.flatMap((installation) =>
        links
          .filter((link) => link.installationId === installation.id)
          .map((link) => {
            const project = this.config.projects.find((entry) => entry.id === link.projectId);
            const removedMatches =
              normalized.installation?.removedTeamIds.some((teamId) => project?.linearTeamIds.includes(teamId)) ?? false;
            const addedMatches =
              normalized.installation?.addedTeamIds.some((teamId) => project?.linearTeamIds.includes(teamId)) ?? false;
            return {
              projectId: link.projectId,
              removedMatches,
              addedMatches,
            };
          }),
      );

      this.logger.warn(
        {
          appUserId: normalized.installation.appUserId,
          addedTeamIds: normalized.installation.addedTeamIds,
          removedTeamIds: normalized.installation.removedTeamIds,
          canAccessAllPublicTeams: normalized.installation.canAccessAllPublicTeams,
          impactedProjects,
        },
        "Linear app-team permissions changed; reconnect or adjust project routing if PatchRelay lost required team access",
      );
      return;
    }

    if (normalized.triggerEvent === "installationRevoked") {
      this.logger.warn(
        {
          organizationId: normalized.installation.organizationId,
          oauthClientId: normalized.installation.oauthClientId,
        },
        "Linear OAuth app installation was revoked; reconnect affected projects with `patchrelay project apply <id> <repo-path>` or `patchrelay connect --project <id>`",
      );
      return;
    }

    if (normalized.triggerEvent === "appUserNotification") {
      this.logger.info(
        {
          appUserId: normalized.installation.appUserId,
          notificationType: normalized.installation.notificationType,
          organizationId: normalized.installation.organizationId,
        },
        "Received Linear app-user notification webhook",
      );
    }
  }
}
