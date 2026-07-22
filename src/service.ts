import type { Logger } from "pino";
import type { CodexAppServerClient, CodexNotification } from "./codex-app-server.ts";
import type { PatchRelayDatabase } from "./db.ts";
import {
  resolveGitHubAppCredentials,
  createGitHubAppTokenManager,
  getGitHubAppPaths,
  type GitHubAppTokenManager,
} from "./github-app-token.ts";
import { applyGitHubCliAuthEnv, resolveGhBin, verifyGitHubCliAuthEnv } from "./github-cli-auth.ts";
import { remediateLeakedBotAuth } from "./github-auth-remediation.ts";
import { GitHubWebhookHandler } from "./github-webhook-handler.ts";
import { IssueQueryService } from "./issue-query-service.ts";
import { DatabaseBackedLinearClientProvider } from "./linear-client.ts";
import { LinearOAuthService } from "./linear-oauth-service.ts";
import { RunOrchestrator } from "./run-orchestrator.ts";
import { OperatorEventFeed, type OperatorFeedEvent } from "./operator-feed.ts";
import {
  buildSessionStatusUrl,
  createSessionStatusToken,
  deriveSessionStatusSigningSecret,
  verifySessionStatusToken,
} from "./public-agent-session-status.ts";
import { ServiceRuntime, type ServiceRuntimeOptions } from "./service-runtime.ts";
import { ServiceIssueActions } from "./service-issue-actions.ts";
import { ServiceStartupRecovery } from "./service-startup-recovery.ts";
import { WorkflowTaskDispatcher } from "./workflow-task-dispatcher.ts";
import { WebhookHandler } from "./webhook-handler.ts";
import { acceptIncomingWebhook } from "./service-webhooks.ts";
import { ABANDONED_PENDING_WEBHOOK_AGE_MS } from "./db/webhook-event-store.ts";
import { runWebhookEventRetention } from "./event-retention.ts";
import { runTerminalWorktreeCleanup } from "./worktree-cleanup.ts";
import type { AppConfig, LinearClient, LinearClientProvider } from "./types.ts";
import { parseStringArray, TrackedIssueListQuery } from "./tracked-issue-list-query.ts";
import { AgentInputService } from "./agent-input-service.ts";
import { CodexFollowupIntentClassifier } from "./followup-intent.ts";
import { FanoutPatchRelayTelemetry, LoggerTelemetrySink, OperatorFeedTelemetrySink } from "./telemetry.ts";

function readPositiveIntegerEnv(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 1) return undefined;
  return Math.floor(value);
}

