import type { Logger } from "pino";
import {
  buildAgentSessionPlan,
} from "../agent-session-plan.ts";
import { buildAgentSessionExternalUrls } from "../agent-session-presentation.ts";
import type { CodexAppServerClient } from "../codex-app-server.ts";
import type { AgentInputService } from "../agent-input-service.ts";
import type { PatchRelayDatabase } from "../db.ts";
import type { RunType } from "../run-type.ts";
import { deriveIssuePhase } from "../issue-phase.ts";
import {
  buildAlreadyRunningThought,
  buildAgentSessionAcknowledgementThought,
  buildBlockedDelegationActivity,
  buildDelegationThought,
  buildStopConfirmationActivity,
} from "../linear-session-reporting.ts";
import { dirtyWorktreeEventPayload, inspectGitWorktreeStatus } from "../git-worktree-status.ts";
import type { OperatorEventFeed } from "../operator-feed.ts";
import { resolveProject, triggerEventAllowed } from "../project-resolution.ts";
import type {
  AppConfig,
  LinearAgentActivityContent,
  LinearClientProvider,
  NormalizedEvent,
  ProjectConfig,
  TrackedIssueRecord,
} from "../types.ts";
import type { WorkflowTaskDispatcher } from "../workflow-task-dispatcher.ts";

type LinearClient = NonNullable<Awaited<ReturnType<LinearClientProvider["forProject"]>>>;

const WRITER = "agent-session-handler";

const PATCHRELAY_AGENT_ACTIVITY_TYPES = new Set([
  "action",
  "elicitation",
  "error",
  "response",
  "thought",
]);

export class AgentSessionHandler {
  constructor(
    private readonly config: AppConfig,
    private readonly db: PatchRelayDatabase,
    private readonly linearProvider: LinearClientProvider,
    private readonly codex: CodexAppServerClient,
    private readonly workflowTaskDispatcher: WorkflowTaskDispatcher,
    private readonly logger: Logger,
    private readonly feed?: OperatorEventFeed,
    private readonly agentInput?: AgentInputService,
  ) {}

