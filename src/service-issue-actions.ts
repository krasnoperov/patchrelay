import type { Logger } from "pino";
import type { CodexAppServerClient } from "./codex-app-server.ts";
import type { PatchRelayDatabase } from "./db.ts";
import type { IssueRecord } from "./db-types.ts";
import { buildOperatorRetryEvent } from "./operator-retry-event.ts";
import { buildManualRetryAttemptReset, resolveRetryTarget } from "./manual-issue-actions.ts";
import type { OperatorEventFeed } from "./operator-feed.ts";
import type { ServiceRuntime } from "./service-runtime.ts";

export class ServiceIssueActions {
  constructor(
    private readonly db: PatchRelayDatabase,
    private readonly codex: CodexAppServerClient,
    private readonly runtime: ServiceRuntime,
    private readonly feed: OperatorEventFeed,
    private readonly logger: Logger,
  ) {}

  async promptIssue(
    issueKey: string,
    text: string,
    source: string = "watch",
  ): Promise<{ delivered: boolean; queued?: boolean } | { error: string } | undefined> {
    const issue = this.db.issues.getIssueByKey(issueKey);
    if (!issue) return undefined;
    if (!issue.delegatedToPatchRelay && !issue.activeRunId) {
      return { error: "Issue is undelegated from PatchRelay; delegate it again before prompting work" };
    }

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

    if (!issue.activeRunId) {
      this.queueOperatorPrompt(issue, text, source);
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
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.warn({ issueKey, error: msg }, "steerTurn failed, queuing prompt for next run");
      this.queueOperatorPrompt(issue, text, source);
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
        // Turn may already be done.
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
    if (!issue.delegatedToPatchRelay) return { error: "Issue is undelegated from PatchRelay; delegate it again before retrying" };
    if (issue.activeRunId) return { error: "Issue already has an active run" };
    const issueSession = this.db.issueSessions.getIssueSession(issue.projectId, issue.linearIssueId);
    const retryTarget = resolveRetryTarget({
      prNumber: issue.prNumber,
      prState: issue.prState,
      prReviewState: issue.prReviewState,
      prCheckStatus: issue.prCheckStatus,
      pendingRunType: issue.pendingRunType,
      lastRunType: issueSession?.lastRunType,
      lastGitHubFailureSource: issue.lastGitHubFailureSource,
    });

    if (retryTarget.runType === "none") {
      this.db.issueSessions.upsertIssueRespectingActiveLease(issue.projectId, issue.linearIssueId, {
        projectId: issue.projectId,
        linearIssueId: issue.linearIssueId,
        factoryState: "done" as never,
      });
      return { issueKey, runType: "none" };
    }

    this.appendOperatorRetryEvent(issue, retryTarget.runType);
    this.db.issueSessions.upsertIssueRespectingActiveLease(issue.projectId, issue.linearIssueId, {
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      factoryState: retryTarget.factoryState as never,
      ...buildManualRetryAttemptReset(retryTarget.runType),
    });
    this.feed.publish({
      level: "info",
      kind: "stage",
      issueKey: issue.issueKey,
      projectId: issue.projectId,
      stage: retryTarget.factoryState,
      status: "retry",
      summary: `Retry queued: ${retryTarget.runType}`,
    });
    if (this.db.issueSessions.peekIssueSessionWake(issue.projectId, issue.linearIssueId)) {
      this.runtime.enqueueIssue(issue.projectId, issue.linearIssueId);
    }
    return { issueKey, runType: retryTarget.runType };
  }

  async closeIssue(
    issueKey: string,
    options?: { failed?: boolean; reason?: string },
  ): Promise<{ issueKey: string; factoryState: "done" | "failed"; releasedRunId?: number } | { error: string } | undefined> {
    const issue = this.db.issues.getIssueByKey(issueKey);
    if (!issue) return undefined;

    const terminalState = options?.failed ? "failed" : "done";
    const run = issue.activeRunId ? this.db.runs.getRunById(issue.activeRunId) : undefined;

    if (run?.threadId && run.turnId) {
      try {
        await this.codex.steerTurn({
          threadId: run.threadId,
          turnId: run.turnId,
          input: `STOP: The operator manually closed this issue in PatchRelay as ${terminalState}. Stop working immediately and exit without making further changes.`,
        });
      } catch {
        // The turn may already be settled.
      }
    }

    this.db.issueSessions.appendIssueSessionEventRespectingActiveLease(issue.projectId, issue.linearIssueId, {
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      eventType: "operator_closed",
      eventJson: JSON.stringify({
        terminalState,
        ...(options?.reason ? { reason: options.reason } : {}),
      }),
      dedupeKey: `operator_closed:${issue.linearIssueId}:${terminalState}:${issue.activeRunId ?? "no-run"}`,
    });
    this.db.issueSessions.clearPendingIssueSessionEventsRespectingActiveLease(issue.projectId, issue.linearIssueId);
    if (run) {
      this.db.issueSessions.finishRunRespectingActiveLease(issue.projectId, issue.linearIssueId, run.id, {
        status: "released",
        failureReason: options?.reason
          ? `Operator closed issue as ${terminalState}: ${options.reason}`
          : `Operator closed issue as ${terminalState}`,
      });
    }
    this.db.issueSessions.upsertIssueRespectingActiveLease(issue.projectId, issue.linearIssueId, {
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      delegatedToPatchRelay: false,
      factoryState: terminalState as never,
      activeRunId: null,
      pendingRunType: null,
      pendingRunContextJson: null,
    });
    this.db.issueSessions.releaseIssueSessionLeaseRespectingActiveLease(issue.projectId, issue.linearIssueId);

    this.feed.publish({
      level: terminalState === "failed" ? "warn" : "info",
      kind: "workflow",
      issueKey: issue.issueKey,
      projectId: issue.projectId,
      stage: terminalState,
      status: "operator_closed",
      summary: options?.reason
        ? `Operator closed issue as ${terminalState}: ${options.reason}`
        : `Operator closed issue as ${terminalState}`,
    });

    return {
      issueKey,
      factoryState: terminalState,
      ...(run ? { releasedRunId: run.id } : {}),
    };
  }

  private queueOperatorPrompt(issue: IssueRecord, text: string, source: string): void {
    this.db.issueSessions.appendIssueSessionEventRespectingActiveLease(issue.projectId, issue.linearIssueId, {
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      eventType: "operator_prompt",
      eventJson: JSON.stringify({ text, source }),
    });
    this.runtime.enqueueIssue(issue.projectId, issue.linearIssueId);
  }

  private appendOperatorRetryEvent(issue: IssueRecord, runType: string): void {
    this.db.issueSessions.appendIssueSessionEventRespectingActiveLease(issue.projectId, issue.linearIssueId, {
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      ...buildOperatorRetryEvent(issue, runType),
    });
  }
}
