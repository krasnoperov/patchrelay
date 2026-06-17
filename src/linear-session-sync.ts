import type { Logger } from "pino";
import type { PatchRelayDatabase } from "./db.ts";
import type { IssueRecord, RunRecord } from "./db-types.ts";
import type { RunType } from "./factory-state.ts";
import type { AppConfig, LinearAgentActivityContent, LinearClientProvider } from "./types.ts";
import type { OperatorEventFeed } from "./operator-feed.ts";
import {
  collapseVisibleStatusComment,
  shouldSyncVisibleIssueComment,
  syncVisibleStatusComment,
} from "./linear-status-comment-sync.ts";
import { LinearAgentSessionClient } from "./linear-agent-session-client.ts";
import { LinearProgressReporter } from "./linear-progress-reporter.ts";
import { syncActiveWorkflowState } from "./linear-workflow-state-sync.ts";
import { sharedLinearWriteBackoff, type LinearWriteBackoff } from "./linear-rate-limit.ts";

export class LinearSessionSync {
  private readonly agentSessions: LinearAgentSessionClient;
  private readonly progressReporter: LinearProgressReporter;

  constructor(
    private readonly config: AppConfig,
    private readonly db: PatchRelayDatabase,
    private readonly linearProvider: LinearClientProvider,
    private readonly logger: Logger,
    private readonly feed?: OperatorEventFeed,
    private readonly linearBackoff: LinearWriteBackoff = sharedLinearWriteBackoff,
  ) {
    this.agentSessions = new LinearAgentSessionClient(config, db, linearProvider, logger, feed, linearBackoff);
    this.progressReporter = new LinearProgressReporter(db, (issue, content, options) =>
      this.agentSessions.emitActivity(issue, content, options)
    );
  }

  async emitActivity(
    issue: IssueRecord,
    content: LinearAgentActivityContent,
    options?: { ephemeral?: boolean },
  ): Promise<void> {
    await this.agentSessions.emitActivity(issue, content, options);
  }

  async syncSession(issue: IssueRecord, options?: { activeRunType?: RunType }): Promise<void> {
    const syncedIssue = this.agentSessions.ensureAgentSessionIssue(issue);
    if (!this.linearBackoff.shouldAttempt(syncedIssue.projectId)) {
      this.logger.debug({ issueKey: syncedIssue.issueKey }, "Skipping Linear session sync during rate-limit backoff");
      return;
    }
    try {
      const linear = await this.linearProvider.forProject(syncedIssue.projectId);
      if (!linear) return;
      const trackedIssue = this.db.getTrackedIssue(syncedIssue.projectId, syncedIssue.linearIssueId);
      const visibleIssue = trackedIssue
        ? {
            ...trackedIssue,
            delegatedToPatchRelay: syncedIssue.delegatedToPatchRelay,
            prNumber: syncedIssue.prNumber,
            prUrl: syncedIssue.prUrl,
          }
        : syncedIssue;
      const project = this.config.projects.find((p) => p.id === syncedIssue.projectId);
      await syncActiveWorkflowState({
        db: this.db,
        issue: syncedIssue,
        linear,
        ...(trackedIssue ? { trackedIssue } : {}),
        ...(options ? { options } : {}),
        ...(project ? { project } : {}),
      });
      await this.agentSessions.syncSessionPlan(syncedIssue, linear, options);
      if (shouldSyncVisibleIssueComment(visibleIssue, Boolean(syncedIssue.agentSessionId))) {
        await syncVisibleStatusComment({
          db: this.db,
          issue: syncedIssue,
          linear,
          logger: this.logger,
          ...(trackedIssue ? { trackedIssue } : {}),
          ...(options ? { options } : {}),
        });
      } else if (syncedIssue.statusCommentId) {
        await collapseVisibleStatusComment({
          issue: syncedIssue,
          linear,
          logger: this.logger,
        });
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.linearBackoff.noteError(syncedIssue.projectId, error);
      this.logger.warn({ issueKey: syncedIssue.issueKey, error: msg }, "Failed to update Linear plan");
    }
  }

  async syncCodexPlan(issue: IssueRecord, params: Record<string, unknown>): Promise<void> {
    await this.agentSessions.syncCodexPlan(issue, params);
  }

  maybeEmitProgress(notification: { method: string; params: Record<string, unknown> }, run: RunRecord): void {
    this.progressReporter.maybeEmitProgress(notification, run);
  }

  clearProgress(runId: number): void {
    this.progressReporter.clearProgress(runId);
  }
}
