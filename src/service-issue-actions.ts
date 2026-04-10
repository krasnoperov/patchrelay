import type { Logger } from "pino";
import type { CodexAppServerClient } from "./codex-app-server.ts";
import type { PatchRelayDatabase } from "./db.ts";
import type { IssueRecord } from "./db-types.ts";
import type { OperatorEventFeed } from "./operator-feed.ts";
import type { ServiceRuntime } from "./service-runtime.ts";
import { buildOperatorRetryEvent } from "./tracked-issue-list-query.ts";

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
