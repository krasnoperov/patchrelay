import { createHash } from "node:crypto";
import type { Logger } from "pino";
import {
  buildPreparingSessionPlan,
  buildRunningSessionPlan,
} from "./agent-session-plan.ts";
import { buildAgentSessionExternalUrls } from "./agent-session-presentation.ts";
import type { CodexAppServerClient } from "./codex-app-server.ts";
import type { PatchRelayDatabase } from "./db.ts";
import type { OperatorEventFeed } from "./operator-feed.ts";
import { resolveProject, triggerEventAllowed, trustedActorAllowed } from "./project-resolution.ts";
import { isPatchRelayStatusComment } from "./linear-workflow.ts";
import { resolveWorkflowStage, selectWorkflowDefinition, listRunnableStates } from "./workflow-policy.ts";
import { normalizeWebhook } from "./webhooks.ts";
import { InstallationWebhookHandler } from "./webhook-installation-handler.ts";
import type {
  AppConfig,
  AgentSessionMetadata,
  IssueMetadata,
  LinearClientProvider,
  LinearWebhookPayload,
  NormalizedEvent,
  ProjectConfig,
  TrackedIssueRecord,
  WorkflowStage,
} from "./types.ts";
import { safeJsonParse, sanitizeDiagnosticText } from "./utils.ts";

export interface IssueQueueItem {
  projectId: string;
  issueId: string;
}

export class WebhookHandler {
  private readonly installationHandler: InstallationWebhookHandler;

  constructor(
    private readonly config: AppConfig,
    private readonly db: PatchRelayDatabase,
    private readonly linearProvider: LinearClientProvider,
    private readonly codex: CodexAppServerClient,
    private readonly enqueueIssue: (projectId: string, issueId: string) => void,
    private readonly logger: Logger,
    private readonly feed?: OperatorEventFeed,
  ) {
    this.installationHandler = new InstallationWebhookHandler(config, { linearInstallations: db.linearInstallations }, logger);
  }

  async processWebhookEvent(webhookEventId: number): Promise<void> {
    const event = this.db.getFullWebhookEvent(webhookEventId);
    if (!event) {
      this.logger.warn({ webhookEventId }, "Webhook event was not found during processing");
      return;
    }

    try {
      const payload = safeJsonParse<LinearWebhookPayload>(event.payloadJson);
      if (!payload) {
        this.db.markWebhookProcessed(webhookEventId, "failed");
        throw new Error(`Stored webhook payload is invalid JSON: event ${webhookEventId}`);
      }

      let normalized = normalizeWebhook({ webhookId: event.webhookId, payload });
      this.logger.info(
        {
          webhookEventId,
          webhookId: event.webhookId,
          triggerEvent: normalized.triggerEvent,
          issueKey: normalized.issue?.identifier,
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
        this.db.markWebhookProcessed(webhookEventId, "processed");
        return;
      }

      let project = resolveProject(this.config, normalized.issue);
      if (!project) {
        const routed = await this.tryHydrateProjectRoute(normalized);
        if (routed) { normalized = routed.normalized; project = routed.project; }
      }
      if (!project) {
        this.feed?.publish({
          level: "warn",
          kind: "webhook",
          issueKey: normalized.issue?.identifier,
          status: "ignored",
          summary: "Ignored webhook with no matching project route",
        });
        this.db.markWebhookProcessed(webhookEventId, "processed");
        return;
      }

      const routedIssue = normalized.issue;
      if (!routedIssue) {
        this.db.markWebhookProcessed(webhookEventId, "failed");
        throw new Error(`Issue context disappeared while routing webhook ${event.webhookId}`);
      }

      if (!trustedActorAllowed(project, normalized.actor)) {
        this.feed?.publish({
          level: "warn",
          kind: "webhook",
          issueKey: routedIssue.identifier,
          projectId: project.id,
          status: "ignored",
          summary: "Ignored webhook from an untrusted actor",
        });
        this.db.markWebhookProcessed(webhookEventId, "processed");
        return;
      }

      this.db.assignWebhookProject(webhookEventId, project.id);
      const hydrated = await this.hydrateIssueContext(project.id, normalized);
      const issue = hydrated.issue ?? routedIssue;

      // Record desired stage and upsert issue
      const result = this.recordDesiredStage(project, hydrated);
      const trackedIssue = result.issue;

      // Handle agent session events
      await this.handleAgentSession(hydrated, project, trackedIssue, result.desiredStage, result.delegated);

      // Handle comments during active run
      await this.handleComment(hydrated, project, trackedIssue);

      this.db.markWebhookProcessed(webhookEventId, "processed");

      if (result.desiredStage) {
        this.feed?.publish({
          level: "info",
          kind: "stage",
          issueKey: issue.identifier,
          projectId: project.id,
          stage: result.desiredStage,
          ...(trackedIssue?.selectedWorkflowId ? { workflowId: trackedIssue.selectedWorkflowId } : {}),
          status: "queued",
          summary: `Queued ${result.desiredStage} workflow`,
          detail: `Triggered by ${hydrated.triggerEvent}.`,
        });
        this.enqueueIssue(project.id, issue.id);
      }
    } catch (error) {
      this.db.markWebhookProcessed(webhookEventId, "failed");
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
        { webhookEventId, webhookId: event.webhookId, error: sanitizeDiagnosticText(err.message) },
        "Failed to process Linear webhook event",
      );
      throw err;
    }
  }