  async acknowledgeCreated(normalized: NormalizedEvent): Promise<void> {
    if (normalized.triggerEvent !== "agentSessionCreated" || !normalized.agentSession?.id || !normalized.issue) {
      return;
    }

    const project = resolveProject(this.config, normalized.issue);
    if (!project || !triggerEventAllowed(project, normalized.triggerEvent)) {
      return;
    }

    const linear = await this.linearProvider.forProject(project.id);
    if (!linear?.createAgentActivity) {
      return;
    }

    try {
      await linear.createAgentActivity({
        agentSessionId: normalized.agentSession.id,
        content: buildAgentSessionAcknowledgementThought(),
        ephemeral: true,
      });
    } catch (error) {
      this.logger.warn(
        {
          agentSessionId: normalized.agentSession.id,
          issueKey: normalized.issue.identifier,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to acknowledge Linear agent session creation",
      );
    }
  }

  async handle(params: {
    normalized: NormalizedEvent;
    project: ProjectConfig;
    trackedIssue: TrackedIssueRecord | undefined;
    runnableTaskRunType: RunType | undefined;
    delegated: boolean;
    peekRunnableWorkflowTaskRunType: (projectId: string, issueId: string) => RunType | undefined;
    isDirectReplyToOutstandingQuestion: (issue: ReturnType<PatchRelayDatabase["getIssue"]>) => boolean;
  }): Promise<void> {
    const { normalized, project, trackedIssue, runnableTaskRunType, delegated } = params;
    if (!normalized.agentSession?.id || !normalized.issue) return;

    const linear = await this.linearProvider.forProject(project.id);
    if (!linear) return;

    const existingIssue = this.db.issues.getIssue(project.id, normalized.issue.id);
    const activeRun = existingIssue?.activeRunId ? this.db.runs.getRunById(existingIssue.activeRunId) : undefined;

    if (normalized.triggerEvent === "agentSessionCreated") {
      if (!delegated) {
        const latestIssue = this.db.issues.getIssue(project.id, normalized.issue.id);
        if (latestIssue ?? trackedIssue) {
          await this.syncAgentSession(linear, normalized.agentSession.id, latestIssue ?? trackedIssue, params.peekRunnableWorkflowTaskRunType);
        }
        return;
      }
      if (runnableTaskRunType) {
        const latestIssue = this.db.issues.getIssue(project.id, normalized.issue.id);
        await this.syncAgentSession(linear, normalized.agentSession.id, latestIssue ?? trackedIssue, params.peekRunnableWorkflowTaskRunType, { runnableTaskRunType: runnableTaskRunType });
        await this.publishAgentActivity(linear, normalized.agentSession.id, buildDelegationThought(runnableTaskRunType));
        return;
      }
      if (activeRun) {
        const latestIssue = this.db.issues.getIssue(project.id, normalized.issue.id);
        await this.syncAgentSession(linear, normalized.agentSession.id, latestIssue ?? trackedIssue, params.peekRunnableWorkflowTaskRunType, { activeRunType: activeRun.runType });
        await this.publishAgentActivity(linear, normalized.agentSession.id, buildAlreadyRunningThought(activeRun.runType));
        return;
      }
      if ((trackedIssue?.blockedByCount ?? 0) > 0) {
        const latestIssue = this.db.issues.getIssue(project.id, normalized.issue.id);
        await this.syncAgentSession(linear, normalized.agentSession.id, latestIssue ?? trackedIssue, params.peekRunnableWorkflowTaskRunType);
        await this.publishAgentActivity(linear, normalized.agentSession.id, buildBlockedDelegationActivity(trackedIssue?.blockedByKeys));
        return;
      }
      if (!trackedIssue?.blockedByCount) {
        // Re-read the freshest state: an agentSessionCreated webhook can race a
        // session change / run launch, so the once-read activeRun above may have
        // missed an in-flight run. Creation is no longer allowed to conclude
        // "no work queued"; that belongs to health/reconciliation after the
        // workflow task projection has settled.
        const latestIssue = this.db.issues.getIssue(project.id, normalized.issue.id);
        const freshActiveRun = latestIssue?.activeRunId ? this.db.runs.getRunById(latestIssue.activeRunId) : undefined;
        if (freshActiveRun) {
          await this.syncAgentSession(linear, normalized.agentSession.id, latestIssue ?? trackedIssue, params.peekRunnableWorkflowTaskRunType, { activeRunType: freshActiveRun.runType });
          await this.publishAgentActivity(linear, normalized.agentSession.id, buildAlreadyRunningThought(freshActiveRun.runType));
        } else if (latestIssue) {
          await this.syncAgentSession(linear, normalized.agentSession.id, latestIssue, params.peekRunnableWorkflowTaskRunType);
        }
      }
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
          this.syncAgentSession(linear, agentSessionId, issue, params.peekRunnableWorkflowTaskRunType, options),
      });
      return;
    }

    if (normalized.triggerEvent !== "agentPrompted") return;
    if (!triggerEventAllowed(project, normalized.triggerEvent)) return;
    if (isPatchRelayAgentActivityEcho(normalized.agentSession)) {
      this.feed?.publish({
        level: "info",
        kind: "agent",
        projectId: project.id,
        issueKey: trackedIssue?.issueKey,
        status: "ignored_echo",
        summary: `Ignored Linear agent activity echo (${normalized.agentSession.activityType})`,
      });
      return;
    }

    const promptBody = normalized.agentSession.promptBody?.trim();
    const directReply = promptBody && existingIssue ? params.isDirectReplyToOutstandingQuestion(existingIssue) : false;
    if (promptBody && existingIssue && this.agentInput) {
      const result = await this.agentInput.deliverAgentInput({
        project,
        issue: existingIssue,
        source: "linear_agent_session",
        body: promptBody,
        directReply,
        emitActivity: (content, options) => this.publishAgentActivity(linear, normalized.agentSession!.id, content, options),
        peekRunnableWorkflowTaskRunType: params.peekRunnableWorkflowTaskRunType,
      });
      const latestIssue = this.db.issues.getIssue(project.id, normalized.issue.id);
      const syncOptions = result.activeRunType
        ? { activeRunType: result.activeRunType }
        : result.queuedRunType ? { runnableTaskRunType: result.queuedRunType }
          : runnableTaskRunType ? { runnableTaskRunType: runnableTaskRunType }
            : undefined;
      await this.syncAgentSession(
        linear,
        normalized.agentSession.id,
        latestIssue ?? trackedIssue,
        params.peekRunnableWorkflowTaskRunType,
        syncOptions,
      );
      return;
    }

