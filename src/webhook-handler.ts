import type { Logger } from "pino";
import {
  buildAgentSessionPlanForIssue,
} from "./agent-session-plan.ts";
import { buildAgentSessionExternalUrls } from "./agent-session-presentation.ts";
import type { CodexAppServerClient } from "./codex-app-server.ts";
import type { PatchRelayDatabase } from "./db.ts";
import { TERMINAL_STATES, type RunType, type FactoryState } from "./factory-state.ts";
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
      const result = await this.recordDesiredStage(project, hydrated);
      const trackedIssue = result.issue;

      const newlyReadyDependents = this.reconcileDependentReadiness(project.id, issue.id);

      // Handle issue removal: release active runs, mark as failed.
      if (hydrated.triggerEvent === "issueRemoved" && trackedIssue) {
        const removedIssue = this.db.getIssue(project.id, issue.id);
        if (removedIssue?.activeRunId) {
          const run = this.db.getRun(removedIssue.activeRunId);
          if (run) {
            await this.stopActiveRun(run, "STOP: The Linear issue was removed. Stop working immediately and exit.");
            this.db.finishRun(run.id, { status: "released", failureReason: "Issue removed from Linear" });
          }
          this.db.upsertIssue({
            projectId: project.id,
            linearIssueId: issue.id,
            activeRunId: null,
            pendingRunType: null,
            factoryState: "failed" as never,
          });
        } else if (removedIssue && !TERMINAL_STATES.has(removedIssue.factoryState)) {
          this.db.upsertIssue({
            projectId: project.id,
            linearIssueId: issue.id,
            pendingRunType: null,
            factoryState: "failed" as never,
          });
        }
        this.db.appendIssueSessionEvent({
          projectId: project.id,
          linearIssueId: issue.id,
          eventType: "issue_removed",
          dedupeKey: `issue_removed:${issue.id}`,
        });
        this.db.clearPendingIssueSessionEvents(project.id, issue.id);
        this.db.releaseIssueSessionLease(project.id, issue.id);
        this.feed?.publish({
          level: "warn",
          kind: "stage",
          issueKey: issue.identifier,
          projectId: project.id,
          stage: "failed",
          status: "issue_removed",
          summary: "Issue removed from Linear",
        });
      }

      // Handle agent session events
      await this.handleAgentSession(hydrated, project, trackedIssue, result.desiredStage, result.delegated);

      // Handle comments during active run
      await this.handleComment(hydrated, project, trackedIssue);

      this.db.markWebhookProcessed(webhookEventId, "processed");

      if (result.desiredStage) {
        if (result.desiredStage === "implementation") {
          this.db.appendIssueSessionEvent({
            projectId: project.id,
            linearIssueId: issue.id,
            eventType: "delegated",
            eventJson: JSON.stringify({
              promptContext: trackedIssue?.issueKey ? `Linear issue ${trackedIssue.issueKey} was delegated to PatchRelay.` : undefined,
              promptBody: normalized.agentSession?.promptBody?.trim(),
            }),
            dedupeKey: `delegated:${issue.id}`,
          });
        }
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
      for (const dependentIssueId of newlyReadyDependents) {
        const dependent = this.db.getTrackedIssue(project.id, dependentIssueId);
        this.feed?.publish({
          level: "info",
          kind: "stage",
          issueKey: dependent?.issueKey,
          projectId: project.id,
          stage: "implementation",
          status: "queued",
          summary: "Queued implementation after blockers resolved",
          detail: `All blockers are now done for ${dependent?.issueKey ?? dependentIssueId}.`,
        });
        this.enqueueIssue(project.id, dependentIssueId);
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

  private async recordDesiredStage(
    project: ProjectConfig,
    normalized: NormalizedEvent,
  ): Promise<{
    issue: TrackedIssueRecord | undefined;
    desiredStage: RunType | undefined;
    delegated: boolean;
  }> {
    const normalizedIssue = normalized.issue;
    if (!normalizedIssue) {
      return { issue: undefined, desiredStage: undefined, delegated: false };
    }

    // ── 1. Fetch data ────────────────────────────────────────────
    const existingIssue = this.db.getIssue(project.id, normalizedIssue.id);
    const activeRun = existingIssue?.activeRunId ? this.db.getRun(existingIssue.activeRunId) : undefined;
    const delegated = this.isDelegatedToPatchRelay(project, normalized);
    const triggerAllowed = triggerEventAllowed(project, normalized.triggerEvent);
    const incomingAgentSessionId = normalized.agentSession?.id;

    if (!existingIssue && !delegated && !incomingAgentSessionId) {
      return { issue: undefined, desiredStage: undefined, delegated };
    }

    const hydratedIssue = await this.syncIssueDependencies(project.id, normalizedIssue);
    const unresolvedBlockers = this.db.countUnresolvedBlockers(project.id, normalizedIssue.id);
    const pendingRunContextJson = mergePendingImplementationContext(existingIssue?.pendingRunContextJson, normalized);
    const terminal = isTerminalDelegationState(existingIssue, hydratedIssue);

    // ── 2. Pure decisions ────────────────────────────────────────
    const pendingRunType = decideRunIntent({
      delegated, triggerAllowed, triggerEvent: normalized.triggerEvent, unresolvedBlockers,
      hasActiveRun: Boolean(activeRun),
      hasPendingRun: Boolean(existingIssue?.pendingRunType),
      terminal,
      currentState: existingIssue?.factoryState,
    });

    const runRelease = decideActiveRunRelease({
      hasActiveRun: Boolean(activeRun),
      terminal,
      triggerEvent: normalized.triggerEvent,
      delegated,
    });

    const undelegation = decideUnDelegation({
      triggerEvent: normalized.triggerEvent,
      delegated,
      currentState: existingIssue?.factoryState,
    });

    const clearPending = (unresolvedBlockers > 0 && existingIssue?.pendingRunType === "implementation" && !activeRun)
      || undelegation.clearPending;

    const agentSessionId = decideAgentSession({
      sessionId: normalized.agentSession?.id,
      hasActiveRun: Boolean(activeRun),
      hasPendingRun: Boolean(pendingRunType),
      triggerEvent: normalized.triggerEvent,
      delegated,
    });

    // ── 3. Transactional commit ──────────────────────────────────
    const issue = this.db.transaction(() => {
      const record = this.db.upsertIssue({
        projectId: project.id,
        linearIssueId: normalizedIssue.id,
        ...(hydratedIssue.identifier ? { issueKey: hydratedIssue.identifier } : {}),
        ...(hydratedIssue.title ? { title: hydratedIssue.title } : {}),
        ...(hydratedIssue.description ? { description: hydratedIssue.description } : {}),
        ...(hydratedIssue.url ? { url: hydratedIssue.url } : {}),
        ...(hydratedIssue.priority != null ? { priority: hydratedIssue.priority } : {}),
        ...(hydratedIssue.estimate != null ? { estimate: hydratedIssue.estimate } : {}),
        ...(hydratedIssue.stateName ? { currentLinearState: hydratedIssue.stateName } : {}),
        ...(hydratedIssue.stateType ? { currentLinearStateType: hydratedIssue.stateType } : {}),
        ...(!existingIssue && !delegated && incomingAgentSessionId ? { factoryState: "awaiting_input" as const } : {}),
        ...(pendingRunType ? { pendingRunType, factoryState: "delegated" as const } : {}),
        ...(clearPending ? { pendingRunType: null } : {}),
        ...((pendingRunType || existingIssue?.pendingRunType === "implementation") && pendingRunContextJson
          ? { pendingRunContextJson }
          : {}),
        ...(agentSessionId !== undefined ? { agentSessionId } : {}),
        ...(runRelease.release ? { activeRunId: null } : {}),
        ...(undelegation.factoryState ? { factoryState: undelegation.factoryState as never } : {}),
      });
      if (runRelease.release && activeRun && runRelease.reason) {
        this.db.finishRun(activeRun.id, { status: "released", failureReason: runRelease.reason });
      }
      return record;
    });

    // ── 4. Side effects (after transaction) ──────────────────────
    if (undelegation.factoryState) {
      if (activeRun?.threadId && activeRun.turnId) {
        await this.stopActiveRun(activeRun, "STOP: The issue was un-delegated from PatchRelay. Stop working immediately and exit.");
      }
      this.db.appendIssueSessionEvent({
        projectId: project.id,
        linearIssueId: normalizedIssue.id,
        eventType: "undelegated",
        dedupeKey: `undelegated:${normalizedIssue.id}`,
      });
      this.db.clearPendingIssueSessionEvents(project.id, normalizedIssue.id);
      this.db.releaseIssueSessionLease(project.id, normalizedIssue.id);
      this.feed?.publish({
        level: "warn",
        kind: "stage",
        issueKey: issue.issueKey,
        projectId: project.id,
        stage: "awaiting_input",
        status: "un_delegated",
        summary: "Issue un-delegated from PatchRelay",
      });
    }

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

  private async syncIssueDependencies(projectId: string, issue: IssueMetadata): Promise<IssueMetadata> {
    let source = issue;
    if (!source.relationsKnown) {
      const linear = await this.linearProvider.forProject(projectId);
      if (linear) {
        try {
          source = mergeIssueMetadata(source, await linear.getIssue(issue.id));
        } catch {
          // Preserve existing dependency rows when webhook relation data is incomplete.
        }
      }
    }

    if (source.relationsKnown) {
      this.db.replaceIssueDependencies({
        projectId,
        linearIssueId: source.id,
        blockers: source.blockedBy.map((blocker) => ({
          blockerLinearIssueId: blocker.id,
          ...(blocker.identifier ? { blockerIssueKey: blocker.identifier } : {}),
          ...(blocker.title ? { blockerTitle: blocker.title } : {}),
          ...(blocker.stateName ? { blockerCurrentLinearState: blocker.stateName } : {}),
          ...(blocker.stateType ? { blockerCurrentLinearStateType: blocker.stateType } : {}),
        })),
      });
    }

    return source;
  }

  private reconcileDependentReadiness(projectId: string, blockerLinearIssueId: string): string[] {
    const newlyReady: string[] = [];
    for (const dependent of this.db.listDependents(projectId, blockerLinearIssueId)) {
      const issue = this.db.getIssue(projectId, dependent.linearIssueId);
      if (!issue) {
        continue;
      }

      const unresolved = this.db.countUnresolvedBlockers(projectId, dependent.linearIssueId);
      if (unresolved > 0) {
        if (issue.pendingRunType === "implementation" && issue.activeRunId === undefined) {
          this.db.upsertIssue({
            projectId,
            linearIssueId: dependent.linearIssueId,
            pendingRunType: null,
          });
        }
        continue;
      }

      if (issue.factoryState !== "delegated" || issue.activeRunId !== undefined || issue.pendingRunType !== undefined) {
        continue;
      }

      this.db.upsertIssue({
        projectId,
        linearIssueId: dependent.linearIssueId,
        pendingRunType: "implementation",
      });
      this.db.appendIssueSessionEvent({
        projectId,
        linearIssueId: dependent.linearIssueId,
        eventType: "delegated",
        dedupeKey: `delegated:${dependent.linearIssueId}`,
      });
      newlyReady.push(dependent.linearIssueId);
    }

    return newlyReady;
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
        const latestIssue = this.db.getIssue(project.id, normalized.issue.id);
        if (latestIssue ?? trackedIssue) {
          await this.syncAgentSession(linear, normalized.agentSession.id, latestIssue ?? trackedIssue);
        }
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
      const blockerSummary = trackedIssue?.blockedByCount
        ? `PatchRelay is delegated and waiting on blockers to reach Done: ${trackedIssue.blockedByKeys.join(", ")}.`
        : "PatchRelay is delegated, but no work is queued. Delegate the issue or move it to Start to trigger implementation.";
      await this.publishAgentActivity(linear, normalized.agentSession.id, {
        type: "elicitation",
        body: blockerSummary,
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

    if (promptBody && existingIssue && delegated) {
      this.db.appendIssueSessionEvent({
        projectId: project.id,
        linearIssueId: normalized.issue.id,
        eventType: "followup_prompt",
        eventJson: JSON.stringify({
          text: promptBody,
          source: "linear_agent_prompt",
        }),
      });
      this.enqueueIssue(project.id, normalized.issue.id);
      const latestIssue = this.db.getIssue(project.id, normalized.issue.id);
      await this.syncAgentSession(linear, normalized.agentSession.id, latestIssue ?? trackedIssue, {
        pendingRunType: desiredStage ?? (existingIssue.prReviewState === "changes_requested" ? "review_fix" : "implementation"),
      });
      await this.publishAgentActivity(linear, normalized.agentSession.id, buildPromptDeliveredThought(desiredStage ?? "implementation"), { ephemeral: true });
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
    this.db.appendIssueSessionEvent({
      projectId: project.id,
      linearIssueId: issueId,
      eventType: "stop_requested",
      dedupeKey: `stop_requested:${issueId}`,
    });
    this.db.clearPendingIssueSessionEvents(project.id, issueId);
    this.db.releaseIssueSessionLease(project.id, issueId);

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

  private async stopActiveRun(
    run: NonNullable<ReturnType<PatchRelayDatabase["getRun"]>>,
    input: string,
  ): Promise<void> {
    if (!run.threadId || !run.turnId) return;
    try {
      await this.codex.steerTurn({ threadId: run.threadId, turnId: run.turnId, input });
    } catch (error) {
      this.logger.warn({ runId: run.id, error: error instanceof Error ? error.message : String(error) }, "Failed to steer active run during session shutdown");
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
        this.db.appendIssueSessionEvent({
          projectId: project.id,
          linearIssueId: normalized.issue.id,
          eventType: "followup_comment",
          eventJson: JSON.stringify({
            body: normalized.comment.body.trim(),
            author: normalized.comment.userName,
          }),
        });
        if (!issue.pendingRunType) {
          this.enqueueIssue(project.id, normalized.issue.id);
        }
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
      this.db.appendIssueSessionEvent({
        projectId: project.id,
        linearIssueId: normalized.issue.id,
        eventType: "followup_comment",
        eventJson: JSON.stringify({
          body: normalized.comment.body.trim(),
          author: normalized.comment.userName,
        }),
      });
      this.enqueueIssue(project.id, normalized.issue.id);
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

  private async isCurrentLinearIssueDelegatedToPatchRelay(
    linear: NonNullable<Awaited<ReturnType<LinearClientProvider["forProject"]>>>,
    projectId: string,
    issueId: string,
  ): Promise<boolean> {
    const installation = this.db.linearInstallations.getLinearInstallationForProject(projectId);
    if (!installation?.actorId) return false;
    try {
      const issue = await linear.getIssue(issueId);
      return issue.delegateId === installation.actorId;
    } catch {
      return false;
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
    if (normalized.triggerEvent !== "agentSessionCreated" && normalized.triggerEvent !== "agentPrompted" && normalized.entityType !== "Issue") {
      return normalized;
    }
    if (normalized.entityType !== "Issue" && hasCompleteIssueContext(normalized.issue)) return normalized;

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

// ─── Pure decision functions for recordDesiredStage ──────────────

function decideRunIntent(p: {
  delegated: boolean;
  triggerAllowed: boolean;
  triggerEvent: string;
  unresolvedBlockers: number;
  hasActiveRun: boolean;
  hasPendingRun: boolean;
  terminal: boolean;
  currentState?: FactoryState | undefined;
}): RunType | undefined {
  const wakeEligibleState =
    p.currentState === undefined
    || p.currentState === "delegated"
    || p.currentState === "awaiting_input";
  const delegatedStartupRecovery =
    p.delegated
    && p.currentState === "awaiting_input"
    && p.triggerEvent === "issueCreated";
  if (p.delegated && (p.triggerAllowed || delegatedStartupRecovery) && p.unresolvedBlockers === 0
      && !p.hasActiveRun && !p.hasPendingRun && !p.terminal && wakeEligibleState) {
    return "implementation";
  }
  return undefined;
}

function decideActiveRunRelease(p: {
  hasActiveRun: boolean;
  terminal: boolean;
  triggerEvent: string;
  delegated: boolean;
}): { release: boolean; reason?: string } {
  if (!p.hasActiveRun) return { release: false };
  if (p.terminal) return { release: true, reason: "Issue reached terminal state during active run" };
  if (p.triggerEvent === "delegateChanged" && !p.delegated) return { release: true, reason: "Un-delegated from PatchRelay" };
  return { release: false };
}

function decideUnDelegation(p: {
  triggerEvent: string;
  delegated: boolean;
  currentState?: FactoryState | undefined;
}): { factoryState?: FactoryState | undefined; clearPending: boolean } {
  if (p.triggerEvent !== "delegateChanged" || p.delegated) return { clearPending: false };
  if (!p.currentState) return { clearPending: false };
  const pastNoReturn = p.currentState === "awaiting_queue" || TERMINAL_STATES.has(p.currentState);
  if (pastNoReturn) return { clearPending: false };
  return { factoryState: "awaiting_input", clearPending: true };
}

function decideAgentSession(p: {
  sessionId?: string | undefined;
  hasActiveRun: boolean;
  hasPendingRun: boolean;
  triggerEvent: string;
  delegated: boolean;
}): string | null | undefined {
  if (p.sessionId) return p.sessionId;
  if (p.triggerEvent === "delegateChanged" && !p.delegated) return null;
  return undefined;
}

// ─── Helper predicates ──────────────────────────────────────────

function isResolvedLinearState(stateType?: string, stateName?: string): boolean {
  return stateType === "completed" || stateName?.trim().toLowerCase() === "done";
}

function isTerminalDelegationState(
  existingIssue: ReturnType<PatchRelayDatabase["getIssue"]>,
  hydratedIssue: IssueMetadata,
): boolean {
  if (existingIssue?.prState === "merged") {
    return true;
  }
  if (existingIssue?.factoryState && existingIssue.factoryState !== "awaiting_input" && TERMINAL_STATES.has(existingIssue.factoryState)) {
    return true;
  }
  return isResolvedLinearState(hydratedIssue.stateType, hydratedIssue.stateName);
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
    teamId?: string; teamKey?: string; stateId?: string; stateName?: string; stateType?: string;
    delegateId?: string; delegateName?: string;
    blockedBy?: Array<{ id: string; identifier?: string; title?: string; stateName?: string; stateType?: string }>;
    blocks?: Array<{ id: string; identifier?: string; title?: string; stateName?: string; stateType?: string }>;
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
    ...(issue.stateType ? {} : liveIssue.stateType ? { stateType: liveIssue.stateType } : {}),
    ...(issue.delegateId ? {} : liveIssue.delegateId ? { delegateId: liveIssue.delegateId } : {}),
    ...(issue.delegateName ? {} : liveIssue.delegateName ? { delegateName: liveIssue.delegateName } : {}),
    relationsKnown: issue.relationsKnown || liveIssue.blockedBy !== undefined || liveIssue.blocks !== undefined,
    labelNames: issue.labelNames.length > 0 ? issue.labelNames : (liveIssue.labels ?? []).map((l) => l.name),
    blockedBy: issue.relationsKnown ? issue.blockedBy : (liveIssue.blockedBy ?? issue.blockedBy),
    blocks: issue.relationsKnown ? issue.blocks : (liveIssue.blocks ?? issue.blocks),
  };
}
