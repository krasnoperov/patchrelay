import type { Logger } from "pino";
import type { CodexAppServerClient, CodexNotification } from "./codex-app-server.ts";
import type { PatchRelayDatabase } from "./db.ts";
import type { ActiveStageRunReconciler, ReadyIssueSource } from "./db-ports.ts";
import { IssueQueryService } from "./issue-query-service.ts";
import { LinearOAuthService } from "./linear-oauth-service.ts";
import { ServiceRuntime } from "./service-runtime.ts";
import { ServiceStageFinalizer } from "./service-stage-finalizer.ts";
import { type IssueQueueItem, ServiceStageRunner } from "./service-stage-runner.ts";
import { ServiceWebhookProcessor } from "./service-webhook-processor.ts";
import { acceptIncomingWebhook } from "./service-webhooks.ts";
import type { AppConfig, LinearClient, LinearClientProvider } from "./types.ts";

export class PatchRelayService {
  readonly linearProvider: LinearClientProvider;
  private readonly stageRunner: ServiceStageRunner;
  private readonly stageFinalizer: ServiceStageFinalizer;
  private readonly webhookProcessor: ServiceWebhookProcessor;
  private readonly oauthService: LinearOAuthService;
  private readonly queryService: IssueQueryService;
  private readonly runtime: ServiceRuntime;

  constructor(
    readonly config: AppConfig,
    readonly db: PatchRelayDatabase,
    readonly codex: CodexAppServerClient,
    linearProvider: LinearClientProvider | LinearClient | undefined,
    readonly logger: Logger,
  ) {
    this.linearProvider = toLinearClientProvider(linearProvider);
    const stores = {
      webhookEvents: db.webhookEvents,
      issueWorkflows: db.issueWorkflows,
      stageEvents: db.stageEvents,
      linearInstallations: db.linearInstallations,
    };
    this.stageRunner = new ServiceStageRunner(config, stores, codex, this.linearProvider, logger);

    const runtime = new ServiceRuntime(
      codex,
      logger,
      this.stageFinalizerProxy(),
      stores.issueWorkflows as ReadyIssueSource,
      this.webhookProcessorProxy(),
      this.issueProcessorProxy(),
    );
    this.stageFinalizer = new ServiceStageFinalizer(
      config,
      stores,
      codex,
      this.linearProvider,
      (projectId, issueId) => runtime.enqueueIssue(projectId, issueId),
      logger,
    );
    this.webhookProcessor = new ServiceWebhookProcessor(
      config,
      stores,
      this.linearProvider,
      codex,
      (projectId, issueId) => runtime.enqueueIssue(projectId, issueId),
      logger,
    );
    this.oauthService = new LinearOAuthService(config, stores, logger);
    this.queryService = new IssueQueryService(stores, codex, this.stageFinalizer);
    this.runtime = runtime;

    this.codex.on("notification", (notification: CodexNotification) => {
      void this.stageFinalizer.handleCodexNotification(notification);
    });
  }

  private stageFinalizerProxy(): ActiveStageRunReconciler {
    return {
      reconcileActiveStageRuns: () => this.stageFinalizer.reconcileActiveStageRuns(),
    };
  }

  private webhookProcessorProxy() {
    return {
      processWebhookEvent: (eventId: number) => this.processWebhookEvent(eventId),
    };
  }

  private issueProcessorProxy() {
    return {
      processIssue: (item: IssueQueueItem) => this.processIssue(item),
    };
  }

  async start(): Promise<void> {
    await this.runtime.start();
  }

  stop(): void {
    this.runtime.stop();
  }

  createLinearOAuthStart(params?: { projectId?: string }) {
    return this.oauthService.createStart(params);
  }

  async completeLinearOAuth(params: { state: string; code: string }) {
    return await this.oauthService.complete(params);
  }

  getLinearOAuthStateStatus(state: string) {
    return this.oauthService.getStateStatus(state);
  }

  listLinearInstallations() {
    return this.oauthService.listInstallations();
  }

  getReadiness() {
    return this.runtime.getReadiness();
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
      stores: { webhookEvents: this.db.webhookEvents },
      logger: this.logger,
      webhookId: params.webhookId,
      headers: params.headers,
      rawBody: params.rawBody,
    });
    if (result.accepted) {
      this.runtime.enqueueWebhookEvent(result.accepted.id);
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
    return await this.queryService.getIssueOverview(issueKey);
  }

  async getIssueReport(issueKey: string) {
    return await this.queryService.getIssueReport(issueKey);
  }

  async getStageEvents(issueKey: string, stageRunId: number) {
    return await this.queryService.getStageEvents(issueKey, stageRunId);
  }

  async getActiveStageStatus(issueKey: string) {
    return await this.queryService.getActiveStageStatus(issueKey);
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
