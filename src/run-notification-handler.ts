import type { Logger } from "pino";
import type { CodexNotification } from "./codex-app-server.ts";
import type { PatchRelayDatabase } from "./db.ts";
import type { IssueRecord, RunRecord } from "./db-types.ts";
import type { FactoryState } from "./factory-state.ts";
import { buildRunFailureActivity } from "./linear-session-reporting.ts";
import type { LinearSessionSync } from "./linear-session-sync.ts";
import type { OperatorEventFeed } from "./operator-feed.ts";
import { extractTurnId, resolveRunCompletionStatus } from "./run-reporting.ts";
import type { CodexThreadSummary } from "./types.ts";
import type { RunFinalizer } from "./run-finalizer.ts";
import { resolveRecoverablePostRunState } from "./interrupted-run-recovery.ts";
import { resolveFailureFactoryState } from "./reactive-pr-state.ts";

const DEFAULT_PUBLISH_COMMAND_TIMEOUT_MS = 10 * 60 * 1000;

interface RunNotificationHandlerOptions {
  interruptTurn?: ((options: { threadId: string; turnId: string }) => Promise<void>) | undefined;
  publishCommandTimeoutMs?: number | undefined;
}

export class RunNotificationHandler {
  private activeThreadId: string | undefined;
  private readonly publishCommandWatchdogs = new Map<string, ReturnType<typeof setTimeout>>();

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
    private readonly options: RunNotificationHandlerOptions = {},
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
    if (run.status !== "running") {
      this.logger.info({ runId: run.id, status: run.status, issueId: run.linearIssueId }, "Ignoring Codex notification for inactive run");
      return;
    }
    if (!this.heartbeatIssueSessionLease(run.projectId, run.linearIssueId)) {
      this.logger.warn({ runId: run.id, issueId: run.linearIssueId }, "Ignoring Codex notification after losing issue-session lease");
      return;
    }

    const turnId = typeof notification.params.turnId === "string" ? notification.params.turnId : undefined;
    this.observePublishCommand(notification, run, threadId, turnId ?? run.turnId);
    if (this.config.runner.codex.persistExtendedHistory) {
      this.db.runs.saveThreadEvent({
        runId: run.id,
        threadId,
        ...(turnId ? { turnId } : {}),
        method: notification.method,
        eventJson: JSON.stringify(notification.params),
      });
    }

    this.maybeEmitProgress(notification, run);

    if (notification.method === "turn/plan/updated") {
      this.syncCodexPlan(notification, run);
    }

    if (notification.method !== "turn/completed") return;
    this.clearPublishWatchdogsForThread(threadId);

    const thread = await this.readThreadWithRetry(threadId);
    const issue = this.db.issues.getIssue(run.projectId, run.linearIssueId);
    if (!issue) return;

    const completedTurnId = extractTurnId(notification.params);
    const status = resolveRunCompletionStatus(notification.params);

