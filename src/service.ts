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
import { isIssueSessionReadyForExecution } from "./issue-session.ts";
import { GitHubWebhookHandler } from "./github-webhook-handler.ts";
import { IssueQueryService } from "./issue-query-service.ts";
import { DatabaseBackedLinearClientProvider } from "./linear-client.ts";
import { LinearOAuthService } from "./linear-oauth-service.ts";
import { RunOrchestrator } from "./run-orchestrator.ts";
import { OperatorEventFeed } from "./operator-feed.ts";
import { derivePatchRelayWaitingReason } from "./waiting-reason.ts";
import {
  buildSessionStatusUrl,
  createSessionStatusToken,
  deriveSessionStatusSigningSecret,
  verifySessionStatusToken,
} from "./public-agent-session-status.ts";
import { ServiceRuntime } from "./service-runtime.ts";
import { WebhookHandler } from "./webhook-handler.ts";
import { acceptIncomingWebhook } from "./service-webhooks.ts";
import { deriveIssueStatusNote } from "./status-note.ts";
import type { AppConfig, LinearClient, LinearClientProvider } from "./types.ts";
import type { GitHubCiSnapshotRecord, IssueRecord } from "./db-types.ts";

function parseObjectJson(value: string | undefined): Record<string, unknown> | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function shouldSuppressStatusNote(params: {
  activeRunType?: string | null | undefined;
  sessionState?: string | null | undefined;
  statusNote?: string | undefined;
}): boolean {
  if (!params.activeRunType && params.sessionState !== "running") return false;
  const note = params.statusNote?.trim().toLowerCase();
  if (!note) return true;
  return note === "codex turn was interrupted"
    || note.startsWith("zombie: never started")
    || note === "stale thread after restart"
    || note === "patchrelay received your mention. delegate the issue to patchrelay to start work.";
}

export function parseCiSnapshotSummary(snapshotJson?: string): {
  total: number;
  completed: number;
  passed: number;
  failed: number;
  pending: number;
  overall: "pending" | "success" | "failure";
  failedNames?: string[] | undefined;
} | undefined {
  if (!snapshotJson) return undefined;
  try {
    const snapshot = JSON.parse(snapshotJson) as GitHubCiSnapshotRecord;
    const rawChecks = Array.isArray(snapshot.checks) ? snapshot.checks : [];
    const checks = collapseEffectiveChecks(rawChecks);
    if (checks.length === 0) return undefined;
    let passed = 0;
    let failed = 0;
    let pending = 0;
    const failedNames: string[] = [];
    for (const check of checks) {
      if (check.status === "success") passed++;
      else if (check.status === "failure") {
        failed++;
        failedNames.push(check.name);
      } else pending++;
    }
    return {
      total: checks.length,
      completed: passed + failed,
      passed,
      failed,
      pending,
      overall: snapshot.gateCheckStatus,
      ...(failedNames.length > 0 ? { failedNames } : {}),
    };
  } catch {
    return undefined;
  }
}

