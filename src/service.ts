import path from "node:path";
import type { Logger } from "pino";
import { CodexAppServerClient, type CodexNotification } from "./codex-app-server.ts";
import { PatchRelayDatabase } from "./db.ts";
import { isPatchRelayStatusComment } from "./linear-workflow.ts";
import { createLinearOAuthUrl, createOAuthStateToken, installLinearOAuthCode } from "./linear-oauth.ts";
import { resolveProject, triggerEventAllowed, trustedActorAllowed } from "./project-resolution.ts";
import { SerialWorkQueue } from "./service-queue.ts";
import { ServiceStageFinalizer } from "./service-stage-finalizer.ts";
import { type IssueQueueItem, ServiceStageRunner } from "./service-stage-runner.ts";
import { acceptIncomingWebhook } from "./service-webhooks.ts";
import { summarizeCurrentThread } from "./stage-reporting.ts";
import type {
  AppConfig,
  AgentSessionMetadata,
  LinearClient,
  LinearInstallationRecord,
  LinearClientProvider,
  LinearWebhookPayload,
  ProjectConfig,
  NormalizedEvent,
  StageReport,
  StageRunRecord,
  TrackedIssueRecord,
  WorkflowStage,
} from "./types.ts";
import { safeJsonParse } from "./utils.ts";
import { normalizeWebhook } from "./webhooks.ts";
import { resolveWorkflowStage } from "./workflow-policy.ts";

const ISSUE_KEY_DELIMITER = "::";
const LINEAR_OAUTH_STATE_TTL_MS = 15 * 60 * 1000;

function makeIssueQueueKey(item: IssueQueueItem): string {
  return `${item.projectId}${ISSUE_KEY_DELIMITER}${item.issueId}`;
}

function oauthStateExpired(createdAt: string): boolean {
  const createdAtMs = Date.parse(createdAt);
  return !Number.isFinite(createdAtMs) || createdAtMs + LINEAR_OAUTH_STATE_TTL_MS < Date.now();
}