    if (status === "failed") {
      const failureReason = "Codex reported the turn completed in a failed state";
      const recovered = await this.runFinalizer.recoverFailedImplementationRun({
        run,
        issue,
        thread,
        threadId,
        ...(completedTurnId ? { completedTurnId } : {}),
        failureReason,
      });
      if (recovered) {
        this.activeThreadId = undefined;
        return;
      }

      const nextState: FactoryState = resolveFailureFactoryState(run.runType);
      const updated = this.withHeldIssueSessionLease(run.projectId, run.linearIssueId, (lease) => {
        this.db.issueSessions.finishRunWithLease(lease, run.id, {
          status: "failed",
          threadId,
          ...(completedTurnId ? { turnId: completedTurnId } : {}),
          failureReason,
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

  private observePublishCommand(
    notification: CodexNotification,
    run: RunRecord,
    threadId: string,
    turnId: string | undefined,
  ): void {
    const item = notification.params.item;
    if (!item || typeof item !== "object") {
      return;
    }
    const itemRecord = item as Record<string, unknown>;
    const itemId = typeof itemRecord.id === "string" ? itemRecord.id : undefined;
    if (!itemId) {
      return;
    }

    if (notification.method === "item/completed" || isTerminalItemUpdate(notification.method, itemRecord)) {
      this.clearPublishWatchdog(threadId, itemId);
      return;
    }

    if (notification.method !== "item/started" || itemRecord.type !== "commandExecution" || !turnId || !this.options.interruptTurn) {
      return;
    }

    const command = extractCommandText(itemRecord.command);
    if (!command || !isGitPushCommand(command)) {
      return;
    }

    const key = publishWatchdogKey(threadId, itemId);
    if (this.publishCommandWatchdogs.has(key)) {
      return;
    }

    const timeoutMs = this.options.publishCommandTimeoutMs ?? DEFAULT_PUBLISH_COMMAND_TIMEOUT_MS;
    const timer = setTimeout(() => {
      this.publishCommandWatchdogs.delete(key);
      this.logger.warn(
        { runId: run.id, projectId: run.projectId, issueId: run.linearIssueId, threadId, turnId, timeoutMs },
        "Interrupting stuck git push command",
      );
      this.feed?.publish({
        level: "error",
        kind: "turn",
        projectId: run.projectId,
        stage: run.runType,
        status: "interrupted",
        summary: `Interrupted stuck publish command after ${Math.round(timeoutMs / 1000)}s`,
      });
      void this.options.interruptTurn?.({ threadId, turnId }).catch((error) => {
        this.logger.warn(
          { runId: run.id, projectId: run.projectId, issueId: run.linearIssueId, threadId, turnId, error: formatError(error) },
          "Failed to interrupt stuck git push command",
        );
      });
    }, timeoutMs);
    timer.unref?.();
    this.publishCommandWatchdogs.set(key, timer);
  }

  private clearPublishWatchdog(threadId: string, itemId: string): void {
    const key = publishWatchdogKey(threadId, itemId);
    const timer = this.publishCommandWatchdogs.get(key);
    if (!timer) {
      return;
    }
    clearTimeout(timer);
    this.publishCommandWatchdogs.delete(key);
  }

  private clearPublishWatchdogsForThread(threadId: string): void {
    for (const [key, timer] of this.publishCommandWatchdogs) {
      if (!key.startsWith(`${threadId}:`)) {
        continue;
      }
      clearTimeout(timer);
      this.publishCommandWatchdogs.delete(key);
    }
  }

  private maybeEmitProgress(notification: CodexNotification, run: RunRecord): void {
    try {
      this.linearSync.maybeEmitProgress(notification, run);
    } catch (error) {
      this.logger.warn(
        { runId: run.id, projectId: run.projectId, issueId: run.linearIssueId, method: notification.method, error: formatError(error) },
        "Linear progress reporting failed",
      );
    }
  }

  private syncCodexPlan(notification: CodexNotification, run: RunRecord): void {
    let issue: IssueRecord | undefined;
    try {
      issue = this.db.issues.getIssue(run.projectId, run.linearIssueId);
    } catch (error) {
      this.logger.warn(
        { runId: run.id, projectId: run.projectId, issueId: run.linearIssueId, method: notification.method, error: formatError(error) },
        "Linear plan sync lookup failed",
      );
      return;
    }
    if (!issue) return;

    try {
      void this.linearSync.syncCodexPlan(issue, notification.params).catch((error) => {
        this.logger.warn(
          { runId: run.id, issueKey: issue.issueKey, projectId: run.projectId, issueId: run.linearIssueId, method: notification.method, error: formatError(error) },
          "Linear plan sync failed",
        );
      });
    } catch (error) {
      this.logger.warn(
        { runId: run.id, issueKey: issue.issueKey, projectId: run.projectId, issueId: run.linearIssueId, method: notification.method, error: formatError(error) },
        "Linear plan sync failed",
      );
    }
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function publishWatchdogKey(threadId: string, itemId: string): string {
  return `${threadId}:${itemId}`;
}

function extractCommandText(command: unknown): string | undefined {
  if (typeof command === "string") {
    return command;
  }
  if (Array.isArray(command)) {
    return command.map((entry) => String(entry)).join(" ");
  }
  return undefined;
}

function isGitPushCommand(command: string): boolean {
  const normalized = command.replace(/\s+/g, " ").trim();
  return /(?:^|[;&|({\s])git(?:\s+-C\s+\S+)?\s+push(?:\s|$)/.test(normalized);
}

function isTerminalItemUpdate(method: string, item: Record<string, unknown>): boolean {
  if (method !== "item/updated") {
    return false;
  }
  const status = typeof item.status === "string" ? item.status.toLowerCase() : "";
  return status === "completed" || status === "failed" || status === "cancelled" || status === "canceled";
}
