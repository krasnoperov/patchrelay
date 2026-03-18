import type { Logger } from "pino";
import type { CodexAppServerClient, CodexNotification } from "./codex-app-server.ts";
import type { PatchRelayDatabase } from "./db.ts";
import type {
  EventReceiptStoreProvider,
  IssueControlStoreProvider,
  IssueSessionStoreProvider,
  ObligationStoreProvider,
  RunLeaseStoreProvider,
  WorkspaceOwnershipStoreProvider,
} from "./ledger-ports.ts";
import type { LinearInstallationStoreProvider } from "./installation-ports.ts";
import type { StageEventLogStoreProvider } from "./stage-event-ports.ts";
import type { IssueWorkflowCoordinatorProvider, IssueWorkflowQueryStoreProvider, ReadyIssueSource } from "./workflow-ports.ts";
import type { WebhookEventStoreProvider } from "./webhook-event-ports.ts";
import { IssueQueryService } from "./issue-query-service.ts";
import { LinearOAuthService } from "./linear-oauth-service.ts";
import { OperatorEventFeed, type OperatorFeedQuery } from "./operator-feed.ts";
import {
  buildSessionStatusUrl,
  createSessionStatusToken,
  deriveSessionStatusSigningSecret,
  verifySessionStatusToken,
} from "./public-agent-session-status.ts";
import { ServiceRuntime } from "./service-runtime.ts";
import { ServiceStageFinalizer } from "./service-stage-finalizer.ts";
import { type IssueQueueItem, ServiceStageRunner } from "./service-stage-runner.ts";
import { ServiceWebhookProcessor } from "./service-webhook-processor.ts";
import { acceptIncomingWebhook } from "./service-webhooks.ts";
import type { AppConfig, LinearClient, LinearClientProvider } from "./types.ts";

type ServiceStores = WebhookEventStoreProvider &
  EventReceiptStoreProvider &
  IssueControlStoreProvider &
  IssueSessionStoreProvider &
  WorkspaceOwnershipStoreProvider &
  RunLeaseStoreProvider &
  ObligationStoreProvider &
  IssueWorkflowCoordinatorProvider &
  IssueWorkflowQueryStoreProvider &
  StageEventLogStoreProvider &
  LinearInstallationStoreProvider;

function createServiceStores(db: PatchRelayDatabase): ServiceStores {
  return {
    webhookEvents: db.webhookEvents,
    eventReceipts: db.eventReceipts,
    issueControl: db.issueControl,
    issueSessions: db.issueSessions,
    workspaceOwnership: db.workspaceOwnership,
    runLeases: db.runLeases,
    obligations: db.obligations,
    workflowCoordinator: db.workflowCoordinator,
    issueWorkflows: db.issueWorkflows,
    stageEvents: db.stageEvents,
    linearInstallations: db.linearInstallations,
  };
}

function createReadyIssueSource(stores: ServiceStores): ReadyIssueSource {
  return {
    listIssuesReadyForExecution: () =>
      stores.issueControl.listIssueControlsReadyForLaunch().map((issue) => ({
        projectId: issue.projectId,
        linearIssueId: issue.linearIssueId,
      })),
  };
}

// PatchRelayService wires together the harness layers:
// - integration: webhook intake, OAuth, Linear client access
// - coordination: runtime queueing, stage launch, completion, reconciliation
// - execution: Codex app-server and worktree-backed stage runs
// - observability: issue/report query surfaces
export class PatchRelayService {
  readonly linearProvider: LinearClientProvider;
  private readonly stageRunner: ServiceStageRunner;
  private readonly stageFinalizer: ServiceStageFinalizer;
  private readonly webhookProcessor: ServiceWebhookProcessor;
  private readonly oauthService: LinearOAuthService;
  private readonly queryService: IssueQueryService;
  private readonly runtime: ServiceRuntime;
  private readonly feed: OperatorEventFeed;

