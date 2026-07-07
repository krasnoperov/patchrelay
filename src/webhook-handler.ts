import type { Logger } from "pino";
import type { CodexAppServerClient } from "./codex-app-server.ts";
import type { PatchRelayDatabase } from "./db.ts";
import type { RunType } from "./factory-state.ts";
import { peekRunnableWorkflowTaskRunType } from "./pending-workflow-task.ts";
import { deriveIssueStatusNote } from "./status-note.ts";
import type { OperatorEventFeed } from "./operator-feed.ts";
import { LinearSessionSync } from "./linear-session-sync.ts";
import { trustedActorAllowed } from "./project-resolution.ts";
import { normalizeWebhook } from "./webhooks.ts";
import { InstallationWebhookHandler } from "./webhook-installation-handler.ts";
import { AgentSessionHandler } from "./webhooks/agent-session-handler.ts";
import { CommentInputHandler } from "./webhooks/comment-input-handler.ts";
import { WebhookContextLoader } from "./webhooks/context-loader.ts";
import { DependencyReadinessHandler } from "./webhooks/dependency-readiness-handler.ts";
import { DesiredStageRecorder } from "./webhooks/desired-stage-recorder.ts";
import { IssueRemovalHandler } from "./webhooks/issue-removal-handler.ts";
import type { AppConfig, LinearClientProvider, LinearWebhookPayload } from "./types.ts";
import { safeJsonParse, sanitizeDiagnosticText } from "./utils.ts";
import { extractLatestAssistantSummary } from "./issue-session-events.ts";
import { WorkflowTaskDispatcher } from "./workflow-task-dispatcher.ts";
import { CodexFollowupIntentClassifier, type FollowupIntentClassifier } from "./followup-intent.ts";
import { AgentInputService } from "./agent-input-service.ts";
import { noopTelemetry, type PatchRelayTelemetry } from "./telemetry.ts";
import { reconcileWorkflowTasksForIssue } from "./workflow-task-reconciler.ts";
import { isIssueAwaitingInputProjection } from "./issue-execution-state.ts";

export interface IssueQueueItem {
  projectId: string;
  issueId: string;
}

export class WebhookHandler {
  private readonly installationHandler: InstallationWebhookHandler;
  private readonly issueRemovalHandler: IssueRemovalHandler;
  private readonly commentInputHandler: CommentInputHandler;
  private readonly agentSessionHandler: AgentSessionHandler;
  private readonly desiredStageRecorder: DesiredStageRecorder;
  private readonly contextLoader: WebhookContextLoader;
  private readonly dependencyReadinessHandler: DependencyReadinessHandler;
  private readonly linearSync: LinearSessionSync;

  private readonly workflowTaskDispatcher: WorkflowTaskDispatcher;