    if (runnableTaskRunType) {
      const latestIssue = this.db.issues.getIssue(project.id, normalized.issue.id);
      await this.syncAgentSession(linear, normalized.agentSession.id, latestIssue ?? trackedIssue, params.peekRunnableWorkflowTaskRunType, { runnableTaskRunType: runnableTaskRunType });
      await this.publishAgentActivity(linear, normalized.agentSession.id, buildDelegationThought(runnableTaskRunType, "prompt"), { ephemeral: true });
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
      options?: { activeRunType?: RunType; runnableTaskRunType?: RunType },
    ) => Promise<void>;
  }): Promise<void> {
    const issueId = params.normalized.issue!.id;
    const sessionId = params.normalized.agentSession!.id;
    const storedIssue = this.db.issues.getIssue(params.project.id, issueId);
    const worktreeStatus = storedIssue?.worktreePath
      ? inspectGitWorktreeStatus(storedIssue.worktreePath)
      : undefined;
    const dirtyPayload = worktreeStatus ? dirtyWorktreeEventPayload(worktreeStatus) : undefined;
    const dirtySummary = typeof dirtyPayload?.summary === "string" ? dirtyPayload.summary : undefined;

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
    }

    // The stop signal is a user fact: the issue slot clear and the run
    // release ride in one transaction, with the run gated on the issue commit.
    this.db.transaction(() => {
      const commit = this.db.issueSessions.commitIssueState({
        writer: WRITER,
        update: {
          projectId: params.project.id,
          linearIssueId: issueId,
          activeRunId: null,
          inputRequestKind: "paused_local_work",
          agentSessionId: sessionId,
        },
      });
      if (commit.outcome === "applied" && params.activeRun?.threadId && params.activeRun.turnId) {
        this.db.runs.finishRun(params.activeRun.id, {
          status: "released",
          threadId: params.activeRun.threadId,
          turnId: params.activeRun.turnId,
          failureReason: dirtySummary ? `Stop signal received; ${dirtySummary}` : "Stop signal received",
        });
      }
    });
    this.db.issueSessions.appendIssueSessionEvent({
      projectId: params.project.id,
      linearIssueId: issueId,
      eventType: "stop_requested",
      ...(dirtyPayload ? { eventJson: JSON.stringify(dirtyPayload) } : {}),
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
      summary: dirtySummary ? `Stop signal received - work halted with dirty worktree: ${dirtySummary}` : "Stop signal received - work halted",
    });

    const updatedIssue = this.db.issues.getIssue(params.project.id, issueId);
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
    peekRunnableWorkflowTaskRunType: (projectId: string, issueId: string) => RunType | undefined,
    options?: { activeRunType?: RunType; runnableTaskRunType?: RunType },
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
              plan: buildAgentSessionPlan(
                {
                  phase: "phase" in issue ? issue.phase : deriveIssuePhase(issue),
                  ciRepairAttempts: "ciRepairAttempts" in issue ? issue.ciRepairAttempts : 0,
                  queueRepairAttempts: "queueRepairAttempts" in issue ? issue.queueRepairAttempts : 0,
                  ...(() => {
                  const runnableTaskRunType = options?.runnableTaskRunType ?? peekRunnableWorkflowTaskRunType(
                    issue.projectId,
                    issue.linearIssueId,
                  );
                  return {
                    ...(options?.activeRunType ? { activeRunType: options.activeRunType } : {}),
                    ...(runnableTaskRunType ? { runnableTaskRunType } : {}),
                  };
                  })(),
                },
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

function isPatchRelayAgentActivityEcho(agentSession: NormalizedEvent["agentSession"]): boolean {
  const activityType = agentSession?.activityType?.trim().toLowerCase();
  return Boolean(activityType && PATCHRELAY_AGENT_ACTIVITY_TYPES.has(activityType));
}
