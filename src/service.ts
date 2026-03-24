import type { Logger } from "pino";
import type { CodexAppServerClient, CodexNotification } from "./codex-app-server.ts";
import type { PatchRelayDatabase } from "./db.ts";
import {
  resolveGitHubAppCredentials,
  createGitHubAppTokenManager,
  ensureGhWrapper,
  type GitHubAppTokenManager,
} from "./github-app-token.ts";
import { GitHubWebhookHandler } from "./github-webhook-handler.ts";
import { IssueQueryService } from "./issue-query-service.ts";
import { LinearOAuthService } from "./linear-oauth-service.ts";
import { MergeQueue } from "./merge-queue.ts";
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
  private readonly mergeQueue: MergeQueue;
  private readonly githubAppTokenManager?: GitHubAppTokenManager;
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

    this.mergeQueue = new MergeQueue(
      config, db,
      (projectId, issueId) => enqueueIssue(projectId, issueId),
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
      config, db, this.linearProvider,
      (projectId, issueId) => enqueueIssue(projectId, issueId),
      this.mergeQueue,
      logger, this.feed,
    );
    const runtime = new ServiceRuntime(
      codex,
      logger,
      this.orchestrator,
      { listIssuesReadyForExecution: () => db.listIssuesReadyForExecution() },
      this.webhookHandler,
      {
        processIssue: async (item: { projectId: string; issueId: string }) => {
          const issue = db.getIssue(item.projectId, item.issueId);
          // Repairs take priority over merge prep — a check_failed or
          // review_changes_requested that arrived while merge prep was
          // queued must not be swallowed.
          if (issue?.pendingRunType) {
            await this.orchestrator.run(item);
            return;
          }
          if (issue?.pendingMergePrep) {
            const project = config.projects.find((p) => p.id === item.projectId);
            if (project) await this.mergeQueue.prepareForMerge(issue, project);
            // Re-check: a repair run may have been enqueued during prep
            const after = db.getIssue(item.projectId, item.issueId);
            if (after?.pendingRunType) {
              runtime.enqueueIssue(item.projectId, item.issueId);
            }
            return;
          }
          await this.orchestrator.run(item);
        },
      },
    );
    enqueueIssue = (projectId, issueId) => runtime.enqueueIssue(projectId, issueId);

    this.oauthService = new LinearOAuthService(config, { linearInstallations: db.linearInstallations }, logger);
    this.queryService = new IssueQueryService(db, codex, this.orchestrator);
    this.runtime = runtime;

    // Optional GitHub App token management for bot identity
    const ghAppCredentials = resolveGitHubAppCredentials();
    if (ghAppCredentials) {
      Object.assign(config.secretSources, ghAppCredentials.secretSources);
      this.githubAppTokenManager = createGitHubAppTokenManager(ghAppCredentials, logger);
    }

    this.codex.on("notification", (notification: CodexNotification) => {
      this.orchestrator.handleCodexNotification(notification).catch((error) => {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error({ method: notification.method, error: msg }, "Unhandled error in Codex notification handler");
      });
    });
  }

  async start(): Promise<void> {
    // Verify Linear connectivity for all configured projects before starting.
    // Auth errors do not prevent startup (the OAuth callback must be reachable
    // for `patchrelay connect`), but the service reports NOT READY until at
    // least one project has a working Linear token.
    let anyLinearConnected = false;
    for (const project of this.config.projects) {
      try {
        const client = await this.linearProvider.forProject(project.id);
        if (client) {
          anyLinearConnected = true;
        } else {
          this.logger.warn({ projectId: project.id }, "No Linear installation linked — run 'patchrelay connect' to authorize");
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        this.logger.error({ projectId: project.id, error: msg }, "Linear auth failed — run 'patchrelay connect' to refresh the token. Runs for this project will fail until re-authorized.");
      }
    }
    this.runtime.setLinearConnected(anyLinearConnected);
    if (!anyLinearConnected && this.config.projects.length > 0) {
      this.logger.error("No projects have working Linear auth — service is NOT READY. Run 'patchrelay connect' to authorize.");
    }

    if (this.githubAppTokenManager) {
      await ensureGhWrapper(this.logger);
      await this.githubAppTokenManager.start();
      const identity = this.githubAppTokenManager.botIdentity();
      if (identity) {
        this.orchestrator.botIdentity = identity;
      }
    }
    await this.runtime.start();
    this.mergeQueue.seedOnStartup();
  }

  async stop(): Promise<void> {
    this.githubAppTokenManager?.stop();
    await this.runtime.stop();
  }

  async createLinearOAuthStart(params?: { projectId?: string }) {
    return await this.oauthService.createStart(params);
  }

  async completeLinearOAuth(params: { state: string; code: string }) {
    const result = await this.oauthService.complete(params);
    // A successful OAuth completion means at least one project now has
    // working Linear auth — update readiness.
    this.runtime.setLinearConnected(true);
    return result;
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

  listTrackedIssues(): Array<{
    issueKey?: string;
    title?: string;
    projectId: string;
    factoryState: string;
    currentLinearState?: string;
    activeRunType?: string;
    latestRunType?: string;
    latestRunStatus?: string;
    prNumber?: number;
    prReviewState?: string;
    prCheckStatus?: string;
    updatedAt: string;
  }> {
    const rows = this.db.connection
      .prepare(
        `SELECT
          i.project_id, i.linear_issue_id, i.issue_key, i.title,
          i.current_linear_state, i.factory_state, i.updated_at,
          i.pr_number, i.pr_review_state, i.pr_check_status,
          active_run.run_type AS active_run_type,
          latest_run.run_type AS latest_run_type,
          latest_run.status AS latest_run_status
        FROM issues i
        LEFT JOIN runs active_run ON active_run.id = i.active_run_id
        LEFT JOIN runs latest_run ON latest_run.id = (
          SELECT r.id FROM runs r
          WHERE r.project_id = i.project_id AND r.linear_issue_id = i.linear_issue_id
          ORDER BY r.id DESC LIMIT 1
        )
        ORDER BY i.updated_at DESC, i.issue_key ASC`,
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      ...(row.issue_key !== null ? { issueKey: String(row.issue_key) } : {}),
      ...(row.title !== null ? { title: String(row.title) } : {}),
      projectId: String(row.project_id),
      factoryState: String(row.factory_state ?? "delegated"),
      ...(row.current_linear_state !== null ? { currentLinearState: String(row.current_linear_state) } : {}),
      ...(row.active_run_type !== null ? { activeRunType: String(row.active_run_type) } : {}),
      ...(row.latest_run_type !== null ? { latestRunType: String(row.latest_run_type) } : {}),
      ...(row.latest_run_status !== null ? { latestRunStatus: String(row.latest_run_status) } : {}),
      ...(row.pr_number !== null ? { prNumber: Number(row.pr_number) } : {}),
      ...(row.pr_review_state !== null ? { prReviewState: String(row.pr_review_state) } : {}),
      ...(row.pr_check_status !== null ? { prCheckStatus: String(row.pr_check_status) } : {}),
      updatedAt: String(row.updated_at),
    }));
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
