import type { Logger } from "pino";
import {
  buildAgentSessionPlanForIssue,
} from "./agent-session-plan.ts";
import { buildAgentSessionExternalUrls } from "./agent-session-presentation.ts";
import type { CodexAppServerClient } from "./codex-app-server.ts";
import type { PatchRelayDatabase } from "./db.ts";
import type { RunType } from "./factory-state.ts";
import {
  buildAlreadyRunningThought,
  buildDelegationThought,
  buildPromptDeliveredThought,
  buildStopConfirmationActivity,
} from "./linear-session-reporting.ts";
import type { OperatorEventFeed } from "./operator-feed.ts";
import { resolveProject, triggerEventAllowed, trustedActorAllowed } from "./project-resolution.ts";
import { normalizeWebhook } from "./webhooks.ts";
import { InstallationWebhookHandler } from "./webhook-installation-handler.ts";
import type {
  AppConfig,
  IssueMetadata,
  LinearClientProvider,
  LinearWebhookPayload,
  NormalizedEvent,
  ProjectConfig,
  TrackedIssueRecord,
  LinearAgentActivityContent,
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
    const event = this.db.getWebhookPayload(webhookEventId);
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
        projectId: undefined,
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
    desiredStage: RunType | undefined;
    delegated: boolean;
  } {
    const normalizedIssue = normalized.issue;
    if (!normalizedIssue) {
      return { issue: undefined, desiredStage: undefined, delegated: false };
    }

    const existingIssue = this.db.getIssue(project.id, normalizedIssue.id);
    const activeRun = existingIssue?.activeRunId ? this.db.getRun(existingIssue.activeRunId) : undefined;
    const delegated = this.isDelegatedToPatchRelay(project, normalized);
    const triggerAllowed = triggerEventAllowed(project, normalized.triggerEvent);
    const pendingRunContextJson = mergePendingImplementationContext(existingIssue?.pendingRunContextJson, normalized);

    // In the factory model, only a true delegation queues implementation work.
    let pendingRunType: RunType | undefined;
    const isDelegationSignal = delegated;
    if (isDelegationSignal && triggerAllowed && !activeRun && !existingIssue?.pendingRunType) {
      pendingRunType = "implementation";
    }

    // Resolve agent session
    const agentSessionId = normalized.agentSession?.id ??
      (!activeRun && (pendingRunType || (normalized.triggerEvent === "delegateChanged" && !delegated)) ? null : undefined);

    // Upsert the issue
    const issue = this.db.upsertIssue({
      projectId: project.id,
      linearIssueId: normalizedIssue.id,
      ...(normalizedIssue.identifier ? { issueKey: normalizedIssue.identifier } : {}),
      ...(normalizedIssue.title ? { title: normalizedIssue.title } : {}),
      ...(normalizedIssue.description ? { description: normalizedIssue.description } : {}),
      ...(normalizedIssue.url ? { url: normalizedIssue.url } : {}),
      ...(normalizedIssue.priority != null ? { priority: normalizedIssue.priority } : {}),
      ...(normalizedIssue.estimate != null ? { estimate: normalizedIssue.estimate } : {}),
      ...(normalizedIssue.stateName ? { currentLinearState: normalizedIssue.stateName } : {}),
      ...(pendingRunType ? { pendingRunType, factoryState: "delegated" as const } : {}),
      ...((pendingRunType || existingIssue?.pendingRunType === "implementation") && pendingRunContextJson
        ? { pendingRunContextJson }
        : {}),
      ...(agentSessionId !== undefined ? { agentSessionId } : {}),
    });

    return {
      issue: this.db.issueToTrackedIssue(issue),
      desiredStage: pendingRunType,
      delegated,
    };
  }

  private isDelegatedToPatchRelay(project: ProjectConfig, normalized: NormalizedEvent): boolean {
    if (!normalized.issue) return false;
    const installation = this.db.linearInstallations.getLinearInstallationForProject(project.id);
    if (!installation?.actorId) return false;
    return normalized.issue.delegateId === installation.actorId;
  }

  // ─── Agent session handling (inlined) ─────────────────────────────

  private async handleAgentSession(
    normalized: NormalizedEvent,
    project: ProjectConfig,
    trackedIssue: TrackedIssueRecord | undefined,
    desiredStage: RunType | undefined,
    delegated: boolean,
  ): Promise<void> {
    if (!normalized.agentSession?.id || !normalized.issue) return;

    const linear = await this.linearProvider.forProject(project.id);
    if (!linear) return;

    const existingIssue = this.db.getIssue(project.id, normalized.issue.id);
    const activeRun = existingIssue?.activeRunId ? this.db.getRun(existingIssue.activeRunId) : undefined;

    if (normalized.triggerEvent === "agentSessionCreated") {
      if (!delegated) {
        const body = "PatchRelay received your mention. Delegate the issue to PatchRelay to start work.";
        await this.publishAgentActivity(linear, normalized.agentSession.id, { type: "elicitation", body });
        return;
      }
      if (desiredStage) {
        const latestIssue = this.db.getIssue(project.id, normalized.issue.id);
        await this.syncAgentSession(linear, normalized.agentSession.id, latestIssue ?? trackedIssue, { pendingRunType: desiredStage });
        await this.publishAgentActivity(linear, normalized.agentSession.id, buildDelegationThought(desiredStage));
        return;
      }
      if (activeRun) {
        const latestIssue = this.db.getIssue(project.id, normalized.issue.id);
        await this.syncAgentSession(linear, normalized.agentSession.id, latestIssue ?? trackedIssue, { activeRunType: activeRun.runType });
        await this.publishAgentActivity(linear, normalized.agentSession.id, buildAlreadyRunningThought(activeRun.runType));
        return;
      }
      await this.publishAgentActivity(linear, normalized.agentSession.id, {
        type: "elicitation",
        body: "PatchRelay is delegated, but no work is queued. Delegate the issue or move it to Start to trigger implementation.",
      });
      return;
    }

    // Stop signal — halt active work and confirm disengagement
    if (normalized.triggerEvent === "agentSignal" && normalized.agentSession.signal === "stop") {
      await this.handleStopSignal(normalized, project, trackedIssue, existingIssue, activeRun, linear);
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
          stage: activeRun.runType,
          status: "delivered",
          summary: `Delivered follow-up prompt to active ${activeRun.runType} workflow`,
        });
      } catch (error) {
        this.logger.warn({ issueKey: trackedIssue?.issueKey, error: error instanceof Error ? error.message : String(error) }, "Failed to deliver follow-up prompt");
        this.feed?.publish({
          level: "warn",
          kind: "agent",
          projectId: project.id,
          issueKey: trackedIssue?.issueKey,
          stage: activeRun.runType,
          status: "delivery_failed",
          summary: `Could not deliver follow-up prompt to active ${activeRun.runType} workflow`,
        });
      }
      await this.publishAgentActivity(linear, normalized.agentSession.id, buildPromptDeliveredThought(activeRun.runType), { ephemeral: true });
      return;
    }

    if (desiredStage) {
      const latestIssue = this.db.getIssue(project.id, normalized.issue.id);
      await this.syncAgentSession(linear, normalized.agentSession.id, latestIssue ?? trackedIssue, { pendingRunType: desiredStage });
      await this.publishAgentActivity(linear, normalized.agentSession.id, buildDelegationThought(desiredStage, "prompt"), { ephemeral: true });
    }
  }

  // ─── Stop signal handling ────────────────────────────────────────

  private async handleStopSignal(
    normalized: NormalizedEvent,
    project: ProjectConfig,
    trackedIssue: TrackedIssueRecord | undefined,
    existingIssue: ReturnType<PatchRelayDatabase["getIssue"]>,
    activeRun: ReturnType<PatchRelayDatabase["getRun"]>,
    linear: NonNullable<Awaited<ReturnType<LinearClientProvider["forProject"]>>>,
  ): Promise<void> {
    const issueId = normalized.issue!.id;
    const sessionId = normalized.agentSession!.id;

    // Best-effort halt: steer the active Codex turn with a stop instruction
    if (activeRun?.threadId && activeRun.turnId) {
      try {
        await this.codex.steerTurn({
          threadId: activeRun.threadId,
          turnId: activeRun.turnId,
          input: "STOP: The user has requested you stop working immediately. Do not make further changes. Wrap up and exit.",
        });
      } catch (error) {
        this.logger.warn({ issueKey: trackedIssue?.issueKey, error: error instanceof Error ? error.message : String(error) }, "Failed to steer Codex turn for stop signal");
      }

      this.db.finishRun(activeRun.id, { status: "released", threadId: activeRun.threadId, turnId: activeRun.turnId });
    }

    this.db.upsertIssue({
      projectId: project.id,
      linearIssueId: issueId,
      activeRunId: null,
      factoryState: "awaiting_input",
      agentSessionId: sessionId,
    });

    this.feed?.publish({
      level: "info",
      kind: "agent",
      projectId: project.id,
      issueKey: trackedIssue?.issueKey,
      status: "stopped",
      summary: "Stop signal received — work halted",
    });

    const updatedIssue = this.db.getIssue(project.id, issueId);
    await this.publishAgentActivity(linear, sessionId, buildStopConfirmationActivity());
    await this.syncAgentSession(linear, sessionId, updatedIssue ?? trackedIssue);
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

    // Ignore PatchRelay's own comments to prevent self-triggering feedback loops.
    // When a run completes, PatchRelay posts an activity to Linear, which fires a
    // commentCreated webhook back — without this guard that re-enqueues a new run.
    const installation = this.db.linearInstallations.getLinearInstallationForProject(project.id);
    if (installation?.actorId && normalized.actor?.id === installation.actorId) {
      return;
    }

    const issue = this.db.getIssue(project.id, normalized.issue.id);
    if (!issue) return;

    // No active run — enqueue a run with the comment as context if appropriate
    if (!issue.activeRunId) {
      const ENQUEUEABLE_STATES = new Set(["pr_open", "changes_requested", "implementing", "delegated"]);
      if (ENQUEUEABLE_STATES.has(issue.factoryState)) {
        const runType = issue.prReviewState === "changes_requested" ? "review_fix" : "implementation";
        this.db.upsertIssue({
          projectId: project.id,
          linearIssueId: normalized.issue.id,
          pendingRunType: runType as never,
          pendingRunContextJson: JSON.stringify({ userComment: normalized.comment.body.trim() }),
        });
        this.enqueueIssue(project.id, normalized.issue.id);
        this.feed?.publish({
          level: "info",
          kind: "comment",
          projectId: project.id,
          issueKey: trackedIssue?.issueKey,
          status: "enqueued",
          summary: `Comment enqueued ${runType} run`,
          detail: normalized.comment.body.slice(0, 200),
        });
      }
      return;
    }

    const run = this.db.getRun(issue.activeRunId);
    if (!run?.threadId || !run.turnId) return;

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
        stage: run.runType,
        status: "delivered",
        summary: `Delivered follow-up comment to active ${run.runType} workflow`,
      });
    } catch (error) {
      this.logger.warn({ issueKey: trackedIssue?.issueKey, error: error instanceof Error ? error.message : String(error) }, "Failed to deliver follow-up comment");
      this.feed?.publish({
        level: "warn",
        kind: "comment",
        projectId: project.id,
        issueKey: trackedIssue?.issueKey,
        stage: run.runType,
        status: "delivery_failed",
        summary: `Could not deliver follow-up comment to active ${run.runType} workflow`,
      });
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────────

  private async publishAgentActivity(
    linear: NonNullable<Awaited<ReturnType<LinearClientProvider["forProject"]>>>,
    agentSessionId: string,
    content: LinearAgentActivityContent,
    options?: { ephemeral?: boolean },
  ): Promise<void> {
    try {
      await linear.createAgentActivity({
        agentSessionId,
        content,
        ephemeral: options?.ephemeral ?? content.type === "thought",
      });
    } catch (error) {
      this.logger.warn(
        { agentSessionId, error: error instanceof Error ? error.message : String(error) },
        "Failed to publish Linear agent activity",
      );
    }
  }

  private async syncAgentSession(
    linear: NonNullable<Awaited<ReturnType<LinearClientProvider["forProject"]>>>,
    agentSessionId: string,
    issue: TrackedIssueRecord | ReturnType<PatchRelayDatabase["getIssue"]> | undefined,
    options?: { activeRunType?: RunType; pendingRunType?: RunType },
  ): Promise<void> {
    if (!linear.updateAgentSession) return;
    try {
      const prUrl = issue && "prUrl" in issue ? issue.prUrl : undefined;
      const externalUrls = buildAgentSessionExternalUrls(this.config, {
        ...(issue?.issueKey ? { issueKey: issue.issueKey } : {}),
        ...(prUrl ? { prUrl } : {}),
      });
      await linear.updateAgentSession({
        agentSessionId,
        ...(externalUrls ? { externalUrls } : {}),
        ...(issue
          ? {
              plan: buildAgentSessionPlanForIssue(
                {
                  factoryState: issue.factoryState,
                  pendingRunType: options?.pendingRunType ?? ("pendingRunType" in issue ? issue.pendingRunType : undefined),
                  ciRepairAttempts: "ciRepairAttempts" in issue ? issue.ciRepairAttempts : 0,
                  queueRepairAttempts: "queueRepairAttempts" in issue ? issue.queueRepairAttempts : 0,
                },
                options?.activeRunType ? { activeRunType: options.activeRunType } : undefined,
              ),
            }
          : {}),
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

function mergePendingImplementationContext(
  existingJson: string | undefined,
  normalized: NormalizedEvent,
): string | undefined {
  const existing = existingJson ? safeJsonParse<Record<string, unknown>>(existingJson) ?? {} : {};
  const next: Record<string, unknown> = { ...existing };
  const promptContext = normalized.agentSession?.promptContext?.trim();
  const promptBody = normalized.agentSession?.promptBody?.trim();

  if (promptContext) {
    next.promptContext = promptContext;
  }
  if (promptBody) {
    next.promptBody = promptBody;
  }

  return Object.keys(next).length > 0 ? JSON.stringify(next) : undefined;
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
