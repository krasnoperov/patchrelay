import type { Logger } from "pino";
import {
  buildAgentSessionPlanForIssue,
} from "../agent-session-plan.ts";
import { buildAgentSessionExternalUrls } from "../agent-session-presentation.ts";
import type { CodexAppServerClient } from "../codex-app-server.ts";
import type { PatchRelayDatabase } from "../db.ts";
import type { RunType } from "../factory-state.ts";
import {
  buildAlreadyRunningThought,
  buildDelegationThought,
  buildPromptDeliveredThought,
  buildStopConfirmationActivity,
} from "../linear-session-reporting.ts";
import type { OperatorEventFeed } from "../operator-feed.ts";
import { triggerEventAllowed } from "../project-resolution.ts";
import type {
  AppConfig,
  LinearAgentActivityContent,
  LinearClientProvider,
  NormalizedEvent,
  ProjectConfig,
  TrackedIssueRecord,
} from "../types.ts";

type LinearClient = NonNullable<Awaited<ReturnType<LinearClientProvider["forProject"]>>>;

export class AgentSessionHandler {
  constructor(
    private readonly config: AppConfig,
    private readonly db: PatchRelayDatabase,
    private readonly linearProvider: LinearClientProvider,
    private readonly codex: CodexAppServerClient,
    private readonly logger: Logger,
    private readonly feed?: OperatorEventFeed,
  ) {}