function trimPrompt(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

type LinearInstallationSummary = ReturnType<PatchRelayService["getLinearInstallationSummary"]>;

type LinearOAuthStartResult =
  | { state: string; authorizeUrl: string; redirectUri: string; projectId?: string }
  | {
      completed: true;
      reusedExisting: true;
      projectId: string;
      installation: LinearInstallationSummary;
    };

export class PatchRelayService {
  readonly webhookQueue: SerialWorkQueue<number>;
  readonly issueQueue: SerialWorkQueue<IssueQueueItem>;
  readonly linearProvider: LinearClientProvider;
  private readonly stageRunner: ServiceStageRunner;
  private readonly stageFinalizer: ServiceStageFinalizer;
  private ready = false;
  private startupError: string | undefined;

  constructor(
    readonly config: AppConfig,
    readonly db: PatchRelayDatabase,
    readonly codex: CodexAppServerClient,
    linearProvider: LinearClientProvider | LinearClient | undefined,
    readonly logger: Logger,
  ) {
    this.linearProvider = toLinearClientProvider(linearProvider);
    this.stageRunner = new ServiceStageRunner(config, db, codex, this.linearProvider, logger);
    this.stageFinalizer = new ServiceStageFinalizer(config, db, codex, this.linearProvider, (projectId, issueId) =>
      this.enqueueIssue(projectId, issueId),
    );
    this.webhookQueue = new SerialWorkQueue((eventId) => this.processWebhookEvent(eventId), logger, (eventId) => String(eventId));
    this.issueQueue = new SerialWorkQueue((item) => this.processIssue(item), logger, makeIssueQueueKey);
    this.codex.on("notification", (notification: CodexNotification) => {
      void this.stageFinalizer.handleCodexNotification(notification);
    });
  }

  async start(): Promise<void> {
    try {
      await this.codex.start();
      await this.stageFinalizer.reconcileActiveStageRuns();
      for (const issue of this.db.listIssuesReadyForExecution()) {
        this.enqueueIssue(issue.projectId, issue.linearIssueId);
      }
      this.ready = true;
      this.startupError = undefined;
    } catch (error) {
      this.ready = false;
      this.startupError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  stop(): void {
    this.ready = false;
    void this.codex.stop();
  }

  createLinearOAuthStart(params?: { projectId?: string }): LinearOAuthStartResult {
    if (params?.projectId && !this.config.projects.some((project) => project.id === params.projectId)) {
      throw new Error(`Unknown project: ${params.projectId}`);
    }

    if (params?.projectId) {
      const existingLink = this.db.getProjectInstallation(params.projectId);
      if (existingLink) {
        const installation = this.db.getLinearInstallation(existingLink.installationId);
        if (installation) {
          return {
            completed: true,
            reusedExisting: true,
            projectId: params.projectId,
            installation: this.getLinearInstallationSummary(installation),
          };
        }
      }

      const installations = this.db.listLinearInstallations();
      if (installations.length === 1) {
        const installation = installations[0];
        if (installation) {
          this.db.linkProjectInstallation(params.projectId, installation.id);
          return {
            completed: true,
            reusedExisting: true,
            projectId: params.projectId,
            installation: this.getLinearInstallationSummary(installation),
          };
        }
      }
    }

    const state = createOAuthStateToken();
    const record = this.db.createOAuthState({
      provider: "linear",
      state,
      redirectUri: this.config.linear.oauth.redirectUri,
      actor: this.config.linear.oauth.actor,
      ...(params?.projectId ? { projectId: params.projectId } : {}),
    });
    return {
      state,
      authorizeUrl: createLinearOAuthUrl(this.config, record.state, record.redirectUri, record.projectId),
      redirectUri: record.redirectUri,
      ...(record.projectId ? { projectId: record.projectId } : {}),
    };
  }

  async completeLinearOAuth(params: { state: string; code: string }): Promise<LinearInstallationRecord> {
    const oauthState = this.db.getOAuthState(params.state);
    if (!oauthState || oauthState.consumedAt) {
      throw new Error("OAuth state was not found or has already been consumed");
    }
    if (oauthStateExpired(oauthState.createdAt)) {
      this.db.finalizeOAuthState({
        state: params.state,
        status: "failed",
        errorMessage: "OAuth state expired",
      });
      throw new Error("OAuth state has expired. Start the connection flow again.");
    }

    try {
      const installation = await installLinearOAuthCode({
        config: this.config,
        db: this.db,
        logger: this.logger,
        code: params.code,
        redirectUri: oauthState.redirectUri,
        ...(oauthState.projectId ? { projectId: oauthState.projectId } : {}),
      });
      this.db.finalizeOAuthState({
        state: params.state,
        status: "completed",
        installationId: installation.id,
      });
      return installation;
    } catch (error) {
      this.db.finalizeOAuthState({
        state: params.state,
        status: "failed",
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  getLinearOAuthStateStatus(state: string):
    | {
        state: string;
        status: "pending" | "completed" | "failed";
        projectId?: string;
        installation?: LinearInstallationSummary;
        errorMessage?: string;
      }
    | undefined {
    const oauthState = this.db.getOAuthState(state);
    if (!oauthState) {
      return undefined;
    }

    const installation =
      oauthState.installationId !== undefined ? this.db.getLinearInstallation(oauthState.installationId) : undefined;
    return {
      state: oauthState.state,
      status: oauthState.status,
      ...(oauthState.projectId ? { projectId: oauthState.projectId } : {}),
      ...(installation ? { installation: this.getLinearInstallationSummary(installation) } : {}),
      ...(oauthState.errorMessage ? { errorMessage: oauthState.errorMessage } : {}),
    };
  }

  listLinearInstallations(): Array<{
    installation: LinearInstallationSummary;
    linkedProjects: string[];
  }> {
    const links = this.db.listProjectInstallations();
    return this.db.listLinearInstallations().map((installation) => ({
      installation: this.getLinearInstallationSummary(installation),
      linkedProjects: links
        .filter((link: { projectId: string; installationId: number }) => link.installationId === installation.id)
        .map((link: { projectId: string; installationId: number }) => link.projectId),
    }));
  }

  private getLinearInstallationSummary(installation: LinearInstallationRecord) {
    return {
      id: installation.id,
      ...(installation.workspaceName ? { workspaceName: installation.workspaceName } : {}),
      ...(installation.workspaceKey ? { workspaceKey: installation.workspaceKey } : {}),
      ...(installation.actorName ? { actorName: installation.actorName } : {}),
      ...(installation.actorId ? { actorId: installation.actorId } : {}),
      ...(installation.expiresAt ? { expiresAt: installation.expiresAt } : {}),
    };
  }

  getReadiness() {
    return {
      ready: this.ready && this.codex.isStarted(),
      codexStarted: this.codex.isStarted(),
      ...(this.startupError ? { startupError: this.startupError } : {}),
    };
  }

  async acceptWebhook(params: {
    webhookId: string;
    headers: Record<string, string | string[] | undefined>;
    rawBody: Buffer;
  }): Promise<{
    status: number;
    body: Record<string, string | number | boolean>;
  }> {
    const result = await acceptIncomingWebhook({
      config: this.config,
      db: this.db,
      logger: this.logger,
      webhookId: params.webhookId,
      headers: params.headers,
      rawBody: params.rawBody,
    });
    if (result.accepted) {
      this.webhookQueue.enqueue(result.accepted.id);
    }
    return {
      status: result.status,
      body: result.body,
    };
  }

  async processWebhookEvent(webhookEventId: number): Promise<void> {
    const event = this.db.getWebhookEvent(webhookEventId);
    if (!event) {
      return;
    }

    const payload = safeJsonParse<LinearWebhookPayload>(event.payloadJson);
    if (!payload) {
      this.db.markWebhookProcessed(webhookEventId, "failed");
      throw new Error(`Stored webhook payload is invalid JSON: event ${webhookEventId}`);
    }

    const normalized = normalizeWebhook({
      webhookId: event.webhookId,
      payload,
    });
    if (!normalized.issue) {
      this.handleInstallationWebhook(normalized);
      this.db.markWebhookProcessed(webhookEventId, "processed");
      return;
    }

    const project = resolveProject(this.config, normalized.issue);
    if (!project) {
      this.db.markWebhookProcessed(webhookEventId, "processed");
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
      this.db.markWebhookProcessed(webhookEventId, "processed");
      return;
    }

    this.db.assignWebhookProject(webhookEventId, project.id);

    const issue = this.db.getTrackedIssue(project.id, normalized.issue.id);
    const activeStageRun = issue?.activeStageRunId ? this.db.getStageRun(issue.activeStageRunId) : undefined;
    const desiredStage = this.resolveDesiredStage(project, normalized, issue, activeStageRun);
    const launchInput = this.resolveLaunchInput(normalized.agentSession);

    this.db.recordDesiredStage({
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
      this.db.setIssueActiveAgentSession(project.id, normalized.issue.id, normalized.agentSession.id);
    }
    if (launchInput && !activeStageRun) {
      this.db.setIssuePendingLaunchInput(project.id, normalized.issue.id, launchInput);
    }

    await this.handleAgentSessionWebhook(normalized, project, issue ?? this.db.getTrackedIssue(project.id, normalized.issue.id), desiredStage);

    await this.handleCommentWebhook(normalized, project.id);

    this.db.markWebhookProcessed(webhookEventId, "processed");
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
    let desiredStage: WorkflowStage | undefined;

    if (normalized.triggerEvent === "delegateChanged") {
      desiredStage = this.resolveDelegateStage(project, normalized);
      if (!desiredStage) {
        return undefined;
      }
      if (!stageAllowed && !project.triggerEvents.includes("statusChanged")) {
        return undefined;
      }
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

  private resolveDelegateStage(project: ProjectConfig, normalized: NormalizedEvent): WorkflowStage | undefined {
    const normalizedIssue = normalized.issue;
    if (!normalizedIssue) {
      return undefined;
    }

    const installation = this.db.getLinearInstallationForProject(project.id);
    if (!installation?.actorId) {
      return undefined;
    }
    if (normalizedIssue.delegateId !== installation.actorId) {
      return undefined;
    }
    return resolveWorkflowStage(project, normalizedIssue.stateName);
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

    const linear = await this.linearProvider.forProject(project.id);
    if (!linear) {
      return;
    }

    const promptBody = trimPrompt(normalized.agentSession.promptBody);
    const promptContext = trimPrompt(normalized.agentSession.promptContext);
    const activeStageRun = issue?.activeStageRunId ? this.db.getStageRun(issue.activeStageRunId) : undefined;

    if (normalized.triggerEvent === "agentSessionCreated") {
      if (!desiredStage && !activeStageRun) {
        await this.safeCreateAgentActivity(linear, normalized.agentSession.id, {
          type: "elicitation",
          body: "PatchRelay is delegated, but the issue is not in a runnable workflow state. Move it to Start, Review, or Deploy and try again.",
        });
        return;
      }

      if (desiredStage) {
        await this.safeCreateAgentActivity(linear, normalized.agentSession.id, {
          type: "thought",
          body: `PatchRelay received the delegation and is preparing the ${desiredStage} workflow.`,
        });
        return;
      }

      if (activeStageRun) {
        await this.safeCreateAgentActivity(linear, normalized.agentSession.id, {
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
      this.db.enqueueTurnInput({
        stageRunId: activeStageRun.id,
        ...(activeStageRun.threadId ? { threadId: activeStageRun.threadId } : {}),
        ...(activeStageRun.turnId ? { turnId: activeStageRun.turnId } : {}),
        source: `linear-agent-prompt:${normalized.agentSession.id}:${normalized.webhookId}`,
        body: ["New Linear agent prompt received while you are working.", "", promptBody].join("\n"),
      });
      await this.stageFinalizer.flushQueuedTurnInputs(activeStageRun);
      await this.safeCreateAgentActivity(linear, normalized.agentSession.id, {
        type: "thought",
        body: `PatchRelay routed your follow-up instructions into the active ${activeStageRun.stage} workflow.`,
      });
      return;
    }

    if (!activeStageRun && desiredStage) {
      await this.safeCreateAgentActivity(linear, normalized.agentSession.id, {
        type: "thought",
        body: `PatchRelay received your prompt and is preparing the ${desiredStage} workflow.`,
      });
      return;
    }

    if (!activeStageRun && !desiredStage && (promptBody || promptContext)) {
      await this.safeCreateAgentActivity(linear, normalized.agentSession.id, {
        type: "elicitation",
        body: "PatchRelay received your prompt, but the issue is not in a runnable workflow state yet. Move it to Start, Review, or Deploy first.",
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

    const issue = this.db.getTrackedIssue(projectId, normalizedIssue.id);
    if (!issue?.activeStageRunId) {
      return;
    }

    if (isPatchRelayStatusComment(normalized.comment.id, normalized.comment.body, issue.statusCommentId)) {
      return;
    }

    const stageRun = this.db.getStageRun(issue.activeStageRunId);
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

    this.db.enqueueTurnInput({
      stageRunId: stageRun.id,
      ...(stageRun.threadId ? { threadId: stageRun.threadId } : {}),
      ...(stageRun.turnId ? { turnId: stageRun.turnId } : {}),
      source: `linear-comment:${normalized.comment.id}`,
      body,
    });
    await this.stageFinalizer.flushQueuedTurnInputs(stageRun);
  }

  private handleInstallationWebhook(normalized: NormalizedEvent): void {
    if (!normalized.installation) {
      return;
    }

    if (normalized.triggerEvent === "installationPermissionsChanged") {
      const matchingInstallations = normalized.installation.appUserId
        ? this.db.listLinearInstallations().filter((installation) => installation.actorId === normalized.installation?.appUserId)
        : [];
      const links = this.db.listProjectInstallations();
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
        "Linear OAuth app installation was revoked; reconnect affected projects with `patchrelay connect --project <id>`",
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

  private async safeCreateAgentActivity(
    linear: LinearClient,
    agentSessionId: string,
    content:
      | { type: "thought" | "elicitation" | "response" | "error"; body: string }
      | { type: "action"; action: string; parameter: string; result?: string },
  ): Promise<void> {
    try {
      await linear.createAgentActivity({
        agentSessionId,
        content,
        ephemeral: content.type === "thought" || content.type === "action",
      });
    } catch (error) {
      this.logger.warn(
        {
          agentSessionId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to publish Linear agent activity",
      );
    }
  }

  async processIssue(item: IssueQueueItem): Promise<void> {
    await this.stageRunner.run(item);
  }

  async getIssueOverview(issueKey: string) {
    const result = this.db.getIssueOverview(issueKey);
    if (!result) {
      return undefined;
    }

    const latestStageRun = this.db.getLatestStageRunForIssue(result.issue.projectId, result.issue.linearIssueId);
    let liveThread;
    if (result.activeStageRun?.threadId) {
      liveThread = await this.codex.readThread(result.activeStageRun.threadId, true).catch(() => undefined);
    }

    return {
      ...result,
      ...(latestStageRun ? { latestStageRun } : {}),
      ...(liveThread ? { liveThread: summarizeCurrentThread(liveThread) } : {}),
    };
  }

  async getIssueReport(issueKey: string): Promise<
    | {
        issue: TrackedIssueRecord;
        stages: Array<{
          stageRun: StageRunRecord;
          report?: StageReport;
        }>;
      }
    | undefined
  > {
    const issue = this.db.getTrackedIssueByKey(issueKey);
    if (!issue) {
      return undefined;
    }

    return {
      issue,
      stages: this.db.listStageRunsForIssue(issue.projectId, issue.linearIssueId).map((stageRun) => ({
        stageRun,
        ...(stageRun.reportJson ? { report: JSON.parse(stageRun.reportJson) as StageReport } : {}),
      })),
    };
  }

  async getStageEvents(issueKey: string, stageRunId: number) {
    const issue = this.db.getTrackedIssueByKey(issueKey);
    if (!issue) {
      return undefined;
    }

    const stageRun = this.db.getStageRun(stageRunId);
    if (!stageRun || stageRun.projectId !== issue.projectId || stageRun.linearIssueId !== issue.linearIssueId) {
      return undefined;
    }

    return {
      issue,
      stageRun,
      events: this.db.listThreadEvents(stageRunId).map((event) => ({
        ...event,
        parsedEvent: safeJsonParse<Record<string, unknown>>(event.eventJson),
      })),
    };
  }

  async getActiveStageStatus(issueKey: string) {
    return await this.stageFinalizer.getActiveStageStatus(issueKey);
  }

  private enqueueIssue(projectId: string, issueId: string): void {
    this.issueQueue.enqueue({ projectId, issueId });
  }
}

function toLinearClientProvider(linear: LinearClientProvider | LinearClient | undefined): LinearClientProvider {
  if (linear && typeof (linear as LinearClientProvider).forProject === "function") {
    return linear as LinearClientProvider;
  }

  return {
    async forProject(): Promise<LinearClient | undefined> {
      return linear as LinearClient | undefined;
    },
  };
}
