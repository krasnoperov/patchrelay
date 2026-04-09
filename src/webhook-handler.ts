import type { Logger } from "pino";
import type { CodexAppServerClient } from "./codex-app-server.ts";
import type { PatchRelayDatabase } from "./db.ts";
import type { RunType } from "./factory-state.ts";
import { deriveIssueStatusNote } from "./status-note.ts";
import type { OperatorEventFeed } from "./operator-feed.ts";
import { resolveProject, trustedActorAllowed } from "./project-resolution.ts";
import { normalizeWebhook } from "./webhooks.ts";
import { InstallationWebhookHandler } from "./webhook-installation-handler.ts";
import { AgentSessionHandler } from "./webhooks/agent-session-handler.ts";
import { CommentWakeHandler } from "./webhooks/comment-wake-handler.ts";
import { DesiredStageRecorder } from "./webhooks/desired-stage-recorder.ts";
import {
  hasCompleteIssueContext,
  mergeIssueMetadata,
} from "./webhooks/decision-helpers.ts";
import { IssueRemovalHandler } from "./webhooks/issue-removal-handler.ts";
import type { AppConfig, LinearClientProvider, LinearWebhookPayload, NormalizedEvent, ProjectConfig } from "./types.ts";
import { safeJsonParse, sanitizeDiagnosticText } from "./utils.ts";
import { extractLatestAssistantSummary } from "./issue-session-events.ts";

export interface IssueQueueItem {
  projectId: string;
  issueId: string;
}