  private recordDesiredStage(
    project: ProjectConfig,
    normalized: NormalizedEvent,
  ): {
    issue: TrackedIssueRecord | undefined;
    desiredStage: WorkflowStage | undefined;
    delegated: boolean;
  } {
    const normalizedIssue = normalized.issue;
    if (!normalizedIssue) {
      return { issue: undefined, desiredStage: undefined, delegated: false };
    }

    const existing = this.db.getTrackedIssue(project.id, normalizedIssue.id);
    const existingIssue = this.db.getIssue(project.id, normalizedIssue.id);
    const activeRun = existingIssue?.activeRunId ? this.db.getRun(existingIssue.activeRunId) : undefined;
    const delegated = this.isDelegatedToPatchRelay(project, normalized);
    const stageAllowed = triggerEventAllowed(project, normalized.triggerEvent);

    // Resolve workflow selection
    const selectedWorkflowId = activeRun
      ? existing?.selectedWorkflowId
      : delegated && stageAllowed && normalizedIssue
        ? (selectWorkflowDefinition(project, normalizedIssue)?.id ?? null)
        : existing?.selectedWorkflowId;

    // Resolve desired stage
    let desiredStage: WorkflowStage | undefined;
    if (delegated && stageAllowed) {
      const resolved = resolveWorkflowStage(project, normalizedIssue.stateName, {
        ...(selectedWorkflowId ? { workflowDefinitionId: selectedWorkflowId } : {}),
      });
      if (resolved && resolved !== activeRun?.stage && resolved !== existing?.desiredStage) {
        desiredStage = resolved;
      }
    }

    // Continuation barriers removed - if a human wants to stop automation,
    // they can undelegate or move the issue to Human Needed.
    const continuationBarrierAt = undefined;

    // Resolve agent session
    const agentSessionId = normalized.agentSession?.id ??
      (!activeRun && (desiredStage || (normalized.triggerEvent === "delegateChanged" && !delegated)) ? null : undefined);

    // Upsert the issue
    const issue = this.db.upsertIssue({
      projectId: project.id,
      linearIssueId: normalizedIssue.id,
      ...(normalizedIssue.identifier ? { issueKey: normalizedIssue.identifier } : {}),
      ...(normalizedIssue.title ? { title: normalizedIssue.title } : {}),
      ...(normalizedIssue.url ? { url: normalizedIssue.url } : {}),
      ...(selectedWorkflowId !== undefined ? { selectedWorkflowId } : {}),
      ...(normalizedIssue.stateName ? { currentLinearState: normalizedIssue.stateName } : {}),
      ...(desiredStage !== undefined ? { desiredStage } : {}),
      ...(continuationBarrierAt !== undefined ? { continuationBarrierAt } : {}),
      ...(agentSessionId !== undefined ? { agentSessionId } : {}),
      ...(desiredStage ? { lifecycleStatus: "queued" as const } : {}),
    });

    return {
      issue: this.db.issueToTrackedIssue(issue),
      desiredStage,
      delegated,
    };
  }

