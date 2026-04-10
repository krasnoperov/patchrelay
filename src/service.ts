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
import { DatabaseBackedLinearClientProvider } from "./linear-client.ts";
import { LinearOAuthService } from "./linear-oauth-service.ts";
import { RunOrchestrator } from "./run-orchestrator.ts";
import { OperatorEventFeed } from "./operator-feed.ts";
import {
  buildSessionStatusUrl,
  createSessionStatusToken,
  deriveSessionStatusSigningSecret,
  verifySessionStatusToken,
} from "./public-agent-session-status.ts";
import { ServiceRuntime } from "./service-runtime.ts";
import { ServiceStartupRecovery } from "./service-startup-recovery.ts";
import { WebhookHandler } from "./webhook-handler.ts";
import { acceptIncomingWebhook } from "./service-webhooks.ts";
import type { AppConfig, LinearClient, LinearClientProvider } from "./types.ts";
import type { IssueRecord } from "./db-types.ts";
import { parseStringArray, TrackedIssueListQuery } from "./tracked-issue-list-query.ts";

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
  private readonly startupRecovery: ServiceStartupRecovery;
  private readonly trackedIssueListQuery: TrackedIssueListQuery;

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
      config, db, this.linearProvider,
      (projectId, issueId) => enqueueIssue(projectId, issueId),
      logger, codex, this.feed,
    );
    const runtime = new ServiceRuntime(
      codex,
      logger,
      this.orchestrator,
      { listIssuesReadyForExecution: () => db.listIssuesReadyForExecution() },
      this.webhookHandler,
      {
        processIssue: async (item: { projectId: string; issueId: string }) => {
          await this.orchestrator.run(item);
        },
      },
    );
    enqueueIssue = (projectId, issueId) => runtime.enqueueIssue(projectId, issueId);

    this.oauthService = new LinearOAuthService(config, { linearInstallations: db.linearInstallations }, logger);
    this.queryService = new IssueQueryService(db, codex, this.orchestrator);
    this.runtime = runtime;
    this.startupRecovery = new ServiceStartupRecovery(
      db,
      this.linearProvider,
      this.orchestrator.linearSync,
      (projectId, issueId) => runtime.enqueueIssue(projectId, issueId),
      logger,
    );
    this.trackedIssueListQuery = new TrackedIssueListQuery(db);

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
    this.db.issueSessions.releaseExpiredIssueSessionLeases();

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
          this.logger.warn({ projectId: project.id }, "No Linear installation linked — run 'patchrelay linear connect' and then 'patchrelay repo link' to authorize");
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
      await ensureGhWrapper(this.logger);
      await this.githubAppTokenManager.start();
      const identity = this.githubAppTokenManager.botIdentity();
      if (identity) {
        this.orchestrator.botIdentity = identity;
        this.githubWebhookHandler.setPatchRelayAuthorLogins([identity.name]);
      }
    }
    await this.runtime.start();
    await this.startupRecovery.recoverDelegatedIssueStateFromLinear();
    void this.startupRecovery.syncKnownAgentSessions().catch((error) => {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.warn({ error: msg }, "Background agent session sync failed");
    });
  }

  async stop(): Promise<void> {
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
      this.db.connection.prepare("DELETE FROM linear_catalog_teams WHERE installation_id = ?").run(installation.id);
      this.db.connection.prepare("DELETE FROM linear_catalog_projects WHERE installation_id = ?").run(installation.id);
      this.db.linearInstallations.deleteLinearInstallation(installation.id);
    });
    return {
      installation: this.oauthService.getInstallationSummary(installation),
    };
  }

  getReadiness() {
    return this.runtime.getReadiness();
  }

  listTrackedIssues(): Array<{
    issueKey?: string;
    title?: string;
    statusNote?: string;
    projectId: string;
    sessionState?: string;
    factoryState: string;
    blockedByCount: number;
    blockedByKeys: string[];
    readyForExecution: boolean;
    currentLinearState?: string;
    activeRunType?: string;
    pendingRunType?: string;
    latestRunType?: string;
    latestRunStatus?: string;
    prNumber?: number;
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
    const issue = this.db.issues.getIssueByKey(issueKey);
    if (!issue) return undefined;

    // Publish to operator feed so all clients see the prompt
    this.feed.publish({
      level: "info",
      kind: "comment",
      issueKey: issue.issueKey,
      projectId: issue.projectId,
      stage: issue.factoryState,
      status: "operator_prompt",
      summary: `Operator prompt (${source})`,
      detail: text.slice(0, 200),
    });

    // If no active run, queue as pending context for the next run
    if (!issue.activeRunId) {
      this.db.issueSessions.appendIssueSessionEventRespectingActiveLease(issue.projectId, issue.linearIssueId, {
        projectId: issue.projectId,
        linearIssueId: issue.linearIssueId,
        eventType: "operator_prompt",
        eventJson: JSON.stringify({ text, source }),
      });
      this.runtime.enqueueIssue(issue.projectId, issue.linearIssueId);
      return { delivered: false, queued: true };
    }

    const run = this.db.runs.getRunById(issue.activeRunId);
    if (!run?.threadId || !run.turnId) {
      return { error: "Active run has no thread or turn yet" };
    }

    try {
      await this.codex.steerTurn({
        threadId: run.threadId,
        turnId: run.turnId,
        input: `Operator prompt (${source}):\n\n${text}`,
      });
      return { delivered: true };
    } catch (error) {
      // Turn may have completed between check and steer — queue for next run
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.warn({ issueKey, error: msg }, "steerTurn failed, queuing prompt for next run");
      this.db.issueSessions.appendIssueSessionEventRespectingActiveLease(issue.projectId, issue.linearIssueId, {
        projectId: issue.projectId,
        linearIssueId: issue.linearIssueId,
        eventType: "operator_prompt",
        eventJson: JSON.stringify({ text, source }),
      });
      this.runtime.enqueueIssue(issue.projectId, issue.linearIssueId);
      return { delivered: false, queued: true };
    }
  }

  async stopIssue(issueKey: string): Promise<{ stopped: boolean } | { error: string } | undefined> {
    const issue = this.db.issues.getIssueByKey(issueKey);
    if (!issue) return undefined;
    if (!issue.activeRunId) return { error: "No active run to stop" };

    const run = this.db.runs.getRunById(issue.activeRunId);
    if (run?.threadId && run.turnId) {
      try {
        await this.codex.steerTurn({
          threadId: run.threadId,
          turnId: run.turnId,
          input: "STOP: The operator has requested this run to halt immediately. Finish your current action, commit any partial progress, and stop.",
        });
      } catch {
        // Turn may already be done
      }
    }

    this.db.issueSessions.appendIssueSessionEventRespectingActiveLease(issue.projectId, issue.linearIssueId, {
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      eventType: "stop_requested",
      dedupeKey: `operator_stop:${issue.linearIssueId}`,
    });
    this.db.issueSessions.clearPendingIssueSessionEventsRespectingActiveLease(issue.projectId, issue.linearIssueId);

    this.db.issueSessions.upsertIssueRespectingActiveLease(issue.projectId, issue.linearIssueId, {
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      factoryState: "awaiting_input" as never,
    });

    this.feed.publish({
      level: "warn",
      kind: "workflow",
      issueKey: issue.issueKey,
      projectId: issue.projectId,
      status: "stopped",
      summary: "Operator stopped the run",
    });

    return { stopped: true };
  }

  retryIssue(issueKey: string): { issueKey: string; runType: string } | { error: string } | undefined {
    const issue = this.db.issues.getIssueByKey(issueKey);
    if (!issue) return undefined;
    if (issue.activeRunId) return { error: "Issue already has an active run" };
    const issueSession = this.db.issueSessions.getIssueSession(issue.projectId, issue.linearIssueId);

    if (issue.prState === "merged") {
      this.db.issueSessions.upsertIssueRespectingActiveLease(issue.projectId, issue.linearIssueId, {
        projectId: issue.projectId,
        linearIssueId: issue.linearIssueId,
        factoryState: "done" as never,
      });
      return { issueKey, runType: "none" };
    }

    // Infer run type from current state instead of always resetting to implementation
    let runType = "implementation";
    let factoryState: string = "delegated";
    if (issue.prNumber && issue.lastGitHubFailureSource === "queue_eviction") {
      runType = "queue_repair";
      factoryState = "repairing_queue";
    } else if (issue.prNumber && (issue.prCheckStatus === "failed" || issue.prCheckStatus === "failure" || issue.lastGitHubFailureSource === "branch_ci")) {
      runType = "ci_repair";
      factoryState = "repairing_ci";
    } else if (issue.prNumber && issue.prReviewState === "changes_requested") {
      runType = issue.pendingRunType === "branch_upkeep" || issueSession?.lastRunType === "branch_upkeep"
        ? "branch_upkeep"
        : "review_fix";
      factoryState = "changes_requested";
    } else if (issue.prNumber) {
      // PR exists but no specific failure — re-run implementation
      runType = "implementation";
      factoryState = "implementing";
    }

    this.appendOperatorRetryEvent(issue, runType);
    this.db.issueSessions.upsertIssueRespectingActiveLease(issue.projectId, issue.linearIssueId, {
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      factoryState: factoryState as never,
    });
    this.feed.publish({
      level: "info",
      kind: "stage",
      issueKey: issue.issueKey,
      projectId: issue.projectId,
      stage: factoryState,
      status: "retry",
      summary: `Retry queued: ${runType}`,
    });
    if (this.db.issueSessions.peekIssueSessionWake(issue.projectId, issue.linearIssueId)) {
      this.runtime.enqueueIssue(issue.projectId, issue.linearIssueId);
    }
    return { issueKey, runType };
  }

  private appendOperatorRetryEvent(
    issue: IssueRecord,
    runType: string,
  ): void {
    this.db.issueSessions.appendIssueSessionEventRespectingActiveLease(issue.projectId, issue.linearIssueId, {
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      ...this.trackedIssueListQuery.buildOperatorRetryEvent(issue, runType),
    });
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