  async handle(params: {
    normalized: NormalizedEvent;
    project: ProjectConfig;
    trackedIssue: TrackedIssueRecord | undefined;
    wakeRunType: RunType | undefined;
    delegated: boolean;
    peekPendingSessionWakeRunType: (projectId: string, issueId: string) => RunType | undefined;
    enqueuePendingSessionWake: (projectId: string, issueId: string) => RunType | undefined;
    isDirectReplyToOutstandingQuestion: (issue: ReturnType<PatchRelayDatabase["getIssue"]>) => boolean;
  }): Promise<void> {
    const { normalized, project, trackedIssue, wakeRunType, delegated } = params;
    if (!normalized.agentSession?.id || !normalized.issue) return;

    const linear = await this.linearProvider.forProject(project.id);
    if (!linear) return;

    const existingIssue = this.db.getIssue(project.id, normalized.issue.id);
    const activeRun = existingIssue?.activeRunId ? this.db.runs.getRunById(existingIssue.activeRunId) : undefined;

    if (normalized.triggerEvent === "agentSessionCreated") {
      if (!delegated) {
        const latestIssue = this.db.getIssue(project.id, normalized.issue.id);
        if (latestIssue ?? trackedIssue) {
          await this.syncAgentSession(linear, normalized.agentSession.id, latestIssue ?? trackedIssue, params.peekPendingSessionWakeRunType);
        }
        return;
      }
      if (wakeRunType) {
        const latestIssue = this.db.getIssue(project.id, normalized.issue.id);
        await this.syncAgentSession(linear, normalized.agentSession.id, latestIssue ?? trackedIssue, params.peekPendingSessionWakeRunType, { pendingRunType: wakeRunType });
        await this.publishAgentActivity(linear, normalized.agentSession.id, buildDelegationThought(wakeRunType));
        return;
      }
      if (activeRun) {
        const latestIssue = this.db.getIssue(project.id, normalized.issue.id);
        await this.syncAgentSession(linear, normalized.agentSession.id, latestIssue ?? trackedIssue, params.peekPendingSessionWakeRunType, { activeRunType: activeRun.runType });
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

    if (normalized.triggerEvent === "agentSignal" && normalized.agentSession.signal === "stop") {
      await this.handleStopSignal({
        normalized,
        project,
        trackedIssue,
        activeRun,
        linear,
        syncAgentSession: (agentSessionId, issue, options) =>
          this.syncAgentSession(linear, agentSessionId, issue, params.peekPendingSessionWakeRunType, options),
      });
      return;
    }

    if (normalized.triggerEvent !== "agentPrompted") return;
    if (!triggerEventAllowed(project, normalized.triggerEvent)) return;

    const promptBody = normalized.agentSession.promptBody?.trim();
    if (activeRun && promptBody && activeRun.threadId && activeRun.turnId) {
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
      const hadPendingWake = this.db.issueSessions.peekIssueSessionWake(project.id, normalized.issue.id) !== undefined;
      const directReply = params.isDirectReplyToOutstandingQuestion(existingIssue);
      this.db.issueSessions.appendIssueSessionEventRespectingActiveLease(project.id, normalized.issue.id, {
        projectId: project.id,
        linearIssueId: normalized.issue.id,
        eventType: directReply ? "direct_reply" : "followup_prompt",
        eventJson: JSON.stringify({
          text: promptBody,
          source: "linear_agent_prompt",
        }),
      });
      const queuedRunType = hadPendingWake
        ? params.peekPendingSessionWakeRunType(project.id, normalized.issue.id)
        : params.enqueuePendingSessionWake(project.id, normalized.issue.id);
      const latestIssue = this.db.getIssue(project.id, normalized.issue.id);
      await this.syncAgentSession(
        linear,
        normalized.agentSession.id,
        latestIssue ?? trackedIssue,
        params.peekPendingSessionWakeRunType,
        { pendingRunType: queuedRunType ?? wakeRunType ?? (existingIssue.prReviewState === "changes_requested" ? "review_fix" : "implementation") },
      );
      await this.publishAgentActivity(linear, normalized.agentSession.id, buildPromptDeliveredThought(queuedRunType ?? wakeRunType ?? "implementation"), { ephemeral: true });
      return;
    }

    if (wakeRunType) {
      const latestIssue = this.db.getIssue(project.id, normalized.issue.id);
      await this.syncAgentSession(linear, normalized.agentSession.id, latestIssue ?? trackedIssue, params.peekPendingSessionWakeRunType, { pendingRunType: wakeRunType });
      await this.publishAgentActivity(linear, normalized.agentSession.id, buildDelegationThought(wakeRunType, "prompt"), { ephemeral: true });
    }
  }

  private async handleStopSignal(params: {
    normalized: NormalizedEvent;
    project: ProjectConfig;
    trackedIssue: TrackedIssueRecord | undefined;
    activeRun: ReturnType<PatchRelayDatabase["runs"]["getRunById"]>;
    linear: LinearClient;
    syncAgentSession: (
      agentSessionId: string,
      issue: TrackedIssueRecord | ReturnType<PatchRelayDatabase["getIssue"]> | undefined,
      options?: { activeRunType?: RunType; pendingRunType?: RunType },
    ) => Promise<void>;
  }): Promise<void> {
    const issueId = params.normalized.issue!.id;
    const sessionId = params.normalized.agentSession!.id;

    if (params.activeRun?.threadId && params.activeRun.turnId) {
      try {
        await this.codex.steerTurn({
          threadId: params.activeRun.threadId,
          turnId: params.activeRun.turnId,
          input: "STOP: The user has requested you stop working immediately. Do not make further changes. Wrap up and exit.",
        });
      } catch (error) {
        this.logger.warn({ issueKey: params.trackedIssue?.issueKey, error: error instanceof Error ? error.message : String(error) }, "Failed to steer Codex turn for stop signal");
      }

      this.db.runs.finishRun(params.activeRun.id, { status: "released", threadId: params.activeRun.threadId, turnId: params.activeRun.turnId });
    }

    this.db.issueSessions.upsertIssueRespectingActiveLease(params.project.id, issueId, {
      projectId: params.project.id,
      linearIssueId: issueId,
      activeRunId: null,
      factoryState: "awaiting_input",
      agentSessionId: sessionId,
    });
    this.db.issueSessions.appendIssueSessionEvent({
      projectId: params.project.id,
      linearIssueId: issueId,
      eventType: "stop_requested",
      dedupeKey: `stop_requested:${issueId}`,
    });
    this.db.issueSessions.clearPendingIssueSessionEventsRespectingActiveLease(params.project.id, issueId);
    this.db.issueSessions.releaseIssueSessionLeaseRespectingActiveLease(params.project.id, issueId);

    this.feed?.publish({
      level: "info",
      kind: "agent",
      projectId: params.project.id,
      issueKey: params.trackedIssue?.issueKey,
      status: "stopped",
      summary: "Stop signal received - work halted",
    });

    const updatedIssue = this.db.getIssue(params.project.id, issueId);
    await this.publishAgentActivity(params.linear, sessionId, buildStopConfirmationActivity());
    await params.syncAgentSession(sessionId, updatedIssue ?? params.trackedIssue);
  }

  private async publishAgentActivity(
    linear: LinearClient,
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
    linear: LinearClient,
    agentSessionId: string,
    issue: TrackedIssueRecord | ReturnType<PatchRelayDatabase["getIssue"]> | undefined,
    peekPendingSessionWakeRunType: (projectId: string, issueId: string) => RunType | undefined,
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
                  pendingRunType: options?.pendingRunType ?? peekPendingSessionWakeRunType(
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
}
