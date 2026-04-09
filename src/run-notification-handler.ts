import type { Logger } from "pino";
import type { CodexNotification } from "./codex-app-server.ts";
import type { PatchRelayDatabase } from "./db.ts";
import type { FactoryState, RunType } from "./factory-state.ts";
import { buildRunFailureActivity } from "./linear-session-reporting.ts";
import type { LinearSessionSync } from "./linear-session-sync.ts";
import type { OperatorEventFeed } from "./operator-feed.ts";
import { extractTurnId, resolveRunCompletionStatus } from "./run-reporting.ts";
import type { CodexThreadSummary } from "./types.ts";
import type { RunFinalizer } from "./run-finalizer.ts";
import { resolveRecoverablePostRunState } from "./interrupted-run-recovery.ts";

function isRequestedChangesRunType(runType: RunType): boolean {
  return runType === "review_fix" || runType === "branch_upkeep";
}

export class RunNotificationHandler {
  private activeThreadId: string | undefined;

  constructor(
    private readonly config: { runner: { codex: { persistExtendedHistory: boolean } } },
    private readonly db: PatchRelayDatabase,
    private readonly logger: Logger,
    private readonly linearSync: LinearSessionSync,
    private readonly runFinalizer: RunFinalizer,
    private readonly readThreadWithRetry: (threadId: string, maxRetries?: number) => Promise<CodexThreadSummary>,
    private readonly withHeldIssueSessionLease: <T>(
      projectId: string,
      linearIssueId: string,
      fn: (lease: { projectId: string; linearIssueId: string; leaseId: string }) => T,
    ) => T | undefined,
    private readonly heartbeatIssueSessionLease: (projectId: string, linearIssueId: string) => boolean,
    private readonly releaseIssueSessionLease: (projectId: string, linearIssueId: string) => void,
    private readonly feed?: OperatorEventFeed,
  ) {}

  async handle(notification: CodexNotification): Promise<void> {
    let threadId = typeof notification.params.threadId === "string" ? notification.params.threadId : undefined;
    if (!threadId) {
      threadId = this.activeThreadId;
    }
    if (!threadId) return;

    if (notification.method === "turn/started") {
      this.activeThreadId = threadId;
    }

    const run = this.db.runs.getRunByThreadId(threadId);
    if (!run) return;
    if (!this.heartbeatIssueSessionLease(run.projectId, run.linearIssueId)) {
      this.logger.warn({ runId: run.id, issueId: run.linearIssueId }, "Ignoring Codex notification after losing issue-session lease");
      return;
    }

    const turnId = typeof notification.params.turnId === "string" ? notification.params.turnId : undefined;
    if (this.config.runner.codex.persistExtendedHistory) {
      this.db.runs.saveThreadEvent({
        runId: run.id,
        threadId,
        ...(turnId ? { turnId } : {}),
        method: notification.method,
        eventJson: JSON.stringify(notification.params),
      });
    }

    this.linearSync.maybeEmitProgress(notification, run);

    if (notification.method === "turn/plan/updated") {
      const issue = this.db.issues.getIssue(run.projectId, run.linearIssueId);
      if (issue) {
        void this.linearSync.syncCodexPlan(issue, notification.params);
      }
    }

    if (notification.method !== "turn/completed") return;

    const thread = await this.readThreadWithRetry(threadId);
    const issue = this.db.issues.getIssue(run.projectId, run.linearIssueId);
    if (!issue) return;

    const completedTurnId = extractTurnId(notification.params);
    const status = resolveRunCompletionStatus(notification.params);

    if (status === "failed") {
      const nextState: FactoryState = isRequestedChangesRunType(run.runType) ? "escalated" : "failed";
      const updated = this.withHeldIssueSessionLease(run.projectId, run.linearIssueId, (lease) => {
        this.db.issueSessions.finishRunWithLease(lease, run.id, {
          status: "failed",
          threadId,
          ...(completedTurnId ? { turnId: completedTurnId } : {}),
          failureReason: "Codex reported the turn completed in a failed state",
        });
        this.db.issueSessions.upsertIssueWithLease(lease, {
          projectId: run.projectId,
          linearIssueId: run.linearIssueId,
          activeRunId: null,
          factoryState: nextState,
        });
        return true;
      });
      if (!updated) {
        this.logger.warn({ runId: run.id, issueId: run.linearIssueId }, "Skipping failed-turn cleanup after losing issue-session lease");
        this.releaseIssueSessionLease(run.projectId, run.linearIssueId);
        return;
      }
      this.feed?.publish({
        level: "error",
        kind: "turn",
        issueKey: issue.issueKey,
        projectId: run.projectId,
        stage: run.runType,
        status: "failed",
        summary: `Turn failed for ${run.runType}`,
      });
      const failedIssue = this.db.issues.getIssue(run.projectId, run.linearIssueId) ?? issue;
      void this.linearSync.emitActivity(failedIssue, buildRunFailureActivity(run.runType));
      void this.linearSync.syncSession(failedIssue, { activeRunType: run.runType });
      this.linearSync.clearProgress(run.id);
      this.activeThreadId = undefined;
      this.releaseIssueSessionLease(run.projectId, run.linearIssueId);
      return;
    }

    await this.runFinalizer.finalizeCompletedRun({
      source: "notification",
      run,
      issue,
      thread,
      threadId,
      ...(completedTurnId ? { completedTurnId } : {}),
      resolveRecoverableRunState: resolveRecoverablePostRunState,
    });
    this.activeThreadId = undefined;
  }
}
