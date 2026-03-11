import type { Logger } from "pino";
import type { CodexAppServerClient, CodexNotification } from "./codex-app-server.ts";
import type { PatchRelayDatabase } from "./db.ts";
import { createLinearOAuthUrl, createOAuthStateToken, installLinearOAuthCode } from "./linear-oauth.ts";
import { SerialWorkQueue } from "./service-queue.ts";
import { ServiceStageFinalizer } from "./service-stage-finalizer.ts";
import { type IssueQueueItem, ServiceStageRunner } from "./service-stage-runner.ts";
import { ServiceWebhookProcessor } from "./service-webhook-processor.ts";
import { acceptIncomingWebhook } from "./service-webhooks.ts";
import { summarizeCurrentThread } from "./stage-reporting.ts";
import type {
  AppConfig,
  LinearClient,
  LinearInstallationRecord,
  LinearClientProvider,
  StageReport,
  StageRunRecord,
  TrackedIssueRecord,
} from "./types.ts";
import { safeJsonParse } from "./utils.ts";

const ISSUE_KEY_DELIMITER = "::";
const LINEAR_OAUTH_STATE_TTL_MS = 15 * 60 * 1000;

function makeIssueQueueKey(item: IssueQueueItem): string {
  return `${item.projectId}${ISSUE_KEY_DELIMITER}${item.issueId}`;
}

function oauthStateExpired(createdAt: string): boolean {
  const createdAtMs = Date.parse(createdAt);
  return !Number.isFinite(createdAtMs) || createdAtMs + LINEAR_OAUTH_STATE_TTL_MS < Date.now();
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
  private readonly webhookProcessor: ServiceWebhookProcessor;
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
    this.webhookProcessor = new ServiceWebhookProcessor(
      config,
      db,
      this.linearProvider,
      this.stageFinalizer,
      (projectId, issueId) => this.enqueueIssue(projectId, issueId),
      logger,
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
    await this.webhookProcessor.processWebhookEvent(webhookEventId);
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