function collapseEffectiveChecks(checks: GitHubCiSnapshotRecord["checks"]): GitHubCiSnapshotRecord["checks"] {
  const effective = new Map<string, GitHubCiSnapshotRecord["checks"][number]>();
  for (const check of checks) {
    const name = typeof check?.name === "string" ? check.name.trim() : "";
    if (!name || effective.has(name)) continue;
    effective.set(name, check);
  }
  return [...effective.values()];
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
    await this.recoverDelegatedIssueStateFromLinear();
    void this.syncKnownAgentSessions().catch((error) => {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.warn({ error: msg }, "Background agent session sync failed");
    });
  }

  async stop(): Promise<void> {
    this.githubAppTokenManager?.stop();
    await this.runtime.stop();
  }

  private async syncKnownAgentSessions(): Promise<void> {
    for (const issue of this.db.issues.listIssues()) {
      if (issue.factoryState === "done") {
        continue;
      }
      const syncedIssue = issue.agentSessionId
        ? issue
        : (() => {
            const recoveredAgentSessionId = this.db.webhookEvents.findLatestAgentSessionIdForIssue(issue.linearIssueId);
            return recoveredAgentSessionId
              ? this.db.issues.upsertIssue({
                  projectId: issue.projectId,
                  linearIssueId: issue.linearIssueId,
                  agentSessionId: recoveredAgentSessionId,
                })
              : issue;
          })();
      if (!syncedIssue.agentSessionId) {
        continue;
      }
      const activeRun = syncedIssue.activeRunId ? this.db.runs.getRunById(syncedIssue.activeRunId) : undefined;
      await this.orchestrator.linearSync.syncSession(syncedIssue, activeRun ? { activeRunType: activeRun.runType } : undefined);
    }
  }

  private async recoverDelegatedIssueStateFromLinear(): Promise<void> {
    for (const issue of this.db.issues.listIssuesWithAgentSessions()) {
      if (issue.factoryState === "done" || issue.activeRunId !== undefined) {
        continue;
      }
      const linear = await this.linearProvider.forProject(issue.projectId).catch(() => undefined);
      if (!linear) {
        continue;
      }
      const installation = this.db.linearInstallations.getLinearInstallationForProject(issue.projectId);
      if (!installation?.actorId) {
        continue;
      }

      const liveIssue = await linear.getIssue(issue.linearIssueId).catch(() => undefined);
      if (!liveIssue) {
        continue;
      }

      this.db.issues.replaceIssueDependencies({
        projectId: issue.projectId,
        linearIssueId: issue.linearIssueId,
        blockers: liveIssue.blockedBy.map((blocker) => ({
          blockerLinearIssueId: blocker.id,
          ...(blocker.identifier ? { blockerIssueKey: blocker.identifier } : {}),
          ...(blocker.title ? { blockerTitle: blocker.title } : {}),
          ...(blocker.stateName ? { blockerCurrentLinearState: blocker.stateName } : {}),
          ...(blocker.stateType ? { blockerCurrentLinearStateType: blocker.stateType } : {}),
        })),
      });

      const delegated = liveIssue.delegateId === installation.actorId;
      const unresolvedBlockers = this.db.issues.countUnresolvedBlockers(issue.projectId, issue.linearIssueId);
      const shouldRecoverAwaitingInput =
        delegated
        && issue.factoryState === "awaiting_input"
        && this.db.issueSessions.peekIssueSessionWake(issue.projectId, issue.linearIssueId) === undefined;

      const updated = this.db.issues.upsertIssue({
        projectId: issue.projectId,
        linearIssueId: issue.linearIssueId,
        ...(liveIssue.identifier ? { issueKey: liveIssue.identifier } : {}),
        ...(liveIssue.title ? { title: liveIssue.title } : {}),
        ...(liveIssue.description ? { description: liveIssue.description } : {}),
        ...(liveIssue.url ? { url: liveIssue.url } : {}),
        ...(liveIssue.priority != null ? { priority: liveIssue.priority } : {}),
        ...(liveIssue.estimate != null ? { estimate: liveIssue.estimate } : {}),
        ...(liveIssue.stateName ? { currentLinearState: liveIssue.stateName } : {}),
        ...(liveIssue.stateType ? { currentLinearStateType: liveIssue.stateType } : {}),
        ...(shouldRecoverAwaitingInput ? { factoryState: "delegated" as never } : {}),
      });

      if (!shouldRecoverAwaitingInput) {
        continue;
      }

      if (unresolvedBlockers === 0) {
        this.db.issueSessions.appendIssueSessionEventRespectingActiveLease(issue.projectId, issue.linearIssueId, {
          projectId: issue.projectId,
          linearIssueId: issue.linearIssueId,
          eventType: "delegated",
          dedupeKey: `delegated:${issue.linearIssueId}`,
        });
        if (this.db.issueSessions.peekIssueSessionWake(issue.projectId, issue.linearIssueId)) {
          this.runtime.enqueueIssue(issue.projectId, issue.linearIssueId);
        }
        this.logger.info({ issueKey: updated.issueKey }, "Recovered delegated issue from stale awaiting_input state and re-queued implementation");
      } else {
        this.logger.info({ issueKey: updated.issueKey, unresolvedBlockers }, "Recovered delegated blocked issue from stale awaiting_input state");
      }
    }
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
    updatedAt: string;
  }> {
    const rows = this.db.connection
      .prepare(
        `SELECT
          s.project_id, s.linear_issue_id, s.issue_key, i.title,
          i.current_linear_state, i.factory_state, s.session_state, s.waiting_reason, s.summary_text, s.updated_at,
          i.pending_run_type,
          i.pr_number, i.pr_head_sha, i.pr_review_state, i.pr_check_status, i.last_blocking_review_head_sha,
          i.last_github_ci_snapshot_json,
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
            FROM issue_session_events e
            WHERE e.project_id = s.project_id
              AND e.linear_issue_id = s.linear_issue_id
              AND e.processed_at IS NULL
          ) AS pending_session_event_count,
          (
            SELECT COUNT(*)
            FROM issue_dependencies d
            LEFT JOIN issues blockers
              ON blockers.project_id = d.project_id
             AND blockers.linear_issue_id = d.blocker_linear_issue_id
            WHERE d.project_id = s.project_id
              AND d.linear_issue_id = s.linear_issue_id
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
            WHERE d.project_id = s.project_id
              AND d.linear_issue_id = s.linear_issue_id
              AND (
                COALESCE(blockers.current_linear_state_type, d.blocker_current_linear_state_type, '') != 'completed'
                AND LOWER(TRIM(COALESCE(blockers.current_linear_state, d.blocker_current_linear_state, ''))) != 'done'
              )
          ) AS blocked_by_keys_json
        FROM issue_sessions s
        LEFT JOIN issues i
          ON i.project_id = s.project_id
         AND i.linear_issue_id = s.linear_issue_id
        LEFT JOIN runs active_run ON active_run.id = COALESCE(s.active_run_id, i.active_run_id)
        LEFT JOIN runs latest_run ON latest_run.id = (
          SELECT r.id FROM runs r
          WHERE r.project_id = s.project_id AND r.linear_issue_id = s.linear_issue_id
          ORDER BY r.id DESC LIMIT 1
        )
        ORDER BY s.updated_at DESC, s.issue_key ASC`,
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map((row) => {
      const failureContext = parseGitHubFailureContext(
        typeof row.last_github_failure_context_json === "string" ? row.last_github_failure_context_json : undefined,
      );
      const prChecksSummary = parseCiSnapshotSummary(
        typeof row.last_github_ci_snapshot_json === "string" ? row.last_github_ci_snapshot_json : undefined,
      );
      const blockedByKeys = parseStringArray(
        typeof row.blocked_by_keys_json === "string" ? row.blocked_by_keys_json : undefined,
      );
      const blockedByCount = Number(row.blocked_by_count ?? 0);
      const hasPendingSessionEvents = Number(row.pending_session_event_count ?? 0) > 0;
      const hasPendingWake = hasPendingSessionEvents
        || this.db.issueSessions.peekIssueSessionWake(String(row.project_id), String(row.linear_issue_id)) !== undefined;
      const readyForExecution = isIssueSessionReadyForExecution({
        ...(typeof row.session_state === "string" ? { sessionState: String(row.session_state) as never } : {}),
        factoryState: String(row.factory_state ?? "delegated") as never,
        ...(row.active_run_type !== null ? { activeRunId: 1 } : {}),
        blockedByCount,
        hasPendingWake,
        hasLegacyPendingRun: row.pending_run_type !== null && row.pending_run_type !== undefined,
        ...(row.pr_number !== null ? { prNumber: Number(row.pr_number) } : {}),
        ...(row.pr_state !== null ? { prState: String(row.pr_state) } : {}),
        ...(row.pr_review_state !== null ? { prReviewState: String(row.pr_review_state) } : {}),
        ...(row.pr_check_status !== null ? { prCheckStatus: String(row.pr_check_status) } : {}),
        ...(row.last_github_failure_source !== null ? { latestFailureSource: String(row.last_github_failure_source) } : {}),
      });
      const failureSummary = summarizeGitHubFailureContext(failureContext);
      const sessionWaitingReason = typeof row.waiting_reason === "string" && row.waiting_reason.trim().length > 0
        ? row.waiting_reason
        : undefined;
      const sessionSummary = typeof row.summary_text === "string" && row.summary_text.trim().length > 0
        ? row.summary_text
        : undefined;
      const waitingReason = sessionWaitingReason ?? derivePatchRelayWaitingReason({
        ...(row.active_run_type !== null ? { activeRunType: String(row.active_run_type) } : {}),
        blockedByKeys,
        factoryState: String(row.factory_state ?? "delegated"),
        ...(row.pending_run_type !== null ? { pendingRunType: String(row.pending_run_type) } : {}),
        ...(row.pr_number !== null ? { prNumber: Number(row.pr_number) } : {}),
        ...(row.pr_head_sha !== null ? { prHeadSha: String(row.pr_head_sha) } : {}),
        ...(row.pr_review_state !== null ? { prReviewState: String(row.pr_review_state) } : {}),
        ...(row.pr_check_status !== null ? { prCheckStatus: String(row.pr_check_status) } : {}),
        ...(row.last_blocking_review_head_sha !== null ? { lastBlockingReviewHeadSha: String(row.last_blocking_review_head_sha) } : {}),
        ...(row.last_github_failure_check_name !== null ? { latestFailureCheckName: String(row.last_github_failure_check_name) } : {}),
      });
      const latestRun = row.latest_run_type !== null && row.latest_run_status !== null
        ? {
            id: 0,
            issueId: 0,
            projectId: String(row.project_id),
            linearIssueId: String(row.linear_issue_id),
            runType: String(row.latest_run_type) as never,
            status: String(row.latest_run_status) as never,
            ...(typeof row.latest_run_summary_json === "string" ? { summaryJson: row.latest_run_summary_json } : {}),
            ...(typeof row.latest_run_report_json === "string" ? { reportJson: row.latest_run_report_json } : {}),
            startedAt: String(row.updated_at),
          }
        : undefined;
      const latestEvent = this.db.issueSessions.listIssueSessionEvents(String(row.project_id), String(row.linear_issue_id), { limit: 1 }).at(-1);
      const statusNoteCandidate = deriveIssueStatusNote({
        issue: { factoryState: String(row.factory_state ?? "delegated") } as never,
        sessionSummary,
        latestRun: latestRun as never,
        latestEvent,
        failureSummary,
        blockedByKeys,
        waitingReason,
      }) ?? waitingReason;
      const statusNoteForReturn = shouldSuppressStatusNote({
        activeRunType: row.active_run_type as string | null | undefined,
        sessionState: row.session_state as string | null | undefined,
        statusNote: statusNoteCandidate,
      })
        ? undefined
        : statusNoteCandidate;

      return {
        ...(row.issue_key !== null ? { issueKey: String(row.issue_key) } : {}),
        ...(row.title !== null ? { title: String(row.title) } : {}),
        ...(statusNoteForReturn ? { statusNote: statusNoteForReturn } : {}),
        projectId: String(row.project_id),
        ...(row.session_state !== null ? { sessionState: String(row.session_state) } : {}),
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
        ...(prChecksSummary ? { prChecksSummary } : {}),
        ...(row.last_github_failure_source !== null ? { latestFailureSource: String(row.last_github_failure_source) } : {}),
        ...(row.last_github_failure_head_sha !== null ? { latestFailureHeadSha: String(row.last_github_failure_head_sha) } : {}),
        ...(row.last_github_failure_check_name !== null ? { latestFailureCheckName: String(row.last_github_failure_check_name) } : {}),
        ...(failureContext?.stepName ? { latestFailureStepName: failureContext.stepName } : {}),
        ...(failureContext?.summary ? { latestFailureSummary: failureContext.summary } : {}),
        ...(waitingReason ? { waitingReason } : {}),
        updatedAt: String(row.updated_at),
      };
    });
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
    if (runType === "queue_repair") {
      const queueIncident = parseObjectJson(issue.lastQueueIncidentJson);
      const failureContext = parseObjectJson(issue.lastGitHubFailureContextJson);
      this.db.issueSessions.appendIssueSessionEventRespectingActiveLease(issue.projectId, issue.linearIssueId, {
        projectId: issue.projectId,
        linearIssueId: issue.linearIssueId,
        eventType: "merge_steward_incident",
        eventJson: JSON.stringify({
          ...(queueIncident ?? {}),
          ...(failureContext ?? {}),
          source: "operator_retry",
        }),
        dedupeKey: `operator_retry:queue_repair:${issue.linearIssueId}:${issue.prHeadSha ?? issue.lastGitHubFailureHeadSha ?? "unknown-sha"}`,
      });
      return;
    }

    if (runType === "ci_repair") {
      const failureContext = parseObjectJson(issue.lastGitHubFailureContextJson);
      this.db.issueSessions.appendIssueSessionEventRespectingActiveLease(issue.projectId, issue.linearIssueId, {
        projectId: issue.projectId,
        linearIssueId: issue.linearIssueId,
        eventType: "settled_red_ci",
        eventJson: JSON.stringify({
          ...(failureContext ?? {}),
          source: "operator_retry",
        }),
        dedupeKey: `operator_retry:ci_repair:${issue.linearIssueId}:${issue.lastGitHubFailureSignature ?? issue.prHeadSha ?? "unknown-sha"}`,
      });
      return;
    }

    if (runType === "review_fix" || runType === "branch_upkeep") {
      this.db.issueSessions.appendIssueSessionEventRespectingActiveLease(issue.projectId, issue.linearIssueId, {
        projectId: issue.projectId,
        linearIssueId: issue.linearIssueId,
        eventType: "review_changes_requested",
        eventJson: JSON.stringify({
          reviewBody: runType === "branch_upkeep"
            ? "Operator requested retry of branch upkeep after requested changes."
            : "Operator requested retry of review-fix work.",
          ...(runType === "branch_upkeep" ? { branchUpkeepRequired: true, wakeReason: "branch_upkeep" } : {}),
          source: "operator_retry",
        }),
        dedupeKey: `operator_retry:${runType}:${issue.linearIssueId}:${issue.prHeadSha ?? "unknown-sha"}`,
      });
      return;
    }

    this.db.issueSessions.appendIssueSessionEventRespectingActiveLease(issue.projectId, issue.linearIssueId, {
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      eventType: "delegated",
      eventJson: JSON.stringify({
        promptContext: "Operator requested retry of PatchRelay work.",
        source: "operator_retry",
      }),
      dedupeKey: `operator_retry:implementation:${issue.linearIssueId}`,
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
