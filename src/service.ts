import path from "node:path";
import type { Logger } from "pino";
import { CodexAppServerClient, type CodexNotification } from "./codex-app-server.js";
import { PatchRelayDatabase } from "./db.js";
import { isPatchRelayStatusComment } from "./linear-workflow.js";
import { createLinearOAuthUrl, createOAuthStateToken, installLinearOAuthCode } from "./linear-oauth.js";
import { resolveProject, triggerEventAllowed } from "./project-resolution.js";
import { SerialWorkQueue } from "./service-queue.js";
import { ServiceStageFinalizer } from "./service-stage-finalizer.js";
import { type IssueQueueItem, ServiceStageRunner } from "./service-stage-runner.js";
import { acceptIncomingWebhook } from "./service-webhooks.js";
import { summarizeCurrentThread } from "./stage-reporting.js";
import type {
  AppConfig,
  LinearClient,
  LinearInstallationRecord,
  LinearClientProvider,
  LinearWebhookPayload,
  NormalizedEvent,
  StageReport,
  StageRunRecord,
  TrackedIssueRecord,
} from "./types.js";
import { safeJsonParse } from "./utils.js";
import { normalizeWebhook } from "./webhooks.js";
import { resolveWorkflowStage } from "./workflow-policy.js";

const ISSUE_KEY_DELIMITER = "::";

function makeIssueQueueKey(item: IssueQueueItem): string {
  return `${item.projectId}${ISSUE_KEY_DELIMITER}${item.issueId}`;
}

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

  createLinearOAuthStart(params?: { projectId?: string }): { state: string; authorizeUrl: string; redirectUri: string } {
    if (!this.config.linear.oauth) {
      throw new Error("Linear OAuth is not configured");
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
    };
  }

  async completeLinearOAuth(params: { state: string; code: string }): Promise<LinearInstallationRecord> {
    const oauthState = this.db.getOAuthState(params.state);
    if (!oauthState || oauthState.consumedAt) {
      throw new Error("OAuth state was not found or has already been consumed");
    }

    const installation = await installLinearOAuthCode({
      config: this.config,
      db: this.db,
      logger: this.logger,
      code: params.code,
      redirectUri: oauthState.redirectUri,
      ...(oauthState.projectId ? { projectId: oauthState.projectId } : {}),
    });
    this.db.consumeOAuthState(params.state);
    return installation;
  }

  listLinearInstallations(): Array<{
    installation: ReturnType<PatchRelayDatabase["getLinearInstallation"]>;
    linkedProjects: string[];
  }> {
    const links = this.db.listProjectInstallations();
    return this.db.listLinearInstallations().map((installation) => ({
      installation,
      linkedProjects: links
        .filter((link: { projectId: string; installationId: number }) => link.installationId === installation.id)
        .map((link: { projectId: string; installationId: number }) => link.projectId),
    }));
  }

  linkProjectInstallation(projectId: string, installationId: number) {
    const project = this.config.projects.find((entry) => entry.id === projectId);
    if (!project) {
      throw new Error(`Unknown project: ${projectId}`);
    }
    const installation = this.db.getLinearInstallation(installationId);
    if (!installation) {
      throw new Error(`Unknown installation: ${installationId}`);
    }
    return this.db.linkProjectInstallation(projectId, installationId);
  }

  unlinkProjectInstallation(projectId: string) {
    const project = this.config.projects.find((entry) => entry.id === projectId);
    if (!project) {
      throw new Error(`Unknown project: ${projectId}`);
    }
    this.db.unlinkProjectInstallation(projectId);
    return undefined;
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
    const project = resolveProject(this.config, normalized.issue);
    if (!project) {
      this.db.markWebhookProcessed(webhookEventId, "processed");
      return;
    }

    this.db.assignWebhookProject(webhookEventId, project.id);
    const desiredStage = triggerEventAllowed(project, normalized.triggerEvent)
      ? resolveWorkflowStage(project, normalized.issue.stateName)
      : undefined;

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

    await this.handleCommentWebhook(normalized, project.id);

    this.db.markWebhookProcessed(webhookEventId, "processed");
    if (desiredStage) {
      this.enqueueIssue(project.id, normalized.issue.id);
    }
  }

  private async handleCommentWebhook(normalized: NormalizedEvent, projectId: string): Promise<void> {
    if ((normalized.triggerEvent !== "commentCreated" && normalized.triggerEvent !== "commentUpdated") || !normalized.comment?.body) {
      return;
    }

    const issue = this.db.getTrackedIssue(projectId, normalized.issue.id);
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
