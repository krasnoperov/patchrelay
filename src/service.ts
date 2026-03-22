import type { Logger } from "pino";
import type { CodexAppServerClient, CodexNotification } from "./codex-app-server.ts";
import type { PatchRelayDatabase } from "./db.ts";
import { GitHubWebhookHandler } from "./github-webhook-handler.ts";
import { IssueQueryService } from "./issue-query-service.ts";
import { LinearOAuthService } from "./linear-oauth-service.ts";
import { RunOrchestrator } from "./run-orchestrator.ts";
import { OperatorEventFeed, type OperatorFeedQuery } from "./operator-feed.ts";
import {
  buildSessionStatusUrl,
  createSessionStatusToken,
  deriveSessionStatusSigningSecret,
  verifySessionStatusToken,
} from "./public-agent-session-status.ts";
import { ServiceRuntime } from "./service-runtime.ts";
import { WebhookHandler } from "./webhook-handler.ts";
import { acceptIncomingWebhook } from "./service-webhooks.ts";
import type { AppConfig, LinearClient, LinearClientProvider } from "./types.ts";

export class PatchRelayService {
  readonly linearProvider: LinearClientProvider;
  private readonly orchestrator: RunOrchestrator;
  private readonly webhookHandler: WebhookHandler;
  private readonly githubWebhookHandler: GitHubWebhookHandler;
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

    let enqueueIssue: (projectId: string, issueId: string) => void = () => {
      throw new Error("Service runtime enqueueIssue is not initialized");
    };

    this.orchestrator = new RunOrchestrator(
      config, db, codex, this.linearProvider,
      (projectId: string, issueId: string) => enqueueIssue(projectId, issueId),
      logger, this.feed,
    );

    this.webhookHandler = new WebhookHandler(
      config,
      db,
      this.linearProvider,
      codex,
      (projectId, issueId) => enqueueIssue(projectId, issueId),
      logger,
      this.feed,
    );

    this.githubWebhookHandler = new GitHubWebhookHandler(
      config, db,
      (projectId, issueId) => enqueueIssue(projectId, issueId),
      logger, this.feed,
    );
    const runtime = new ServiceRuntime(
      codex,
      logger,
      this.orchestrator,
      { listIssuesReadyForExecution: () => db.listIssuesReadyForExecution() },
      this.webhookHandler,
      { processIssue: (item: { projectId: string; issueId: string }) => this.orchestrator.run(item) },
    );
    enqueueIssue = (projectId, issueId) => runtime.enqueueIssue(projectId, issueId);

    this.oauthService = new LinearOAuthService(config, { linearInstallations: db.linearInstallations }, logger);
    this.queryService = new IssueQueryService(db, codex, this.orchestrator);
    this.runtime = runtime;

    this.codex.on("notification", (notification: CodexNotification) => {
      void this.orchestrator.handleCodexNotification(notification);
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
        webhookEvents: {
          insertWebhookEvent: (p: { webhookId: string; receivedAt: string; payloadJson: string }) => {
            const r = this.db.insertFullWebhookEvent(p);
            return { id: r.id, dedupeStatus: r.dedupeStatus };
          },
        },
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

  async acceptGitHubWebhook(params: {
    deliveryId: string;
    eventType: string;
    signature: string;
    rawBody: Buffer;
  }): Promise<{ status: number; body: Record<string, unknown> }> {
    const result = await this.githubWebhookHandler.acceptGitHubWebhook(params);
    if (result.body.accepted && result.body.webhookEventId) {
      // Process inline since GitHub events are lightweight (just PR state updates)
      await this.githubWebhookHandler.processGitHubWebhookEvent({
        eventType: params.eventType,
        rawBody: params.rawBody.toString("utf8"),
      });
    }
    return result;
  }

  async processWebhookEvent(webhookEventId: number): Promise<void> {
    await this.webhookHandler.processWebhookEvent(webhookEventId);
  }

  async processIssue(item: { projectId: string; issueId: string }): Promise<void> {
    await this.orchestrator.run(item);
  }

  async getIssueOverview(issueKey: string) {
    return await this.queryService.getIssueOverview(issueKey);
  }

  async getIssueReport(issueKey: string) {
    return await this.queryService.getIssueReport(issueKey);
  }

  async getRunEvents(issueKey: string, runId: number) {
    return await this.queryService.getRunEvents(issueKey, runId);
  }

  async getActiveRunStatus(issueKey: string) {
    return await this.orchestrator.getActiveRunStatus(issueKey);
  }

  createPublicAgentSessionStatusLink(
    issueKey: string,
    options?: { nowMs?: number; ttlSeconds?: number },
  ): { url: string; issueKey: string; expiresAt: string } | undefined {
    if (!this.config.server.publicBaseUrl) return undefined;
    const signingSecret = deriveSessionStatusSigningSecret(this.config.linear.tokenEncryptionKey);
    const token = createSessionStatusToken({
      issueKey,
      secret: signingSecret,
      ...(options?.nowMs !== undefined ? { nowMs: options.nowMs } : {}),
      ...(options?.ttlSeconds !== undefined ? { ttlSeconds: options.ttlSeconds } : {}),
    });
    return {
      url: buildSessionStatusUrl({ publicBaseUrl: this.config.server.publicBaseUrl, issueKey, token: token.token }),
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
    if (!sessionStatus) return { status: "issue_not_found" };
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
