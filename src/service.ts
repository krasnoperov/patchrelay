import type { Logger } from "pino";
import type { CodexAppServerClient, CodexNotification } from "./codex-app-server.ts";
import type { PatchRelayDatabase } from "./db.ts";
import {
  resolveGitHubAppCredentials,
  createGitHubAppTokenManager,
  ensureGhWrapper,
  type GitHubAppTokenManager,
} from "./github-app-token.ts";
import { parseGitHubFailureContext, summarizeGitHubFailureContext } from "./github-failure-context.ts";
import { GitHubWebhookHandler } from "./github-webhook-handler.ts";
import { IssueQueryService } from "./issue-query-service.ts";
import { DatabaseBackedLinearClientProvider } from "./linear-client.ts";
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

function parseObjectJson(value: string | undefined): Record<string, unknown> | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function extractStatusNote(summaryJson?: string, reportJson?: string): string | undefined {
  const summary = parseObjectJson(summaryJson);
  if (typeof summary?.latestAssistantMessage === "string" && summary.latestAssistantMessage.trim()) {
    return summary.latestAssistantMessage;
  }

  const report = parseObjectJson(reportJson);
  const assistantMessages = report?.assistantMessages;
  if (Array.isArray(assistantMessages)) {
    const latest = assistantMessages.findLast((value) => typeof value === "string" && value.trim().length > 0);
    if (typeof latest === "string") return latest;
  }

  return undefined;
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
    this.queryService = new IssueQueryService(config, db, codex, this.orchestrator);
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
      }
    }
    await this.runtime.start();
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
    latestFailureSource?: string;
    latestFailureHeadSha?: string;
    latestFailureCheckName?: string;
    latestFailureStepName?: string;
    latestFailureSummary?: string;
    updatedAt: string;
  }> {
    const rows = this.db.connection
      .prepare(
        `SELECT
          i.project_id, i.linear_issue_id, i.issue_key, i.title,
          i.current_linear_state, i.factory_state, i.updated_at,
          i.pending_run_type,
          i.pr_number, i.pr_review_state, i.pr_check_status,
          i.last_github_failure_source,
          i.last_github_failure_head_sha,
          i.last_github_failure_check_name,
          i.last_github_failure_context_json,
          active_run.run_type AS active_run_type,
          latest_run.run_type AS latest_run_type,
          latest_run.status AS latest_run_status,
          latest_run.summary_json AS latest_run_summary_json,
          latest_run.report_json AS latest_run_report_json,
          (
            SELECT COUNT(*)
            FROM issue_dependencies d
            LEFT JOIN issues blockers
              ON blockers.project_id = d.project_id
             AND blockers.linear_issue_id = d.blocker_linear_issue_id
            WHERE d.project_id = i.project_id
              AND d.linear_issue_id = i.linear_issue_id
              AND (
                COALESCE(blockers.current_linear_state_type, d.blocker_current_linear_state_type, '') != 'completed'
                AND LOWER(TRIM(COALESCE(blockers.current_linear_state, d.blocker_current_linear_state, ''))) != 'done'
              )
          ) AS blocked_by_count,
          (
            SELECT json_group_array(COALESCE(blockers.issue_key, d.blocker_issue_key, d.blocker_linear_issue_id))
            FROM issue_dependencies d
            LEFT JOIN issues blockers
              ON blockers.project_id = d.project_id
             AND blockers.linear_issue_id = d.blocker_linear_issue_id
            WHERE d.project_id = i.project_id
              AND d.linear_issue_id = i.linear_issue_id
              AND (
                COALESCE(blockers.current_linear_state_type, d.blocker_current_linear_state_type, '') != 'completed'
                AND LOWER(TRIM(COALESCE(blockers.current_linear_state, d.blocker_current_linear_state, ''))) != 'done'
              )
          ) AS blocked_by_keys_json
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
    return rows.map((row) => {
      const failureContext = parseGitHubFailureContext(
        typeof row.last_github_failure_context_json === "string" ? row.last_github_failure_context_json : undefined,
      );
      const statusNote = extractStatusNote(
        typeof row.latest_run_summary_json === "string" ? row.latest_run_summary_json : undefined,
        typeof row.latest_run_report_json === "string" ? row.latest_run_report_json : undefined,
      );
      const blockedByKeys = parseStringArray(
        typeof row.blocked_by_keys_json === "string" ? row.blocked_by_keys_json : undefined,
      );
      const blockedByCount = Number(row.blocked_by_count ?? 0);
      const readyForExecution = row.pending_run_type !== null && row.pending_run_type !== undefined && row.active_run_type === null && blockedByCount === 0;
      const failureSummary = summarizeGitHubFailureContext(failureContext);
      const derivedStatusNote = blockedByCount > 0
        ? `Blocked by ${blockedByKeys.join(", ")}`
        : failureSummary && (
          row.factory_state === "repairing_ci"
          || row.factory_state === "repairing_queue"
          || row.factory_state === "failed"
        )
          ? failureSummary
          : statusNote;
      const statusNoteWithBlockers = blockedByCount > 0
        ? `Blocked by ${blockedByKeys.join(", ")}`
        : derivedStatusNote;

      return {
        ...(row.issue_key !== null ? { issueKey: String(row.issue_key) } : {}),
        ...(row.title !== null ? { title: String(row.title) } : {}),
        ...(statusNoteWithBlockers ? { statusNote: statusNoteWithBlockers } : {}),
        projectId: String(row.project_id),
        factoryState: String(row.factory_state ?? "delegated"),
        blockedByCount,
        blockedByKeys,
        readyForExecution,
        ...(row.current_linear_state !== null ? { currentLinearState: String(row.current_linear_state) } : {}),
        ...(row.active_run_type !== null ? { activeRunType: String(row.active_run_type) } : {}),
        ...(row.pending_run_type !== null ? { pendingRunType: String(row.pending_run_type) } : {}),
        ...(row.latest_run_type !== null ? { latestRunType: String(row.latest_run_type) } : {}),
        ...(row.latest_run_status !== null ? { latestRunStatus: String(row.latest_run_status) } : {}),
        ...(row.pr_number !== null ? { prNumber: Number(row.pr_number) } : {}),
        ...(row.pr_review_state !== null ? { prReviewState: String(row.pr_review_state) } : {}),
        ...(row.pr_check_status !== null ? { prCheckStatus: String(row.pr_check_status) } : {}),
        ...(row.last_github_failure_source !== null ? { latestFailureSource: String(row.last_github_failure_source) } : {}),
        ...(row.last_github_failure_head_sha !== null ? { latestFailureHeadSha: String(row.last_github_failure_head_sha) } : {}),
        ...(row.last_github_failure_check_name !== null ? { latestFailureCheckName: String(row.last_github_failure_check_name) } : {}),
        ...(failureContext?.stepName ? { latestFailureStepName: failureContext.stepName } : {}),
        ...(failureContext?.summary ? { latestFailureSummary: failureContext.summary } : {}),
        updatedAt: String(row.updated_at),
      };
    });
  }

  subscribeCodexNotifications(
    listener: (event: { method: string; params: Record<string, unknown>; issueKey?: string; runId?: number }) => void,
  ): () => void {
    let trackedThreadId: string | undefined;
    const handler = (notification: CodexNotification) => {
      let threadId = typeof notification.params.threadId === "string"
        ? notification.params.threadId
        : typeof notification.params.thread === "object" && notification.params.thread !== null && "id" in (notification.params.thread as Record<string, unknown>)
          ? String((notification.params.thread as Record<string, unknown>).id)
          : undefined;
      // Item-level notifications lack threadId — use the tracked one from turn/started
      if (!threadId) threadId = trackedThreadId;
      if (notification.method === "turn/started" && threadId) trackedThreadId = threadId;
      if (notification.method === "turn/completed") trackedThreadId = undefined;
      let issueKey: string | undefined;
      let runId: number | undefined;
      if (threadId) {
        const run = this.db.getRunByThreadId(threadId);
        if (run) {
          runId = run.id;
          const issue = this.db.getIssue(run.projectId, run.linearIssueId);
          issueKey = issue?.issueKey ?? undefined;
        }
      }
      listener({
        method: notification.method,
        params: notification.params,
        ...(issueKey ? { issueKey } : {}),
        ...(runId !== undefined ? { runId } : {}),
      });
    };
    this.codex.on("notification", handler);
    return () => { this.codex.off("notification", handler); };
  }

  async promptIssue(
    issueKey: string,
    text: string,
    source: string = "watch",
  ): Promise<{ delivered: boolean; queued?: boolean } | { error: string } | undefined> {
    const issue = this.db.getIssueByKey(issueKey);
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
      const existing = issue.pendingRunContextJson
        ? JSON.parse(issue.pendingRunContextJson) as Record<string, unknown>
        : {};
      this.db.upsertIssue({
        projectId: issue.projectId,
        linearIssueId: issue.linearIssueId,
        pendingRunContextJson: JSON.stringify({ ...existing, operatorPrompt: text }),
      });
      return { delivered: false, queued: true };
    }

    const run = this.db.getRun(issue.activeRunId);
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
      const existing = issue.pendingRunContextJson
        ? JSON.parse(issue.pendingRunContextJson) as Record<string, unknown>
        : {};
      this.db.upsertIssue({
        projectId: issue.projectId,
        linearIssueId: issue.linearIssueId,
        pendingRunContextJson: JSON.stringify({ ...existing, operatorPrompt: text }),
      });
      return { delivered: false, queued: true };
    }
  }

  async stopIssue(issueKey: string): Promise<{ stopped: boolean } | { error: string } | undefined> {
    const issue = this.db.getIssueByKey(issueKey);
    if (!issue) return undefined;
    if (!issue.activeRunId) return { error: "No active run to stop" };

    const run = this.db.getRun(issue.activeRunId);
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

    this.db.upsertIssue({
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
    const issue = this.db.getIssueByKey(issueKey);
    if (!issue) return undefined;
    if (issue.activeRunId) return { error: "Issue already has an active run" };

    // Infer run type from current state instead of always resetting to implementation
    let runType = "implementation";
    let factoryState: string = "delegated";
    if (issue.prNumber && issue.prCheckStatus === "failed") {
      runType = "ci_repair";
      factoryState = "repairing_ci";
    } else if (issue.prNumber && issue.prReviewState === "changes_requested") {
      runType = "review_fix";
      factoryState = "changes_requested";
    } else if (issue.prNumber) {
      // PR exists but no specific failure — re-run implementation
      runType = "implementation";
      factoryState = "implementing";
    }

    this.db.upsertIssue({
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      pendingRunType: runType as never,
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
    this.runtime.enqueueIssue(issue.projectId, issue.linearIssueId);
    return { issueKey, runType };
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

  async getIssueTimeline(issueKey: string) {
    return await this.queryService.getIssueTimeline(issueKey);
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

function parseStringArray(value: string | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

function workspaceMatches(workspace: string, installation: { workspaceKey?: string; workspaceName?: string; workspaceId?: string }): boolean {
  const normalized = workspace.trim().toLowerCase();
  return [
    installation.workspaceKey,
    installation.workspaceName,
    installation.workspaceId,
  ].some((value) => value?.trim().toLowerCase() === normalized);
}