  private isDelegatedToPatchRelay(project: ProjectConfig, normalized: NormalizedEvent): boolean {
    if (!normalized.issue) return false;
    const installation = this.db.linearInstallations.getLinearInstallationForProject(project.id);
    if (!installation?.actorId) return false;
    return normalized.issue.delegateId === installation.actorId;
  }

  private resolveContinuationBarrier(normalized: NormalizedEvent, hasActiveRun: boolean): string | undefined {
    if (!hasActiveRun) return undefined;
    if (
      (normalized.triggerEvent === "commentCreated" || normalized.triggerEvent === "commentUpdated") &&
      normalized.comment?.body?.trim()
    ) {
      return new Date().toISOString();
    }
    if (normalized.triggerEvent === "agentPrompted" && this.resolveLaunchInput(normalized.agentSession)) {
      return new Date().toISOString();
    }
    return undefined;
  }

  private resolveLaunchInput(agentSession: AgentSessionMetadata | undefined): string | undefined {
    const body = agentSession?.promptBody?.trim();
    if (body) return `New Linear agent input received.\n\n${body}`;
    const context = agentSession?.promptContext?.trim();
    if (context) return `Linear provided this initial agent context.\n\n${context}`;
    return undefined;
  }

  // ─── Agent session handling (inlined) ─────────────────────────────