  constructor(
    private readonly config: AppConfig,
    private readonly db: PatchRelayDatabase,
    private readonly linearProvider: LinearClientProvider,
    private readonly codex: CodexAppServerClient,
    workflowTaskDispatcherOrEnqueueIssue: WorkflowTaskDispatcher | ((projectId: string, issueId: string) => void),
    private readonly logger: Logger,
    private readonly feed?: OperatorEventFeed,
    followupClassifier?: FollowupIntentClassifier,
    agentInput?: AgentInputService,
    private readonly telemetry: PatchRelayTelemetry = noopTelemetry,
  ) {
    // Webhook handlers never release leases — the orchestrator's
    // run finalizer owns that. So when a test passes a bare
    // enqueueIssue callback, wrap it in a dispatcher with a no-op
    // releaseLease (any production caller passes a real dispatcher).
    this.workflowTaskDispatcher = workflowTaskDispatcherOrEnqueueIssue instanceof WorkflowTaskDispatcher
      ? workflowTaskDispatcherOrEnqueueIssue
      : new WorkflowTaskDispatcher(db, workflowTaskDispatcherOrEnqueueIssue, () => undefined, logger, feed, telemetry);

    this.installationHandler = new InstallationWebhookHandler(config, { linearInstallations: db.linearInstallations }, logger, feed);
    this.issueRemovalHandler = new IssueRemovalHandler(db, feed);
    this.linearSync = new LinearSessionSync(config, db, linearProvider, logger, feed);
    const intentClassifier = followupClassifier ?? new CodexFollowupIntentClassifier(codex, logger);
    const agentInputService = agentInput ?? new AgentInputService(db, codex, this.workflowTaskDispatcher, logger, feed, intentClassifier);
    this.commentInputHandler = new CommentInputHandler(
      db,
      this.workflowTaskDispatcher,
      feed,
      agentInputService,
      (issue, content, options) => this.linearSync.emitActivity(issue, content, options),
    );
    this.agentSessionHandler = new AgentSessionHandler(config, db, linearProvider, codex, this.workflowTaskDispatcher, logger, feed, agentInputService);
    this.desiredStageRecorder = new DesiredStageRecorder(db, linearProvider, this.workflowTaskDispatcher, feed);
    this.contextLoader = new WebhookContextLoader(config, linearProvider);
    this.dependencyReadinessHandler = new DependencyReadinessHandler(
      db,
      this.workflowTaskDispatcher,
      telemetry,
    );
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

      await this.agentSessionHandler.acknowledgeCreated(normalized);

      const routed = await this.contextLoader.load(normalized);
      const project = routed?.project;
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
      normalized = routed.normalized;

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
      const hydrated = normalized;
      const issue = hydrated.issue ?? routedIssue;

      this.db.issues.updateDependencyBlockerSnapshot({
        projectId: project.id,
        blockerLinearIssueId: issue.id,
        ...(issue.identifier ? { blockerIssueKey: issue.identifier } : {}),
        ...(issue.title ? { blockerTitle: issue.title } : {}),
        ...(issue.stateName ? { blockerCurrentLinearState: issue.stateName } : {}),
        ...(issue.stateType ? { blockerCurrentLinearStateType: issue.stateType } : {}),
      });

      // Record desired stage and upsert issue
      const result = await this.desiredStageRecorder.record({
        project,
        normalized: hydrated,
        peekRunnableWorkflowTaskRunType: (projectId, issueId) => this.peekRunnableWorkflowTaskRunType(projectId, issueId),
        stopActiveRun: (run, input) => this.stopActiveRun(run, input),
      });
      const trackedIssue = result.issue;
      this.db.workflowObservations.appendObservation({
        projectId: project.id,
        subjectId: issue.id,
        source: "linear",
        type: hydrated.triggerEvent === "delegateChanged"
          ? result.delegated ? "linear.delegated" : "linear.undelegated"
          : `linear.${hydrated.triggerEvent}`,
        payloadJson: JSON.stringify({
          triggerEvent: hydrated.triggerEvent,
          webhookId: hydrated.webhookId,
          delegated: result.delegated,
          issueId: issue.id,
          issueKey: issue.identifier,
          agentSessionId: hydrated.agentSession?.id,
          promptContext: hydrated.agentSession?.promptContext?.trim(),
          promptBody: hydrated.agentSession?.promptBody?.trim(),
          actorId: hydrated.actor?.id,
          actorName: hydrated.actor?.name,
        }),
        dedupeKey: hydrated.webhookId,
      });
      const observedIssue = this.db.getIssue(project.id, issue.id);
      let runnableWorkflowTaskRunType: RunType | undefined;
      if (observedIssue) {
        reconcileWorkflowTasksForIssue(this.db, observedIssue);
        runnableWorkflowTaskRunType = this.peekRunnableWorkflowTaskRunType(project.id, issue.id);
      }

      const newlyReadyDependents = this.dependencyReadinessHandler.reconcile(project.id, issue.id);

      const syncTargets = new Set<string>(
        shouldSyncLinearStateAfterWebhook(hydrated.triggerEvent)
          ? [issue.id, ...newlyReadyDependents]
          : newlyReadyDependents,
      );

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
        runnableTaskRunType: result.runnableTaskRunType,
        delegated: result.delegated,
        peekRunnableWorkflowTaskRunType: (projectId, issueId) => this.peekRunnableWorkflowTaskRunType(projectId, issueId),
        isDirectReplyToOutstandingQuestion: (targetIssue) => this.isDirectReplyToOutstandingQuestion(targetIssue),
      });

      await this.commentInputHandler.handle({
        normalized: hydrated,
        project,
        trackedIssue,
        isDirectReplyToOutstandingQuestion: (targetIssue) => this.isDirectReplyToOutstandingQuestion(targetIssue),
      });

      this.db.webhookEvents.markWebhookProcessed(webhookEventId, "processed");

      const dispatchAlreadyQueuedByFollowUpHandler = normalized.triggerEvent === "commentCreated"
        || normalized.triggerEvent === "commentUpdated"
        || normalized.triggerEvent === "agentPrompted";

      await this.workflowTaskDispatcher.withTick(async () => {
        if ((result.runnableTaskRunType || runnableWorkflowTaskRunType) && !dispatchAlreadyQueuedByFollowUpHandler) {
          const queuedRunType = this.enqueueRunnableWorkflowTask(project.id, issue.id);
          if (queuedRunType) {
            this.feed?.publish({
              level: "info",
              kind: "stage",
              issueKey: issue.identifier,
              projectId: project.id,
              stage: queuedRunType,
              status: "queued",
              summary: `Queued ${queuedRunType} workflow`,
              detail: `Triggered by ${hydrated.triggerEvent}.`,
            });
          }
        }
        for (const dependentIssueId of newlyReadyDependents) {
          // The dependency-readiness handler already dispatched via the
          // workflow task dispatcher; here we just emit the operator-feed event so
          // the dispatched run shows up in the timeline.
          const dependent = this.db.getTrackedIssue(project.id, dependentIssueId);
          const queuedRunType = this.peekRunnableWorkflowTaskRunType(project.id, dependentIssueId);
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
      });
      for (const issueId of syncTargets) {
        const syncIssue = this.db.getIssue(project.id, issueId);
        if (!syncIssue) {
          continue;
        }
        await this.linearSync.syncSession(syncIssue);
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

  private peekRunnableWorkflowTaskRunType(projectId: string, issueId: string): RunType | undefined {
    return peekRunnableWorkflowTaskRunType(this.db, projectId, issueId);
  }

  private enqueueRunnableWorkflowTask(projectId: string, issueId: string): RunType | undefined {
    return this.workflowTaskDispatcher.dispatchIfWorkflowTaskPending(projectId, issueId);
  }

  private isDirectReplyToOutstandingQuestion(issue: ReturnType<PatchRelayDatabase["getIssue"]>): boolean {
    if (!issue) return false;
    const linearNeedsInput = issue.currentLinearState?.trim().toLowerCase().includes("input") ?? false;
    if (!isIssueAwaitingInputProjection(issue) && !linearNeedsInput) return false;
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

function shouldSyncLinearStateAfterWebhook(triggerEvent: string): boolean {
  return triggerEvent !== "agentSessionCreated"
    && triggerEvent !== "agentPrompted"
    && triggerEvent !== "commentCreated"
    && triggerEvent !== "commentUpdated"
    && triggerEvent !== "commentRemoved";
}
