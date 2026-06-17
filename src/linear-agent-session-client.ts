import type { Logger } from "pino";
import type { PatchRelayDatabase } from "./db.ts";
import type { IssueRecord } from "./db-types.ts";
import type { RunType } from "./factory-state.ts";
import type { AppConfig, LinearAgentActivityContent, LinearClientProvider } from "./types.ts";
import type { OperatorEventFeed } from "./operator-feed.ts";
import { buildAgentSessionPlanForIssue } from "./agent-session-plan.ts";
import { buildAgentSessionExternalUrls } from "./agent-session-presentation.ts";
import { computeLinearActivityKey } from "./linear-activity-key.ts";
import { sharedLinearWriteBackoff, type LinearWriteBackoff } from "./linear-rate-limit.ts";

const WRITER = "linear-agent-session-client";

export class LinearAgentSessionClient {
  constructor(
    private readonly config: AppConfig,
    private readonly db: PatchRelayDatabase,
    private readonly linearProvider: LinearClientProvider,
    private readonly logger: Logger,
    private readonly feed?: OperatorEventFeed,
    private readonly linearBackoff: LinearWriteBackoff = sharedLinearWriteBackoff,
  ) {}

  ensureAgentSessionIssue(issue: IssueRecord): IssueRecord {
    if (issue.agentSessionId) {
      return issue;
    }

    const recoveredAgentSessionId = this.db.webhookEvents.findLatestAgentSessionIdForIssue(issue.linearIssueId);
    if (!recoveredAgentSessionId) return issue;

    this.logger.info({ issueKey: issue.issueKey, agentSessionId: recoveredAgentSessionId }, "Recovered missing Linear agent session id from webhook history");
    const commit = this.db.issueSessions.commitIssueState({
      writer: WRITER,
      update: {
        projectId: issue.projectId,
        linearIssueId: issue.linearIssueId,
        agentSessionId: recoveredAgentSessionId,
      },
    });
    return commit.outcome === "applied" ? commit.issue : issue;
  }

  async emitActivity(
    issue: IssueRecord,
    content: LinearAgentActivityContent,
    options?: { ephemeral?: boolean },
  ): Promise<void> {
    const syncedIssue = this.ensureAgentSessionIssue(issue);
    if (!syncedIssue.agentSessionId) return;
    if (!this.linearBackoff.shouldAttempt(syncedIssue.projectId)) {
      this.logger.debug({ issueKey: syncedIssue.issueKey }, "Skipping Linear activity during rate-limit backoff");
      return;
    }
    try {
      const linear = await this.linearProvider.forProject(syncedIssue.projectId);
      if (!linear) return;
      const allowEphemeral = content.type === "thought" || content.type === "action";
      const ephemeral = options?.ephemeral && allowEphemeral;
      const activityKey = ephemeral ? undefined : computeLinearActivityKey(content);
      if (activityKey && syncedIssue.lastLinearActivityKey === activityKey) {
        return;
      }
      await linear.createAgentActivity({
        agentSessionId: syncedIssue.agentSessionId,
        content,
        ...(ephemeral ? { ephemeral: true } : {}),
      });
      if (activityKey) {
        this.db.issueSessions.commitIssueState({
          writer: WRITER,
          update: {
            projectId: syncedIssue.projectId,
            linearIssueId: syncedIssue.linearIssueId,
            lastLinearActivityKey: activityKey,
          },
        });
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.linearBackoff.noteError(syncedIssue.projectId, error);
      this.logger.warn({ issueKey: syncedIssue.issueKey, type: content.type, error: msg }, "Failed to emit Linear activity");
      this.feed?.publish({
        level: "warn",
        kind: "linear",
        issueKey: syncedIssue.issueKey,
        projectId: syncedIssue.projectId,
        status: "linear_error",
        summary: `Linear activity failed: ${msg}`,
      });
    }
  }

  async syncSessionPlan(
    issue: IssueRecord,
    linear: NonNullable<Awaited<ReturnType<LinearClientProvider["forProject"]>>>,
    options?: { activeRunType?: RunType },
  ): Promise<void> {
    if (!issue.agentSessionId || !linear.updateAgentSession) {
      return;
    }
    const externalUrls = buildAgentSessionExternalUrls(this.config, {
      ...(issue.issueKey ? { issueKey: issue.issueKey } : {}),
      ...(issue.prUrl ? { prUrl: issue.prUrl } : {}),
      ...(issue.activeRunId !== undefined ? { activeRunId: issue.activeRunId } : {}),
      ...(issue.prReviewState ? { prReviewState: issue.prReviewState } : {}),
      ...(issue.prCheckStatus ? { prCheckStatus: issue.prCheckStatus } : {}),
      ...(issue.lastGitHubFailureSource ? { lastGitHubFailureSource: issue.lastGitHubFailureSource } : {}),
      ...(issue.lastGitHubFailureCheckName ? { lastGitHubFailureCheckName: issue.lastGitHubFailureCheckName } : {}),
      ...(issue.lastGitHubFailureCheckUrl ? { lastGitHubFailureCheckUrl: issue.lastGitHubFailureCheckUrl } : {}),
      ...(issue.lastQueueIncidentJson ? { lastQueueIncidentJson: issue.lastQueueIncidentJson } : {}),
    });
    await linear.updateAgentSession({
      agentSessionId: issue.agentSessionId,
      plan: buildAgentSessionPlanForIssue(issue, options),
      ...(externalUrls ? { externalUrls } : {}),
    });
  }

  async syncCodexPlan(issue: IssueRecord, params: Record<string, unknown>): Promise<void> {
    const syncedIssue = this.ensureAgentSessionIssue(issue);
    if (!syncedIssue.agentSessionId) return;
    if (!this.linearBackoff.shouldAttempt(syncedIssue.projectId)) {
      this.logger.debug({ issueKey: syncedIssue.issueKey }, "Skipping Linear codex plan sync during rate-limit backoff");
      return;
    }
    const plan = params.plan;
    if (!Array.isArray(plan)) return;

    const STATUS_MAP: Record<string, "pending" | "inProgress" | "completed"> = {
      pending: "pending",
      inProgress: "inProgress",
      completed: "completed",
    };

    const steps = plan.map((entry) => {
      const e = entry as Record<string, unknown>;
      const step = typeof e.step === "string" ? e.step : String(e.step ?? "");
      const status = typeof e.status === "string" ? (STATUS_MAP[e.status] ?? "pending") : "pending";
      return { content: step, status };
    });

    const fullPlan = [
      { content: "Prepare workspace", status: "completed" as const },
      ...steps,
      { content: "Merge", status: "pending" as const },
    ];

    try {
      const linear = await this.linearProvider.forProject(syncedIssue.projectId);
      if (!linear?.updateAgentSession) return;
      await linear.updateAgentSession({
        agentSessionId: syncedIssue.agentSessionId,
        plan: fullPlan,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.linearBackoff.noteError(syncedIssue.projectId, error);
      this.logger.warn({ issueKey: syncedIssue.issueKey, error: msg }, "Failed to sync codex plan to Linear");
    }
  }
}