  private async handleAgentSession(
    normalized: NormalizedEvent,
    project: ProjectConfig,
    trackedIssue: TrackedIssueRecord | undefined,
    desiredStage: WorkflowStage | undefined,
    delegated: boolean,
  ): Promise<void> {
    if (!normalized.agentSession?.id || !normalized.issue) return;

    const linear = await this.linearProvider.forProject(project.id);
    if (!linear) return;

    const existingIssue = this.db.getIssue(project.id, normalized.issue.id);
    const activeRun = existingIssue?.activeRunId ? this.db.getRun(existingIssue.activeRunId) : undefined;

    if (normalized.triggerEvent === "agentSessionCreated") {
      if (!delegated) {
        const runnableWorkflow = normalized.issue.stateName
          ? resolveWorkflowStage(project, normalized.issue.stateName, {
              ...(trackedIssue?.selectedWorkflowId ? { workflowDefinitionId: trackedIssue.selectedWorkflowId } : {}),
            })
          : undefined;
        const body = runnableWorkflow
          ? `PatchRelay received your mention. Delegate the issue to PatchRelay to start the ${runnableWorkflow} workflow.`
          : `PatchRelay received your mention, but the issue is not in a runnable workflow state. Move it to one of: ${listRunnableStates(project).join(", ")}.`;
        await this.publishAgentActivity(linear, normalized.agentSession.id, { type: "elicitation", body });
        return;
      }
      if (desiredStage) {
        await this.updateAgentSessionPlan(linear, project, normalized.agentSession.id, trackedIssue, buildPreparingSessionPlan(desiredStage));
        await this.publishAgentActivity(linear, normalized.agentSession.id, {
          type: "response",
          body: `PatchRelay started working on the ${desiredStage} workflow.`,
        });
        return;
      }
      if (activeRun) {
        await this.updateAgentSessionPlan(linear, project, normalized.agentSession.id, trackedIssue, buildRunningSessionPlan(activeRun.stage));
        await this.publishAgentActivity(linear, normalized.agentSession.id, {
          type: "response",
          body: `PatchRelay is already running the ${activeRun.stage} workflow for this issue.`,
        });
        return;
      }
      const runnableStates = listRunnableStates(project).join(", ");
      await this.publishAgentActivity(linear, normalized.agentSession.id, {
        type: "elicitation",
        body: `PatchRelay is delegated, but the issue is not in a runnable workflow state. Move it to one of: ${runnableStates}.`,
      });
      return;
    }

    if (normalized.triggerEvent !== "agentPrompted") return;
    if (!triggerEventAllowed(project, normalized.triggerEvent)) return;

    const promptBody = normalized.agentSession.promptBody?.trim();
    if (activeRun && promptBody && activeRun.threadId && activeRun.turnId) {
      // Deliver prompt directly to active Codex turn
      const input = `New Linear agent prompt received while you are working.\n\n${promptBody}`;
      try {
        await this.codex.steerTurn({ threadId: activeRun.threadId, turnId: activeRun.turnId, input });
        this.feed?.publish({
          level: "info",
          kind: "agent",
          projectId: project.id,
          issueKey: trackedIssue?.issueKey,
          stage: activeRun.stage,
          status: "delivered",
          summary: `Delivered follow-up prompt to active ${activeRun.stage} workflow`,
        });
      } catch {
        this.feed?.publish({
          level: "warn",
          kind: "agent",
          projectId: project.id,
          issueKey: trackedIssue?.issueKey,
          stage: activeRun.stage,
          status: "delivery_failed",
          summary: `Could not deliver follow-up prompt to active ${activeRun.stage} workflow`,
        });
      }
      await this.publishAgentActivity(linear, normalized.agentSession.id, {
        type: "thought",
        body: `PatchRelay routed your follow-up instructions into the active ${activeRun.stage} workflow.`,
      });
      return;
    }

    if (desiredStage) {
      await this.updateAgentSessionPlan(linear, project, normalized.agentSession.id, trackedIssue, buildPreparingSessionPlan(desiredStage));
      await this.publishAgentActivity(linear, normalized.agentSession.id, {
        type: "response",
        body: `PatchRelay is preparing the ${desiredStage} workflow from your latest prompt.`,
      });
    }
  }

  // ─── Comment handling (inlined) ───────────────────────────────────

