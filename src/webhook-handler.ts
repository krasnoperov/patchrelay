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
import { deriveIssueStatusNote } from "./status-note.ts";
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
import { extractLatestAssistantSummary } from "./issue-session-events.ts";

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
        const activeLease = this.db.getActiveIssueSessionLease(project.id, issue.id);
        const commitRemoval = () => {
          if (removedIssue?.activeRunId) {
            const run = this.db.getRun(removedIssue.activeRunId);
            if (run) {
              this.db.finishRun(run.id, { status: "released", failureReason: "Issue removed from Linear" });
            }
            return this.db.upsertIssue({
              projectId: project.id,
              linearIssueId: issue.id,
              activeRunId: null,
              pendingRunType: null,
              factoryState: "failed" as never,
            });
          }
          if (removedIssue && !TERMINAL_STATES.has(removedIssue.factoryState)) {
            return this.db.upsertIssue({
              projectId: project.id,
              linearIssueId: issue.id,
              pendingRunType: null,
              factoryState: "failed" as never,
            });
          }
          return removedIssue;
        };
        if (removedIssue?.activeRunId) {
          const run = this.db.getRun(removedIssue.activeRunId);
          if (run) {
            await this.stopActiveRun(run, "STOP: The Linear issue was removed. Stop working immediately and exit.");
          }
        }
        if (activeLease) {
          this.db.withIssueSessionLease(project.id, issue.id, activeLease.leaseId, commitRemoval);
        } else {
          commitRemoval();
        }
        this.db.appendIssueSessionEvent({
          projectId: project.id,
          linearIssueId: issue.id,
          eventType: "issue_removed",
          dedupeKey: `issue_removed:${issue.id}`,
        });
        this.db.clearPendingIssueSessionEventsRespectingActiveLease(project.id, issue.id);
        this.db.releaseIssueSessionLeaseRespectingActiveLease(project.id, issue.id);
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
      await this.handleAgentSession(hydrated, project, trackedIssue, result.wakeRunType, result.delegated);

      // Handle comments during active run
      await this.handleComment(hydrated, project, trackedIssue);

      this.db.markWebhookProcessed(webhookEventId, "processed");

      const wakeAlreadyQueuedByFollowUpHandler = normalized.triggerEvent === "commentCreated"
        || normalized.triggerEvent === "commentUpdated"
        || normalized.triggerEvent === "agentPrompted";

      if (result.wakeRunType && !wakeAlreadyQueuedByFollowUpHandler) {
        const queuedRunType = this.enqueuePendingSessionWake(project.id, issue.id);
        this.feed?.publish({
          level: "info",
          kind: "stage",
          issueKey: issue.identifier,
          projectId: project.id,
          stage: queuedRunType ?? result.wakeRunType,
          status: "queued",
          summary: `Queued ${(queuedRunType ?? result.wakeRunType)} workflow`,
          detail: `Triggered by ${hydrated.triggerEvent}.`,
        });
      }
      for (const dependentIssueId of newlyReadyDependents) {
        const dependent = this.db.getTrackedIssue(project.id, dependentIssueId);
        const queuedRunType = this.enqueuePendingSessionWake(project.id, dependentIssueId);
        this.feed?.publish({
          level: "info",
          kind: "stage",
          issueKey: dependent?.issueKey,
          projectId: project.id,
          stage: queuedRunType ?? "implementation",
          status: "queued",
          summary: `Queued ${(queuedRunType ?? "implementation")} after blockers resolved`,
          detail: `All blockers are now done for ${dependent?.issueKey ?? dependentIssueId}.`,
        });
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
    wakeRunType: RunType | undefined;
    delegated: boolean;
  }> {
    const normalizedIssue = normalized.issue;
    if (!normalizedIssue) {
      return { issue: undefined, wakeRunType: undefined, delegated: false };
    }

    // ── 1. Fetch data ────────────────────────────────────────────
    const existingIssue = this.db.getIssue(project.id, normalizedIssue.id);
    const activeRun = existingIssue?.activeRunId ? this.db.getRun(existingIssue.activeRunId) : undefined;
    const delegated = this.isDelegatedToPatchRelay(project, normalized);
    const triggerAllowed = triggerEventAllowed(project, normalized.triggerEvent);
    const incomingAgentSessionId = normalized.agentSession?.id;
    const hasPendingWake = this.db.peekIssueSessionWake(project.id, normalizedIssue.id) !== undefined;

    if (!existingIssue && !delegated && !incomingAgentSessionId) {
      return { issue: undefined, wakeRunType: undefined, delegated };
    }

    const hydratedIssue = await this.syncIssueDependencies(project.id, normalizedIssue);
    const unresolvedBlockers = this.db.countUnresolvedBlockers(project.id, normalizedIssue.id);
    const terminal = isTerminalDelegationState(existingIssue, hydratedIssue);

    // ── 2. Pure decisions ────────────────────────────────────────
    const desiredStage = decideRunIntent({
      delegated, triggerAllowed, triggerEvent: normalized.triggerEvent, unresolvedBlockers,
      hasActiveRun: Boolean(activeRun),
      hasPendingWake,
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
    const delegatedStateRecovery =
      delegated
      && !terminal
      && existingIssue?.factoryState === "awaiting_input"
      && !undelegation.factoryState;

    const existingWakeRunType = existingIssue ? this.peekPendingSessionWakeRunType(project.id, normalizedIssue.id) : undefined;
    const clearPending = (unresolvedBlockers > 0 && existingWakeRunType === "implementation" && !activeRun)
      || undelegation.clearPending;

    const agentSessionId = decideAgentSession({
      sessionId: normalized.agentSession?.id,
      triggerEvent: normalized.triggerEvent,
      delegated,
    });

    // ── 3. Transactional commit ──────────────────────────────────
    const commitIssueUpdate = () => {
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
        ...(delegatedStateRecovery ? { factoryState: "delegated" as const } : {}),
        ...(desiredStage ? { pendingRunType: null, pendingRunContextJson: null, factoryState: "delegated" as const } : {}),
        ...(clearPending ? { pendingRunType: null, pendingRunContextJson: null } : {}),
        ...(agentSessionId !== undefined ? { agentSessionId } : {}),
        ...(runRelease.release ? { activeRunId: null } : {}),
        ...(undelegation.factoryState ? { factoryState: undelegation.factoryState as never } : {}),
      });
      if (runRelease.release && activeRun && runRelease.reason) {
        this.db.finishRun(activeRun.id, { status: "released", failureReason: runRelease.reason });
      }
      return record;
    };
    const activeLease = this.db.getActiveIssueSessionLease(project.id, normalizedIssue.id);
    const issue = activeLease
      ? this.db.withIssueSessionLease(project.id, normalizedIssue.id, activeLease.leaseId, commitIssueUpdate) ?? (existingIssue ?? this.db.upsertIssue({
          projectId: project.id,
          linearIssueId: normalizedIssue.id,
          ...(hydratedIssue.identifier ? { issueKey: hydratedIssue.identifier } : {}),
        }))
      : this.db.transaction(commitIssueUpdate);

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
      this.db.clearPendingIssueSessionEventsRespectingActiveLease(project.id, normalizedIssue.id);
      this.db.releaseIssueSessionLeaseRespectingActiveLease(project.id, normalizedIssue.id);
      this.feed?.publish({
        level: "warn",
        kind: "stage",
        issueKey: issue.issueKey,
        projectId: project.id,
        stage: "awaiting_input",
        status: "un_delegated",
        summary: "Issue un-delegated from PatchRelay",
      });
    } else if (
      desiredStage === "implementation"
      && normalized.triggerEvent !== "commentCreated"
      && normalized.triggerEvent !== "commentUpdated"
      && normalized.triggerEvent !== "agentPrompted"
    ) {
      this.db.appendIssueSessionEventRespectingActiveLease(project.id, normalizedIssue.id, {
        projectId: project.id,
        linearIssueId: normalizedIssue.id,
        eventType: "delegated",
        eventJson: JSON.stringify({
          promptContext: normalized.agentSession?.promptContext?.trim()
            ?? (issue.issueKey ? `Linear issue ${issue.issueKey} was delegated to PatchRelay.` : undefined),
          promptBody: normalized.agentSession?.promptBody?.trim(),
        }),
        dedupeKey: `delegated:${normalizedIssue.id}`,
      });
    }

    return {
      issue: this.db.issueToTrackedIssue(issue),
      wakeRunType: this.peekPendingSessionWakeRunType(project.id, normalizedIssue.id),
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
        if (this.peekPendingSessionWakeRunType(projectId, dependent.linearIssueId) === "implementation"
          && issue.activeRunId === undefined
          && !this.db.hasPendingIssueSessionEvents(projectId, dependent.linearIssueId)) {
          this.db.upsertIssue({
            projectId,
            linearIssueId: dependent.linearIssueId,
            pendingRunType: null,
            pendingRunContextJson: null,
          });
        }
        continue;
      }

      if (issue.factoryState !== "delegated" || issue.activeRunId !== undefined || this.db.hasPendingIssueSessionEvents(projectId, dependent.linearIssueId)) {
        continue;
      }

      if (this.peekPendingSessionWakeRunType(projectId, dependent.linearIssueId) === "implementation") {
        this.db.upsertIssue({
          projectId,
          linearIssueId: dependent.linearIssueId,
          pendingRunType: null,
          pendingRunContextJson: null,
        });
      }
      this.db.appendIssueSessionEventRespectingActiveLease(projectId, dependent.linearIssueId, {
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
    wakeRunType: RunType | undefined,
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
      if (wakeRunType) {
        const latestIssue = this.db.getIssue(project.id, normalized.issue.id);
        await this.syncAgentSession(linear, normalized.agentSession.id, latestIssue ?? trackedIssue, { pendingRunType: wakeRunType });
        await this.publishAgentActivity(linear, normalized.agentSession.id, buildDelegationThought(wakeRunType));
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

    if (promptBody && existingIssue && (delegated || existingIssue.factoryState === "awaiting_input")) {
      const hadPendingWake = this.db.peekIssueSessionWake(project.id, normalized.issue.id) !== undefined;
      const directReply = this.isDirectReplyToOutstandingQuestion(existingIssue);
      this.db.appendIssueSessionEventRespectingActiveLease(project.id, normalized.issue.id, {
        projectId: project.id,
        linearIssueId: normalized.issue.id,
        eventType: directReply ? "direct_reply" : "followup_prompt",
        eventJson: JSON.stringify({
          text: promptBody,
          source: "linear_agent_prompt",
        }),
      });
      const queuedRunType = hadPendingWake
        ? this.peekPendingSessionWakeRunType(project.id, normalized.issue.id)
        : this.enqueuePendingSessionWake(project.id, normalized.issue.id);
      const latestIssue = this.db.getIssue(project.id, normalized.issue.id);
      await this.syncAgentSession(linear, normalized.agentSession.id, latestIssue ?? trackedIssue, {
        pendingRunType: queuedRunType ?? wakeRunType ?? (existingIssue.prReviewState === "changes_requested" ? "review_fix" : "implementation"),
      });
      await this.publishAgentActivity(linear, normalized.agentSession.id, buildPromptDeliveredThought(queuedRunType ?? wakeRunType ?? "implementation"), { ephemeral: true });
      return;
    }

    if (wakeRunType) {
      const latestIssue = this.db.getIssue(project.id, normalized.issue.id);
      await this.syncAgentSession(linear, normalized.agentSession.id, latestIssue ?? trackedIssue, { pendingRunType: wakeRunType });
      await this.publishAgentActivity(linear, normalized.agentSession.id, buildDelegationThought(wakeRunType, "prompt"), { ephemeral: true });
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

    this.db.upsertIssueRespectingActiveLease(project.id, issueId, {
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
    this.db.clearPendingIssueSessionEventsRespectingActiveLease(project.id, issueId);
    this.db.releaseIssueSessionLeaseRespectingActiveLease(project.id, issueId);

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

    const issue = this.db.getIssue(project.id, normalized.issue.id);
    if (!issue) return;
    const trimmedBody = normalized.comment.body.trim();

    // Ignore PatchRelay-managed comments to prevent status-sync feedback loops.
    // Linear commentUpdated/commentCreated events can arrive after PatchRelay
    // refreshes its visible status comment, and those updates should never
    // consume review-fix budget or wake a new run.
    const installation = this.db.linearInstallations.getLinearInstallationForProject(project.id);
    const selfAuthored = this.isPatchRelayManagedCommentAuthor(installation, normalized.actor, normalized.comment.userName);
    const inertPatchRelayComment = this.isInertPatchRelayComment(issue, normalized.comment.id, trimmedBody, normalized.actor?.type);
    if (selfAuthored || inertPatchRelayComment) {
      this.db.appendIssueSessionEventRespectingActiveLease(project.id, normalized.issue.id, {
        projectId: project.id,
        linearIssueId: normalized.issue.id,
        eventType: "self_comment",
        eventJson: JSON.stringify({
          body: trimmedBody,
          author: normalized.comment.userName,
        }),
      });
      return;
    }

    // No active run — enqueue a run with the comment as context if appropriate
    if (!issue.activeRunId) {
      const ENQUEUEABLE_STATES = new Set(["pr_open", "changes_requested", "implementing", "delegated", "awaiting_input"]);
      if (ENQUEUEABLE_STATES.has(issue.factoryState)) {
        const directReply = this.isDirectReplyToOutstandingQuestion(issue);
        const wakeIntent = directReply || this.hasExplicitPatchRelayWakeIntent(trimmedBody);
        if (!wakeIntent) {
          this.feed?.publish({
            level: "info",
            kind: "comment",
            projectId: project.id,
            issueKey: trackedIssue?.issueKey,
            status: "ignored",
            summary: "Ignored comment with no explicit PatchRelay wake intent",
            detail: trimmedBody.slice(0, 200),
          });
          return;
        }
        const runType = issue.prReviewState === "changes_requested" ? "review_fix" : "implementation";
        const hadPendingWake = this.db.peekIssueSessionWake(project.id, normalized.issue.id) !== undefined;
        this.db.appendIssueSessionEventRespectingActiveLease(project.id, normalized.issue.id, {
          projectId: project.id,
          linearIssueId: normalized.issue.id,
          eventType: directReply ? "direct_reply" : "followup_comment",
          eventJson: JSON.stringify({
            body: trimmedBody,
            author: normalized.comment.userName,
          }),
        });
        const queuedRunType = hadPendingWake
          ? this.peekPendingSessionWakeRunType(project.id, normalized.issue.id)
          : this.enqueuePendingSessionWake(project.id, normalized.issue.id);
        this.feed?.publish({
          level: "info",
          kind: "comment",
          projectId: project.id,
          issueKey: trackedIssue?.issueKey,
          status: "enqueued",
          summary: `Comment enqueued ${(queuedRunType ?? runType)} run`,
          detail: trimmedBody.slice(0, 200),
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
      trimmedBody,
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
      const hadPendingWake = this.db.hasPendingIssueSessionEvents(project.id, normalized.issue.id);
      const directReply = this.isDirectReplyToOutstandingQuestion(issue);
      this.db.appendIssueSessionEventRespectingActiveLease(project.id, normalized.issue.id, {
        projectId: project.id,
        linearIssueId: normalized.issue.id,
        eventType: directReply ? "direct_reply" : "followup_comment",
        eventJson: JSON.stringify({
          body: trimmedBody,
          author: normalized.comment.userName,
        }),
      });
      if (!hadPendingWake) {
        this.enqueuePendingSessionWake(project.id, normalized.issue.id);
      }
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

  private isInertPatchRelayComment(
    issue: NonNullable<ReturnType<PatchRelayDatabase["getIssue"]>>,
    commentId: string,
    body: string,
    actorType?: string,
  ): boolean {
    if (commentId === issue.statusCommentId) {
      return true;
    }
    if (body.startsWith("## PatchRelay status")
      && body.includes("_PatchRelay updates this comment as it works. Review and merge remain downstream._")) {
      return true;
    }
    const normalizedActorType = actorType?.trim().toLowerCase();
    if (normalizedActorType && normalizedActorType !== "user") {
      return this.isPatchRelayGeneratedActivityComment(body);
    }
    return false;
  }

  private isPatchRelayManagedCommentAuthor(
    installation: ReturnType<PatchRelayDatabase["linearInstallations"]["getLinearInstallationForProject"]>,
    actor: NormalizedEvent["actor"],
    commentUserName?: string,
  ): boolean {
    const actorName = actor?.name?.trim().toLowerCase();
    const commentAuthor = commentUserName?.trim().toLowerCase();
    const installationName = installation?.actorName?.trim().toLowerCase();
    if (installation?.actorId && actor?.id === installation.actorId) {
      return true;
    }
    if (installationName && actorName === installationName) {
      return true;
    }
    if (actorName === "patchrelay" || commentAuthor === "patchrelay") {
      return true;
    }
    return false;
  }

  private isPatchRelayGeneratedActivityComment(body: string): boolean {
    return body.startsWith("PatchRelay needs human help to continue.")
      || body.startsWith("PatchRelay is already working on ")
      || body.startsWith("PatchRelay received the ")
      || body.startsWith("PatchRelay routed your latest instructions into ")
      || body.startsWith("PatchRelay has stopped work as requested.")
      || body.startsWith("Merge preparation failed ")
      || body === "This thread is for an agent session with patchrelay.";
  }

  private hasExplicitPatchRelayWakeIntent(body: string): boolean {
    return /\bpatchrelay\b/i.test(body);
  }

  private peekPendingSessionWakeRunType(projectId: string, issueId: string): RunType | undefined {
    return this.db.peekIssueSessionWake(projectId, issueId)?.runType;
  }

  private enqueuePendingSessionWake(projectId: string, issueId: string): RunType | undefined {
    const wake = this.db.peekIssueSessionWake(projectId, issueId);
    if (!wake) {
      return undefined;
    }
    this.enqueueIssue(projectId, issueId);
    return wake.runType;
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
                  pendingRunType: options?.pendingRunType ?? this.peekPendingSessionWakeRunType(
                    issue.projectId,
                    issue.linearIssueId,
                  ),
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

  private isDirectReplyToOutstandingQuestion(issue: ReturnType<PatchRelayDatabase["getIssue"]>): boolean {
    if (!issue) return false;
    const linearNeedsInput = issue.currentLinearState?.trim().toLowerCase().includes("input") ?? false;
    if (issue.factoryState !== "awaiting_input" && !linearNeedsInput) return false;
    if (issue.threadId) {
      return true;
    }
    const latestRun = this.db.getLatestRunForIssue(issue.projectId, issue.linearIssueId);
    const latestRunNote = extractLatestAssistantSummary(latestRun)?.trim();
    if (latestRunNote?.endsWith("?")) {
      return true;
    }
    const latestEvent = this.db.listIssueSessionEvents(issue.projectId, issue.linearIssueId).at(-1);
    const statusNote = deriveIssueStatusNote({
      issue,
      latestRun,
      latestEvent,
      waitingReason: undefined,
    })?.trim();
    return Boolean(statusNote?.endsWith("?"));
  }
}

// ─── Pure decision functions for recordDesiredStage ──────────────

function decideRunIntent(p: {
  delegated: boolean;
  triggerAllowed: boolean;
  triggerEvent: string;
  unresolvedBlockers: number;
  hasActiveRun: boolean;
  hasPendingWake: boolean;
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
      && !p.hasActiveRun && !p.hasPendingWake && !p.terminal && wakeEligibleState) {
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