  constructor(
    readonly config: AppConfig,
    readonly db: PatchRelayDatabase,
    readonly codex: CodexAppServerClient,
    linearProvider: LinearClientProvider | LinearClient | undefined,
    readonly logger: Logger,
  ) {
    this.linearProvider = toLinearClientProvider(linearProvider);
    this.feed = new OperatorEventFeed(db.operatorFeed);
    const stores = createServiceStores(db);
    this.stageRunner = new ServiceStageRunner(
      config,
      stores,
      codex,
      this.linearProvider,
      logger,
      (fn) => db.connection.transaction(fn)(),
      this.feed,
    );
    let enqueueIssue: (projectId: string, issueId: string) => void = () => {
      throw new Error("Service runtime enqueueIssue is not initialized");
    };

    this.stageFinalizer = new ServiceStageFinalizer(
      config,
      stores,
      codex,
      this.linearProvider,
      (projectId, issueId) => enqueueIssue(projectId, issueId),
      logger,
      this.feed,
      (fn) => db.connection.transaction(fn)(),
    );
    this.webhookProcessor = new ServiceWebhookProcessor(
      config,
      stores,
      this.linearProvider,
      codex,
      (projectId, issueId) => enqueueIssue(projectId, issueId),
      logger,
      this.feed,
    );
    const runtime = new ServiceRuntime(
      codex,
      logger,
      this.stageFinalizer,
      createReadyIssueSource(stores),
      this.webhookProcessor,
      {
        processIssue: (item) => this.stageRunner.run(item),
      },
    );
    enqueueIssue = (projectId, issueId) => runtime.enqueueIssue(projectId, issueId);
    this.oauthService = new LinearOAuthService(config, stores, logger);
    this.queryService = new IssueQueryService(stores, codex, this.stageFinalizer);
    this.runtime = runtime;

    this.codex.on("notification", (notification: CodexNotification) => {
      void this.stageFinalizer.handleCodexNotification(notification);
    });
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

  listOperatorFeed(options?: OperatorFeedQuery) {
    return this.feed.list(options);
  }

  subscribeOperatorFeed(listener: Parameters<OperatorEventFeed["subscribe"]>[0]) {
    return this.feed.subscribe(listener);
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
      stores: {
        webhookEvents: this.db.webhookEvents,
        eventReceipts: this.db.eventReceipts,
      },
      logger: this.logger,
      webhookId: params.webhookId,
      headers: params.headers,
      rawBody: params.rawBody,
    });
    if (result.accepted) {
      this.runtime.enqueueWebhookEvent(result.accepted.id, {
        priority: result.accepted.normalized.triggerEvent === "agentSessionCreated",
      });
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

  createPublicAgentSessionStatusLink(
    issueKey: string,
    options?: { nowMs?: number; ttlSeconds?: number },
  ): { url: string; issueKey: string; expiresAt: string } | undefined {
    if (!this.config.server.publicBaseUrl) {
      return undefined;
    }

    const signingSecret = deriveSessionStatusSigningSecret(this.config.linear.tokenEncryptionKey);
    const token = createSessionStatusToken({
      issueKey,
      secret: signingSecret,
      ...(options?.nowMs !== undefined ? { nowMs: options.nowMs } : {}),
      ...(options?.ttlSeconds !== undefined ? { ttlSeconds: options.ttlSeconds } : {}),
    });
    return {
      url: buildSessionStatusUrl({
        publicBaseUrl: this.config.server.publicBaseUrl,
        issueKey,
        token: token.token,
      }),
      issueKey: token.issueKey,
      expiresAt: token.expiresAt,
    };
  }

  async getPublicAgentSessionStatus(params: {
    issueKey: string;
    token: string;
    nowMs?: number;
  }): Promise<
    | { status: "invalid_token" }
    | { status: "issue_not_found" }
    | {
        status: "ok";
        issueKey: string;
        expiresAt: string;
        sessionStatus: NonNullable<Awaited<ReturnType<IssueQueryService["getPublicAgentSessionStatus"]>>>;
      }
  > {
    const signingSecret = deriveSessionStatusSigningSecret(this.config.linear.tokenEncryptionKey);
    const parsed = verifySessionStatusToken(params.token, signingSecret, params.nowMs);
    if (!parsed || parsed.issueKey.trim().toLowerCase() !== params.issueKey.trim().toLowerCase()) {
      return { status: "invalid_token" };
    }

    const sessionStatus = await this.queryService.getPublicAgentSessionStatus(params.issueKey);
    if (!sessionStatus) {
      return { status: "issue_not_found" };
    }

    return {
      status: "ok",
      issueKey: params.issueKey,
      expiresAt: parsed.expiresAt,
      sessionStatus,
    };
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