  private async handleComment(
    normalized: NormalizedEvent,
    project: ProjectConfig,
    trackedIssue: TrackedIssueRecord | undefined,
  ): Promise<void> {
    if (
      (normalized.triggerEvent !== "commentCreated" && normalized.triggerEvent !== "commentUpdated") ||
      !normalized.comment?.body ||
      !normalized.issue
    ) {
      return;
    }
    if (!triggerEventAllowed(project, normalized.triggerEvent)) return;

    const issue = this.db.getIssue(project.id, normalized.issue.id);
    if (!issue?.activeRunId) return;
    const run = this.db.getRun(issue.activeRunId);
    if (!run?.threadId || !run.turnId) return;

    if (isPatchRelayStatusComment(normalized.comment.id, normalized.comment.body, issue.statusCommentId)) {
      return;
    }

    const body = [
      "New Linear comment received while you are working.",
      normalized.comment.userName ? `Author: ${normalized.comment.userName}` : undefined,
      "",
      normalized.comment.body.trim(),
    ].filter(Boolean).join("\n");

    try {
      await this.codex.steerTurn({ threadId: run.threadId, turnId: run.turnId, input: body });
      this.feed?.publish({
        level: "info",
        kind: "comment",
        projectId: project.id,
        issueKey: trackedIssue?.issueKey,
        stage: run.stage,
        status: "delivered",
        summary: `Delivered follow-up comment to active ${run.stage} workflow`,
      });
    } catch {
      this.feed?.publish({
        level: "warn",
        kind: "comment",
        projectId: project.id,
        issueKey: trackedIssue?.issueKey,
        stage: run.stage,
        status: "delivery_failed",
        summary: `Could not deliver follow-up comment to active ${run.stage} workflow`,
      });
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────────

  private async publishAgentActivity(
    linear: NonNullable<Awaited<ReturnType<LinearClientProvider["forProject"]>>>,
    agentSessionId: string,
    content: { type: "thought" | "elicitation" | "response" | "error"; body: string },
  ): Promise<void> {
    try {
      await linear.createAgentActivity({
        agentSessionId,
        content,
        ephemeral: content.type === "thought",
      });
    } catch (error) {
      this.logger.warn(
        { agentSessionId, error: error instanceof Error ? error.message : String(error) },
        "Failed to publish Linear agent activity",
      );
    }
  }

  private async updateAgentSessionPlan(
    linear: NonNullable<Awaited<ReturnType<LinearClientProvider["forProject"]>>>,
    project: ProjectConfig,
    agentSessionId: string,
    issue: TrackedIssueRecord | undefined,
    plan: ReturnType<typeof buildPreparingSessionPlan>,
  ): Promise<void> {
    if (!linear.updateAgentSession) return;
    try {
      const externalUrls = buildAgentSessionExternalUrls(this.config, issue?.issueKey);
      await linear.updateAgentSession({
        agentSessionId,
        ...(externalUrls ? { externalUrls } : {}),
        plan,
      });
    } catch (error) {
      this.logger.warn(
        { agentSessionId, error: error instanceof Error ? error.message : String(error) },
        "Failed to update Linear agent session",
      );
    }
  }

  private async hydrateIssueContext(projectId: string, normalized: NormalizedEvent): Promise<NormalizedEvent> {
    if (!normalized.issue) return normalized;
    if (normalized.triggerEvent !== "agentSessionCreated" && normalized.triggerEvent !== "agentPrompted") return normalized;
    if (hasCompleteIssueContext(normalized.issue)) return normalized;

    const linear = await this.linearProvider.forProject(projectId);
    if (!linear) return normalized;

    try {
      const liveIssue = await linear.getIssue(normalized.issue.id);
      return { ...normalized, issue: mergeIssueMetadata(normalized.issue, liveIssue) };
    } catch {
      return normalized;
    }
  }

  private async tryHydrateProjectRoute(
    normalized: NormalizedEvent,
  ): Promise<{ project: ProjectConfig; normalized: NormalizedEvent } | undefined> {
    if (!normalized.issue) return undefined;
    if (normalized.triggerEvent !== "agentSessionCreated" && normalized.triggerEvent !== "agentPrompted") return undefined;

    for (const candidate of this.config.projects) {
      const linear = await this.linearProvider.forProject(candidate.id);
      if (!linear) continue;
      try {
        const liveIssue = await linear.getIssue(normalized.issue.id);
        const hydrated = { ...normalized, issue: mergeIssueMetadata(normalized.issue, liveIssue) };
        const resolved = resolveProject(this.config, hydrated.issue);
        if (resolved) return { project: resolved, normalized: hydrated };
      } catch { /* continue to next candidate */ }
    }
    return undefined;
  }
}

function hasCompleteIssueContext(issue: IssueMetadata): boolean {
  return Boolean(issue.stateName && issue.delegateId && issue.teamId && issue.teamKey);
}

function mergeIssueMetadata(
  issue: IssueMetadata,
  liveIssue: {
    identifier?: string; title?: string; url?: string;
    teamId?: string; teamKey?: string; stateId?: string; stateName?: string;
    delegateId?: string; delegateName?: string;
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
    labelNames: issue.labelNames.length > 0 ? issue.labelNames : (liveIssue.labels ?? []).map((l) => l.name),
  };
}