export class WebhookHandler {
  private readonly installationHandler: InstallationWebhookHandler;
  private readonly issueRemovalHandler: IssueRemovalHandler;
  private readonly commentWakeHandler: CommentWakeHandler;
  private readonly agentSessionHandler: AgentSessionHandler;
  private readonly desiredStageRecorder: DesiredStageRecorder;

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
    this.issueRemovalHandler = new IssueRemovalHandler(db, feed);
    this.commentWakeHandler = new CommentWakeHandler(db, codex, logger, feed);
    this.agentSessionHandler = new AgentSessionHandler(config, db, linearProvider, codex, logger, feed);
    this.desiredStageRecorder = new DesiredStageRecorder(db, linearProvider, feed);
  }

  async processWebhookEvent(webhookEventId: number): Promise<void> {
    const event = this.db.webhookEvents.getWebhookPayload(webhookEventId);
    if (!event) {
      this.logger.warn({ webhookEventId }, "Webhook event was not found during processing");
      return;
    }

    try {
      const payload = safeJsonParse<LinearWebhookPayload>(event.payloadJson);
      if (!payload) {
        this.db.webhookEvents.markWebhookProcessed(webhookEventId, "failed");
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
        this.db.webhookEvents.markWebhookProcessed(webhookEventId, "processed");
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
        this.db.webhookEvents.markWebhookProcessed(webhookEventId, "processed");
        return;
      }

      const routedIssue = normalized.issue;
      if (!routedIssue) {
        this.db.webhookEvents.markWebhookProcessed(webhookEventId, "failed");
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
        this.db.webhookEvents.markWebhookProcessed(webhookEventId, "processed");
        return;
      }

      this.db.webhookEvents.assignWebhookProject(webhookEventId, project.id);
      const hydrated = await this.hydrateIssueContext(project.id, normalized);
      const issue = hydrated.issue ?? routedIssue;

      // Record desired stage and upsert issue
      const result = await this.desiredStageRecorder.record({
        project,
        normalized: hydrated,
        peekPendingSessionWakeRunType: (projectId, issueId) => this.peekPendingSessionWakeRunType(projectId, issueId),
        stopActiveRun: (run, input) => this.stopActiveRun(run, input),
      });
      const trackedIssue = result.issue;

      const newlyReadyDependents = this.reconcileDependentReadiness(project.id, issue.id);

      // Handle issue removal: release active runs, mark as failed.
      if (hydrated.triggerEvent === "issueRemoved") {
        await this.issueRemovalHandler.handle({
          projectId: project.id,
          issue,
          trackedIssue,
          stopActiveRun: (run, input) => this.stopActiveRun(run, input),
        });
      }

      await this.agentSessionHandler.handle({
        normalized: hydrated,
        project,
        trackedIssue,
        wakeRunType: result.wakeRunType,
        delegated: result.delegated,
        peekPendingSessionWakeRunType: (projectId, issueId) => this.peekPendingSessionWakeRunType(projectId, issueId),
        enqueuePendingSessionWake: (projectId, issueId) => this.enqueuePendingSessionWake(projectId, issueId),
        isDirectReplyToOutstandingQuestion: (targetIssue) => this.isDirectReplyToOutstandingQuestion(targetIssue),
      });

      await this.commentWakeHandler.handle({
        normalized: hydrated,
        project,
        trackedIssue,
        enqueuePendingSessionWake: (projectId, issueId) => this.enqueuePendingSessionWake(projectId, issueId),
        peekPendingSessionWakeRunType: (projectId, issueId) => this.peekPendingSessionWakeRunType(projectId, issueId),
        isDirectReplyToOutstandingQuestion: (targetIssue) => this.isDirectReplyToOutstandingQuestion(targetIssue),
      });

      this.db.webhookEvents.markWebhookProcessed(webhookEventId, "processed");

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
      this.db.webhookEvents.markWebhookProcessed(webhookEventId, "failed");
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

  private reconcileDependentReadiness(projectId: string, blockerLinearIssueId: string): string[] {
    const newlyReady: string[] = [];
    for (const dependent of this.db.issues.listDependents(projectId, blockerLinearIssueId)) {
      const issue = this.db.issues.getIssue(projectId, dependent.linearIssueId);
      if (!issue) {
        continue;
      }

      const unresolved = this.db.issues.countUnresolvedBlockers(projectId, dependent.linearIssueId);
      if (unresolved > 0) {
        if (this.peekPendingSessionWakeRunType(projectId, dependent.linearIssueId) === "implementation"
          && issue.activeRunId === undefined
          && !this.db.issueSessions.hasPendingIssueSessionEvents(projectId, dependent.linearIssueId)) {
          this.db.issues.upsertIssue({
            projectId,
            linearIssueId: dependent.linearIssueId,
            pendingRunType: null,
            pendingRunContextJson: null,
          });
        }
        continue;
      }

      if (issue.factoryState !== "delegated" || issue.activeRunId !== undefined || this.db.issueSessions.hasPendingIssueSessionEvents(projectId, dependent.linearIssueId)) {
        continue;
      }

      if (this.peekPendingSessionWakeRunType(projectId, dependent.linearIssueId) === "implementation") {
        this.db.issues.upsertIssue({
          projectId,
          linearIssueId: dependent.linearIssueId,
          pendingRunType: null,
          pendingRunContextJson: null,
        });
      }
      this.db.issueSessions.appendIssueSessionEventRespectingActiveLease(projectId, dependent.linearIssueId, {
        projectId,
        linearIssueId: dependent.linearIssueId,
        eventType: "delegated",
        dedupeKey: `delegated:${dependent.linearIssueId}`,
      });
      newlyReady.push(dependent.linearIssueId);
    }

    return newlyReady;
  }

  private async stopActiveRun(
    run: NonNullable<ReturnType<PatchRelayDatabase["runs"]["getRunById"]>>,
    input: string,
  ): Promise<void> {
    if (!run.threadId || !run.turnId) return;
    try {
      await this.codex.steerTurn({ threadId: run.threadId, turnId: run.turnId, input });
    } catch (error) {
      this.logger.warn({ runId: run.id, error: error instanceof Error ? error.message : String(error) }, "Failed to steer active run during session shutdown");
    }
  }

  private peekPendingSessionWakeRunType(projectId: string, issueId: string): RunType | undefined {
    return this.db.issueSessions.peekIssueSessionWake(projectId, issueId)?.runType;
  }

  private enqueuePendingSessionWake(projectId: string, issueId: string): RunType | undefined {
    const wake = this.db.issueSessions.peekIssueSessionWake(projectId, issueId);
    if (!wake) {
      return undefined;
    }
    this.enqueueIssue(projectId, issueId);
    return wake.runType;
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
    const latestRun = this.db.runs.getLatestRunForIssue(issue.projectId, issue.linearIssueId);
    const latestRunNote = extractLatestAssistantSummary(latestRun)?.trim();
    if (latestRunNote?.endsWith("?")) {
      return true;
    }
    const latestEvent = this.db.issueSessions.listIssueSessionEvents(issue.projectId, issue.linearIssueId).at(-1);
    const statusNote = deriveIssueStatusNote({
      issue,
      latestRun,
      latestEvent,
      waitingReason: undefined,
    })?.trim();
    return Boolean(statusNote?.endsWith("?"));
  }
}