export class PatchRelayService {
  readonly linearProvider: LinearClientProvider;
  private readonly orchestrator: RunOrchestrator;
  private readonly githubAppTokenManager?: GitHubAppTokenManager;
  private readonly webhookHandler: WebhookHandler;
  private readonly githubWebhookHandler: GitHubWebhookHandler;
  private readonly oauthService: LinearOAuthService;
  private readonly queryService: IssueQueryService;
  private readonly runtime: ServiceRuntime;
  private readonly feed: OperatorEventFeed;
  private readonly issueActions: ServiceIssueActions;
  private readonly startupRecovery: ServiceStartupRecovery;
  private readonly trackedIssueListQuery: TrackedIssueListQuery;
  private eventRetentionTimer: ReturnType<typeof setTimeout> | undefined;
  private worktreeCleanupTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    readonly config: AppConfig,
    readonly db: PatchRelayDatabase,
    readonly codex: CodexAppServerClient,
    linearProvider: LinearClientProvider | LinearClient | undefined,
    readonly logger: Logger,
    private readonly configPath?: string,
  ) {
    this.linearProvider = toLinearClientProvider(linearProvider);
    this.feed = new OperatorEventFeed(db.operatorFeed);
    const telemetry = new FanoutPatchRelayTelemetry([
      new LoggerTelemetrySink(logger),
      new OperatorFeedTelemetrySink(this.feed),
    ]);
    db.setTelemetry(telemetry);

    let enqueueIssue: (projectId: string, issueId: string) => void = () => {
      throw new Error("Service runtime enqueueIssue is not initialized");
    };
    let leaseRelease: (projectId: string, issueId: string) => void = () => {
      throw new Error("WorkflowTaskDispatcher releaseLease is not yet bound");
    };

    // The dispatcher owns every "append event + maybe enqueue" and every
    // "release run + dispatch pending workflow task" call. See src/workflow-task-dispatcher.ts
    // for why. Both `enqueueIssue` and `leaseRelease` are late-bound — the
    // runtime owns the queue, and the lease service lives inside the
    // orchestrator (its construction depends on the Codex client). All
    // downstream consumers receive this single dispatcher instance.
    const dispatcher = new WorkflowTaskDispatcher(
      db,
      (projectId, issueId) => enqueueIssue(projectId, issueId),
      (projectId, issueId) => leaseRelease(projectId, issueId),
      logger,
      this.feed,
      telemetry,
    );
    const agentInput = new AgentInputService(
      db,
      codex,
      dispatcher,
      logger,
      this.feed,
      new CodexFollowupIntentClassifier(codex, logger),
    );

    this.orchestrator = new RunOrchestrator(
      config,
      db,
      codex,
      this.linearProvider,
      (projectId: string, issueId: string) => enqueueIssue(projectId, issueId),
      dispatcher,
      logger,
      this.feed,
      this.configPath,
      telemetry,
    );
    leaseRelease = (projectId, issueId) => this.orchestrator.leaseService.release(projectId, issueId);

    this.webhookHandler = new WebhookHandler(
      config,
      db,
      this.linearProvider,
      codex,
      dispatcher,
      logger,
      this.feed,
      undefined,
      agentInput,
      telemetry,
    );

    this.githubWebhookHandler = new GitHubWebhookHandler(
      config, db, this.linearProvider,
      dispatcher,
      logger, codex, this.feed,
    );
    const runtimeOptions: ServiceRuntimeOptions = {
      assertStorageReady: () => db.assertSchemaReady(),
      describeStorage: () => db.describeSchema(),
    };
    const maxActiveIssueRuns = readPositiveIntegerEnv("PATCHRELAY_MAX_ACTIVE_ISSUE_RUNS");
    if (maxActiveIssueRuns !== undefined) {
      runtimeOptions.maxActiveIssueRuns = maxActiveIssueRuns;
    }
    const issueRunCapacityRetryDelayMs = readPositiveIntegerEnv("PATCHRELAY_ISSUE_RUN_CAPACITY_RETRY_DELAY_MS");
    if (issueRunCapacityRetryDelayMs !== undefined) {
      runtimeOptions.issueRunCapacityRetryDelayMs = issueRunCapacityRetryDelayMs;
    }
    const runtime = new ServiceRuntime(
      codex,
      logger,
      this.orchestrator,
      {
        listIssuesReadyForExecution: () => db.listIssuesReadyForExecution(),
        countActiveIssueRuns: () => db.runs.listActiveRuns().length,
      },
      this.webhookHandler,
      {
        processIssue: async (item: { projectId: string; issueId: string }) => {
          await this.orchestrator.run(item);
        },
      },
      runtimeOptions,
    );
    enqueueIssue = (projectId, issueId) => runtime.enqueueIssue(projectId, issueId);

    this.oauthService = new LinearOAuthService(config, { linearInstallations: db.linearInstallations }, logger);
    this.queryService = new IssueQueryService(db, codex, this.orchestrator);
    this.runtime = runtime;
    this.issueActions = new ServiceIssueActions(config, db, agentInput, codex, runtime, this.feed, logger);
    this.startupRecovery = new ServiceStartupRecovery(
      config,
      db,
      this.linearProvider,
      this.orchestrator.linearSync,
      (projectId, issueId) => runtime.enqueueIssue(projectId, issueId),
      logger,
      this.orchestrator.leaseService,
    );
    this.trackedIssueListQuery = new TrackedIssueListQuery(db);

    // Optional GitHub App token management for bot identity
    const ghAppCredentials = resolveGitHubAppCredentials();
    if (ghAppCredentials) {
      Object.assign(config.secretSources, ghAppCredentials.secretSources);
      this.githubAppTokenManager = createGitHubAppTokenManager(ghAppCredentials, logger, (status) => {
        // Surface auth health on every rotation so `patchrelay` status reflects it and
        // a broken token escalates instead of silently failing later git/gh operations.
        this.runtime.setGithubAppAuthHealthy(status.healthy, status.lastRefreshError ?? undefined);
      });
    }

    this.codex.on("notification", (notification: CodexNotification) => {
      this.orchestrator.handleCodexNotification(notification).catch((error) => {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error({ method: notification.method, error: msg }, "Unhandled error in Codex notification handler");
      });
    });
  }

  async start(): Promise<void> {
    this.db.issueSessions.releaseExpiredIssueSessionLeases();
    this.sweepAbandonedWebhookEvents();

    const repairedInstallations = this.db.linearInstallations.repairProjectInstallations(
      this.config.projects.map((project) => project.id),
    );
    for (const repair of repairedInstallations) {
      this.logger.info(
        { projectId: repair.projectId, installationId: repair.installationId, reason: repair.reason },
        "Repaired Linear project installation link",
      );
    }

    // Verify Linear connectivity for all configured projects before starting.
    // Auth errors do not prevent startup (the OAuth callback must be reachable
    // for `patchrelay linear connect`), but the service reports NOT READY until at
    // least one project has a working Linear token.
    let anyLinearConnected = false;
    for (const project of this.config.projects) {
      try {
        const client = await this.linearProvider.forProject(project.id);
        if (client) {
          anyLinearConnected = true;
        } else {
          const installation = this.db.linearInstallations.getLinearInstallationForProject(project.id);
          if (installation?.healthStatus && installation.healthStatus !== "ok") {
            this.logger.warn(
              {
                projectId: project.id,
                installationId: installation.id,
                healthStatus: installation.healthStatus,
                healthReason: installation.healthReason,
              },
              "Linear installation is unhealthy — run 'patchrelay linear connect' to re-authorize before processing this project",
            );
          } else {
            this.logger.warn({ projectId: project.id }, "No Linear installation linked — run 'patchrelay linear connect' and then 'patchrelay repo link' to authorize");
          }
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        this.logger.error({ projectId: project.id, error: msg }, "Linear auth failed — run 'patchrelay linear connect' to refresh the token. Runs for this project will fail until re-authorized.");
      }
    }
    this.runtime.setLinearConnected(anyLinearConnected);
    if (!anyLinearConnected && this.config.projects.length > 0) {
      this.logger.error("No projects have working Linear auth — service is NOT READY. Run 'patchrelay linear connect' to authorize.");
    }

    if (this.githubAppTokenManager) {
      const { ghConfigDir } = getGitHubAppPaths();
      const ghBin = resolveGhBin();
      // Point gh + git at the bot config dir before the first rotation and before the
      // Codex app-server spawns (it inherits this process env). GH_TOKEN/GITHUB_TOKEN are
      // cleared so the rotated hosts.yml is the single source of truth.
      applyGitHubCliAuthEnv(process.env, { ghConfigDir, ghBin });
      await this.githubAppTokenManager.start();
      const identity = this.githubAppTokenManager.botIdentity();
      if (identity) {
        this.orchestrator.botIdentity = identity;
        // Re-apply with identity so bot commit attribution flows to git via env.
        applyGitHubCliAuthEnv(process.env, { ghConfigDir, ghBin, identity });
      }
      const ghAuthStatus = this.githubAppTokenManager.authStatus();
      this.runtime.setGithubAppAuthHealthy(ghAuthStatus.healthy, ghAuthStatus.lastRefreshError ?? undefined);
      if (!ghAuthStatus.healthy) {
        this.logger.error({ ghAuthStatus }, "GitHub App auth is NOT healthy at startup — git/gh operations will fail until a token is minted");
        throw new Error(`GitHub App auth is not healthy at startup: ${ghAuthStatus.lastRefreshError ?? "no fresh installation token"}`);
      } else {
        try {
          await verifyGitHubCliAuthEnv(process.env);
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          this.runtime.setGithubAppAuthHealthy(false, msg);
          this.logger.error({ error: msg, ghConfigDir }, "GitHub App auth smoke test failed — service will not accept work");
          throw error;
        }
        this.logger.info({ installationId: ghAuthStatus.installationId, expiresAt: ghAuthStatus.expiresAt }, "GitHub App auth ready — gh + git authenticate as the bot");
      }
      // Clean up credentials older versions persisted into managed repo configs.
      await remediateLeakedBotAuth({
        gitBin: this.config.runner.gitBin,
        repoPaths: this.config.repositories.map((repository) => repository.localPath),
        ...(identity ? { botName: identity.name } : {}),
        logger: this.logger,
      });
    }
    this.startupRecovery.reconcileKnownWorkflowTasks();
    await this.runtime.start();
    this.scheduleEventRetention(60_000);
    this.scheduleWorktreeCleanup(60_000);
    void this.startupRecovery.recoverDelegatedIssueStateFromLinear().catch((error) => {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.warn({ error: msg }, "Background delegated issue recovery failed");
    });
    void this.startupRecovery.syncKnownAgentSessions().catch((error) => {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.warn({ error: msg }, "Background agent session sync failed");
    });
  }

  async stop(): Promise<void> {
    if (this.eventRetentionTimer !== undefined) {
      clearTimeout(this.eventRetentionTimer);
      this.eventRetentionTimer = undefined;
    }
    if (this.worktreeCleanupTimer !== undefined) {
      clearTimeout(this.worktreeCleanupTimer);
      this.worktreeCleanupTimer = undefined;
    }
    this.githubAppTokenManager?.stop();
    await this.runtime.stop();
  }

  async createLinearOAuthStart(params?: { projectId?: string }) {
    return await this.oauthService.createStart(params);
  }

  async createLinearWorkspaceOAuthStart() {
    return await this.oauthService.createStart();
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

  listLinearWorkspaces() {
    return this.db.linearInstallations.listLinearInstallations().map((installation) => {
      const linkedRepos = this.config.repositories
        .filter((repository) => repository.workspace && workspaceMatches(repository.workspace, installation))
        .map((repository) => repository.githubRepo);
      const teams = this.db.repositories.listCatalogTeams(installation.id).map((team) => ({
        id: team.teamId,
        ...(team.key ? { key: team.key } : {}),
        ...(team.name ? { name: team.name } : {}),
      }));
      const projects = this.db.repositories.listCatalogProjects(installation.id).map((project) => ({
        id: project.projectId,
        ...(project.name ? { name: project.name } : {}),
        teamIds: parseStringArray(project.teamIdsJson),
      }));
      return {
        installation: this.oauthService.getInstallationSummary(installation),
        linkedRepos,
        teams,
        projects,
      };
    });
  }

  async syncLinearWorkspace(workspace?: string) {
    const installation = workspace
      ? this.db.linearInstallations.findLinearInstallationByWorkspace(workspace)
      : this.db.linearInstallations.listLinearInstallations()[0];
    if (!installation) {
      throw new Error(workspace ? `Workspace not found: ${workspace}` : "No Linear workspace connected");
    }
    const provider = this.linearProvider instanceof DatabaseBackedLinearClientProvider ? this.linearProvider : undefined;
    if (!provider) {
      throw new Error("Linear provider does not support installation sync");
    }
    const client = await provider.forInstallationId(installation.id);
    if (!client) {
      throw new Error(`Linear installation ${installation.id} is unavailable`);
    }
    const catalog = await client.getWorkspaceCatalog();
    this.db.repositories.replaceCatalog({
      installationId: installation.id,
      teams: catalog.teams,
      projects: catalog.projects,
    });
    return {
      installation: this.oauthService.getInstallationSummary(installation),
      teams: catalog.teams,
      projects: catalog.projects,
    };
  }

  disconnectLinearWorkspace(workspace: string) {
    const installation = this.db.linearInstallations.findLinearInstallationByWorkspace(workspace);
    if (!installation) {
      throw new Error(`Workspace not found: ${workspace}`);
    }
    this.db.transaction(() => {
      this.db.linearInstallations.unlinkInstallationProjects(installation.id);
      this.db.linearInstallations.deleteCatalogForInstallation(installation.id);
      this.db.linearInstallations.deleteLinearInstallation(installation.id);
    });
    return {
      installation: this.oauthService.getInstallationSummary(installation),
    };
  }

  getReadiness() {
    return this.runtime.getReadiness();
  }

  // Core simplification plan §C2: webhook_events is a dedupe + forensics log,
  // not a replay queue. A row stuck at 'pending' means a crash or restart
  // interrupted processing; the event will never be replayed (recovery is
  // re-derivation from GitHub/Linear via reconciliation), so mark it
  // 'abandoned' — making it archiveable — and surface the count to the
  // operator, because every abandoned row is a crash worth seeing.
  private sweepAbandonedWebhookEvents(): void {
    const cutoffIso = new Date(Date.now() - ABANDONED_PENDING_WEBHOOK_AGE_MS).toISOString();
    const abandoned = this.db.webhookEvents.markAbandonedPendingEventsBefore(cutoffIso);
    if (abandoned === 0) return;
    this.logger.warn({ abandoned, cutoffIso }, "Marked stale pending webhook events as abandoned at startup");
    this.feed.publish({
      level: "warn",
      kind: "webhook",
      status: "abandoned_events",
      summary: `Startup: marked ${abandoned} stale pending webhook event(s) as abandoned`,
      detail: "Processing was interrupted (crash/restart). State recovers via reconciliation; the rows stay archiveable for forensics.",
    });
  }

  private scheduleEventRetention(delayMs = 24 * 60 * 60 * 1000): void {
    if (this.eventRetentionTimer !== undefined) {
      clearTimeout(this.eventRetentionTimer);
    }
    const timer = setTimeout(() => {
      void this.runEventRetentionMaintenance();
    }, delayMs);
    timer.unref?.();
    this.eventRetentionTimer = timer;
  }

  private async runEventRetentionMaintenance(): Promise<void> {
    try {
      const result = await runWebhookEventRetention({
        db: this.db,
        config: this.config,
      });
      if (result.deleted > 0 || result.archived > 0 || result.remaining > 0) {
        this.logger.info(result, "Webhook event retention maintenance completed");
      }
      if (this.config.database.wal) {
        const checkpoint = this.db.runWalCheckpoint("PASSIVE");
        this.logger.debug({ checkpoint }, "SQLite WAL checkpoint completed");
      }
    } catch (error) {
      this.logger.warn(
        { error: error instanceof Error ? error.message : String(error) },
        "Webhook event retention maintenance failed",
      );
    } finally {
      this.scheduleEventRetention();
    }
  }

  private scheduleWorktreeCleanup(delayMs = this.config.maintenance.worktreeCleanupIntervalMinutes * 60 * 1000): void {
    if (this.worktreeCleanupTimer !== undefined) {
      clearTimeout(this.worktreeCleanupTimer);
    }
    const timer = setTimeout(() => {
      void this.runWorktreeCleanupMaintenance();
    }, delayMs);
    timer.unref?.();
    this.worktreeCleanupTimer = timer;
  }

  private async runWorktreeCleanupMaintenance(): Promise<void> {
    try {
      const result = await runTerminalWorktreeCleanup({
        db: this.db,
        config: this.config,
        logger: this.logger,
      });
      if (result.deleted > 0 || result.skippedDirty > 0 || result.failed > 0 || result.missing > 0) {
        this.logger.info(result, "Terminal worktree cleanup completed");
      }
    } catch (error) {
      this.logger.warn(
        { error: error instanceof Error ? error.message : String(error) },
        "Terminal worktree cleanup failed",
      );
    } finally {
      this.scheduleWorktreeCleanup();
    }
  }

  listTrackedIssues(): Array<{
    issueKey?: string;
    title?: string;
    statusNote?: string;
    projectId: string;
    sessionState?: string;
    phase: string;
    blockedByCount: number;
    blockedByKeys: string[];
    readyForExecution: boolean;
    currentLinearState?: string;
    activeRunType?: string;
    runnableTaskRunType?: string;
    latestRunType?: string;
    latestRunStatus?: string;
    prNumber?: number;
    prState?: string;
    prReviewState?: string;
    prCheckStatus?: string;
    prChecksSummary?: {
      total: number;
      completed: number;
      passed: number;
      failed: number;
      pending: number;
      overall: "pending" | "success" | "failure";
      failedNames?: string[] | undefined;
    };
    latestFailureSource?: string;
    latestFailureHeadSha?: string;
    latestFailureCheckName?: string;
    latestFailureStepName?: string;
    latestFailureSummary?: string;
    waitingReason?: string;
    completionCheckActive?: boolean;
    updatedAt: string;
  }> {
    return this.trackedIssueListQuery.listTrackedIssues();
  }

  async promptIssue(
    issueKey: string,
    text: string,
    source: string = "watch",
  ): Promise<{ delivered: boolean; queued?: boolean } | { error: string } | undefined> {
    return await this.issueActions.promptIssue(issueKey, text, source);
  }

  async stopIssue(issueKey: string): Promise<{ stopped: boolean } | { error: string } | undefined> {
    return await this.issueActions.stopIssue(issueKey);
  }

  retryIssue(issueKey: string): { issueKey: string; runType: string } | { error: string } | undefined {
    return this.issueActions.retryIssue(issueKey);
  }

  async closeIssue(
    issueKey: string,
    options?: { failed?: boolean; reason?: string },
  ): Promise<{ issueKey: string; phase: "done" | "failed"; releasedRunId?: number } | { error: string } | undefined> {
    return await this.issueActions.closeIssue(issueKey, options);
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
            const r = this.db.webhookEvents.insertFullWebhookEvent(p);
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

  listIssueFeedEvents(
    issueKey: string,
    options?: { afterId?: number; limit?: number },
  ): { events: OperatorFeedEvent[] } | undefined {
    const session = this.db.issueSessions.getIssueSessionByKey(issueKey);
    const issue = this.db.issues.getIssueByKey(issueKey);
    const projectId = session?.projectId ?? issue?.projectId;
    const resolvedIssueKey = session?.issueKey ?? issue?.issueKey ?? issueKey;
    if (!projectId) return undefined;

    return {
      events: this.db.operatorFeed.list({
        issueKey: resolvedIssueKey,
        projectId,
        ...(options?.afterId !== undefined ? { afterId: options.afterId } : {}),
        limit: Math.min(options?.limit ?? 100, 100),
      }),
    };
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

function workspaceMatches(workspace: string, installation: { workspaceKey?: string; workspaceName?: string; workspaceId?: string }): boolean {
  const normalized = workspace.trim().toLowerCase();
  return [
    installation.workspaceKey,
    installation.workspaceName,
    installation.workspaceId,
  ].some((value) => value?.trim().toLowerCase() === normalized);
}
