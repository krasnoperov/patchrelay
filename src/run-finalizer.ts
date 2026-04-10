import type { Logger } from "pino";
import type { CompletionCheckExecution } from "./completion-check.ts";
import type { CodexThreadSummary } from "./types.ts";
import type { IssueRecord, RunRecord } from "./db-types.ts";
import type { FactoryState } from "./factory-state.ts";
import type { PatchRelayDatabase } from "./db.ts";
import type { ReleaseIssueSessionLease, WithHeldIssueSessionLease } from "./issue-session-lease-service.ts";
import type { LinearSessionSync } from "./linear-session-sync.ts";
import type { OperatorEventFeed } from "./operator-feed.ts";
import { buildStageReport, countEventMethods } from "./run-reporting.ts";
import type { AppendWakeEventWithLease } from "./run-wake-planner.ts";
import { buildCompletionCheckActivity, buildRunCompletedActivity, buildRunFailureActivity } from "./linear-session-reporting.ts";
import type { RunCompletionPolicy } from "./run-completion-policy.ts";
import { resolveCompletedRunState } from "./run-completion-policy.ts";

export class RunFinalizer {
  constructor(
    private readonly db: PatchRelayDatabase,
    private readonly logger: Logger,
    private readonly linearSync: LinearSessionSync,
    private readonly enqueueIssue: (projectId: string, issueId: string) => void,
    private readonly withHeldLease: WithHeldIssueSessionLease,
    private readonly releaseLease: ReleaseIssueSessionLease,
    private readonly appendWakeEventWithLease: AppendWakeEventWithLease,
    private readonly failRunAndClear: (run: RunRecord, message: string, nextState?: FactoryState) => void,
    private readonly completionPolicy: RunCompletionPolicy,
    private readonly completionCheck: {
      run(params: {
        issue: Pick<IssueRecord, "issueKey" | "linearIssueId" | "title" | "description" | "worktreePath">;
        run: Pick<RunRecord, "id" | "threadId" | "runType" | "failureReason" | "summaryJson" | "reportJson">;
        noPrSummary: string;
        onStarted?: ((start: { threadId: string; turnId: string }) => void | Promise<void>) | undefined;
      }): Promise<CompletionCheckExecution>;
    },
    private readonly feed?: OperatorEventFeed,
  ) {}

  private buildCompletedRunUpdate(
    params: {
      threadId: string;
      completedTurnId?: string;
      report: ReturnType<typeof buildStageReport>;
    },
  ): {
    status: "completed";
    threadId: string;
    turnId?: string;
    summaryJson: string;
    reportJson: string;
  } {
    return {
      status: "completed",
      threadId: params.threadId,
      ...(params.completedTurnId ? { turnId: params.completedTurnId } : {}),
      summaryJson: JSON.stringify({ latestAssistantMessage: params.report.assistantMessages.at(-1) ?? null }),
      reportJson: JSON.stringify(params.report),
    };
  }

  private clearProgressAndRelease(run: Pick<RunRecord, "id" | "projectId" | "linearIssueId">): void {
    this.linearSync.clearProgress(run.id);
    this.releaseLease(run.projectId, run.linearIssueId);
  }

  private publishTurnEvent(params: {
    level: "info" | "warn" | "error";
    run: Pick<RunRecord, "projectId" | "runType">;
    issueKey?: string | undefined;
    status: string;
    summary: string;
    detail?: string | undefined;
  }): void {
    this.feed?.publish({
      level: params.level,
      kind: "turn",
      issueKey: params.issueKey,
      projectId: params.run.projectId,
      stage: params.run.runType,
      status: params.status,
      summary: params.summary,
      ...(params.detail ? { detail: params.detail } : {}),
    });
  }

  private syncFailureOutcome(params: {
    run: RunRecord;
    fallbackIssue: IssueRecord;
    message: string;
    level: "warn" | "error";
    status: string;
    summary: string;
    detail?: string;
  }): void {
    const issue = this.db.issues.getIssue(params.run.projectId, params.run.linearIssueId) ?? params.fallbackIssue;
    this.publishTurnEvent({
      level: params.level,
      run: params.run,
      issueKey: params.fallbackIssue.issueKey,
      status: params.status,
      summary: params.summary,
      ...(params.detail ? { detail: params.detail } : {}),
    });
    void this.linearSync.emitActivity(issue, buildRunFailureActivity(params.run.runType, params.message));
    void this.linearSync.syncSession(issue, { activeRunType: params.run.runType });
    this.clearProgressAndRelease(params.run);
  }

  private syncCompletionCheckOutcome(params: {
    run: RunRecord;
    fallbackIssue: IssueRecord;
    level: "info" | "warn";
    status: string;
    summary: string;
    detail?: string;
    activity: ReturnType<typeof buildCompletionCheckActivity>;
    enqueue?: boolean;
  }): void {
    const issue = this.db.issues.getIssue(params.run.projectId, params.run.linearIssueId) ?? params.fallbackIssue;
    this.publishTurnEvent({
      level: params.level,
      run: params.run,
      issueKey: params.fallbackIssue.issueKey,
      status: params.status,
      summary: params.summary,
      ...(params.detail ? { detail: params.detail } : {}),
    });
    void this.linearSync.emitActivity(issue, params.activity, { ephemeral: true });
    void this.linearSync.syncSession(issue);
    this.linearSync.clearProgress(params.run.id);
    if (params.enqueue) {
      this.enqueueIssue(params.run.projectId, params.run.linearIssueId);
    }
    this.releaseLease(params.run.projectId, params.run.linearIssueId);
  }

  async finalizeCompletedRun(params: {
    source: "notification" | "reconciliation";
    run: RunRecord;
    issue: IssueRecord;
    thread: CodexThreadSummary;
    threadId: string;
    completedTurnId?: string;
    resolveRecoverableRunState: (issue: IssueRecord) => FactoryState | undefined;
  }): Promise<void> {
    const { run, issue, thread, threadId } = params;
    const trackedIssue = this.db.issueToTrackedIssue(issue);
    const report = buildStageReport(
      { ...run, status: "completed" },
      trackedIssue,
      thread,
      countEventMethods(this.db.runs.listThreadEvents(run.id)),
    );

    const freshIssue = this.db.issues.getIssue(run.projectId, run.linearIssueId) ?? issue;
    const verifiedRepairError = await this.completionPolicy.verifyReactiveRunAdvancedBranch(run, freshIssue);
    if (verifiedRepairError) {
      const holdState = params.resolveRecoverableRunState(freshIssue) ?? "failed";
      this.failRunAndClear(run, verifiedRepairError, holdState);
      this.syncFailureOutcome({
        run,
        fallbackIssue: freshIssue,
        message: verifiedRepairError,
        level: "warn",
        status: "branch_not_advanced",
        summary: verifiedRepairError,
      });
      return;
    }

    const missingReviewFixHeadError = await this.completionPolicy.verifyReviewFixAdvancedHead(run, freshIssue);
    if (missingReviewFixHeadError) {
      this.failRunAndClear(run, missingReviewFixHeadError, "escalated");
      this.syncFailureOutcome({
        run,
        fallbackIssue: freshIssue,
        message: missingReviewFixHeadError,
        level: "error",
        status: "same_head_review_handoff_blocked",
        summary: missingReviewFixHeadError,
      });
      return;
    }

    const publishedOutcomeError = await this.completionPolicy.verifyPublishedRunOutcome(run, freshIssue);
    if (publishedOutcomeError) {
      this.publishTurnEvent({
        level: "info",
        run,
        issueKey: freshIssue.issueKey,
        status: "completion_check_started",
        summary: "No PR found; checking next step",
        detail: publishedOutcomeError,
      });
      void this.linearSync.emitActivity(freshIssue, buildCompletionCheckActivity("started"), { ephemeral: true });

      let completionCheck: CompletionCheckExecution;
      try {
        completionCheck = await this.completionCheck.run({
          issue: freshIssue,
          run,
          noPrSummary: publishedOutcomeError,
          onStarted: ({ threadId: completionCheckThreadId, turnId: completionCheckTurnId }) => {
            this.db.runs.markCompletionCheckStarted(run.id, {
              threadId: completionCheckThreadId,
              turnId: completionCheckTurnId,
            });
          },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const failureMessage = `No PR observed and the completion check failed: ${message}`;
        this.failRunAndClear(run, failureMessage, "failed");
        this.syncFailureOutcome({
          run,
          fallbackIssue: freshIssue,
          message: failureMessage,
          level: "error",
          status: "completion_check_failed",
          summary: "No PR found; completion check failed",
          detail: message,
        });
        return;
      }

      const completedRunUpdate = this.buildCompletedRunUpdate({
        threadId,
        ...(params.completedTurnId ? { completedTurnId: params.completedTurnId } : {}),
        report,
      });

      if (completionCheck.outcome === "continue") {
        const continued = this.withHeldLease(run.projectId, run.linearIssueId, (lease) => {
          this.db.runs.finishRun(run.id, completedRunUpdate);
          this.db.runs.saveCompletionCheck(run.id, completionCheck);
          this.db.issues.upsertIssue({
            projectId: run.projectId,
            linearIssueId: run.linearIssueId,
            activeRunId: null,
            factoryState: "delegated",
            pendingRunType: null,
            pendingRunContextJson: null,
          });
          return Boolean(this.db.issueSessions.appendIssueSessionEventWithLease(lease, {
            projectId: run.projectId,
            linearIssueId: run.linearIssueId,
            eventType: "completion_check_continue",
            eventJson: JSON.stringify({
              runType: run.runType,
              summary: completionCheck.summary,
            }),
            dedupeKey: `completion_check_continue:${run.id}`,
          }));
        });
        if (!continued) {
          this.logger.warn({ runId: run.id, issueId: run.linearIssueId }, "Skipping completion-check continue writes after losing issue-session lease");
          this.clearProgressAndRelease(run);
          return;
        }
        this.syncCompletionCheckOutcome({
          run,
          fallbackIssue: freshIssue,
          level: "info",
          status: "completion_check_continue",
          summary: "No PR found; continuing automatically",
          detail: completionCheck.summary,
          activity: buildCompletionCheckActivity("continue"),
          enqueue: true,
        });
        return;
      }

      if (completionCheck.outcome === "needs_input") {
        const completed = this.withHeldLease(run.projectId, run.linearIssueId, (lease) => {
          this.db.runs.finishRun(run.id, completedRunUpdate);
          this.db.runs.saveCompletionCheck(run.id, completionCheck);
          this.db.issueSessions.clearPendingIssueSessionEventsWithLease(lease);
          this.db.issues.upsertIssue({
            projectId: run.projectId,
            linearIssueId: run.linearIssueId,
            activeRunId: null,
            factoryState: "awaiting_input",
            pendingRunType: null,
            pendingRunContextJson: null,
          });
          return true;
        });
        if (!completed) {
          this.logger.warn({ runId: run.id, issueId: run.linearIssueId }, "Skipping completion-check needs-input writes after losing issue-session lease");
          this.clearProgressAndRelease(run);
          return;
        }
        this.syncCompletionCheckOutcome({
          run,
          fallbackIssue: freshIssue,
          level: "warn",
          status: "completion_check_needs_input",
          summary: "No PR found; waiting for answer",
          detail: completionCheck.question ?? completionCheck.summary,
          activity: buildCompletionCheckActivity("needs_input", completionCheck),
        });
        return;
      }

      if (completionCheck.outcome === "done") {
        const completed = this.withHeldLease(run.projectId, run.linearIssueId, (lease) => {
          this.db.runs.finishRun(run.id, completedRunUpdate);
          this.db.runs.saveCompletionCheck(run.id, completionCheck);
          this.db.issueSessions.clearPendingIssueSessionEventsWithLease(lease);
          this.db.issues.upsertIssue({
            projectId: run.projectId,
            linearIssueId: run.linearIssueId,
            activeRunId: null,
            factoryState: "done",
            pendingRunType: null,
            pendingRunContextJson: null,
            lastGitHubFailureSource: null,
            lastGitHubFailureHeadSha: null,
            lastGitHubFailureSignature: null,
            lastGitHubFailureCheckName: null,
            lastGitHubFailureCheckUrl: null,
            lastGitHubFailureContextJson: null,
            lastGitHubFailureAt: null,
            lastQueueIncidentJson: null,
            lastAttemptedFailureHeadSha: null,
            lastAttemptedFailureSignature: null,
          });
          return true;
        });
        if (!completed) {
          this.logger.warn({ runId: run.id, issueId: run.linearIssueId }, "Skipping completion-check done writes after losing issue-session lease");
          this.clearProgressAndRelease(run);
          return;
        }
        this.syncCompletionCheckOutcome({
          run,
          fallbackIssue: freshIssue,
          level: "info",
          status: "completion_check_done",
          summary: "No PR found; confirmed done",
          detail: completionCheck.summary,
          activity: buildCompletionCheckActivity("done", completionCheck),
        });
        return;
      }

      const failureReason = `No PR observed and the completion check failed this run: ${completionCheck.summary}`;
      const failed = this.withHeldLease(run.projectId, run.linearIssueId, () => {
        this.db.runs.finishRun(run.id, {
          ...completedRunUpdate,
          status: "failed",
          failureReason,
        });
        this.db.runs.saveCompletionCheck(run.id, completionCheck);
        this.db.issues.upsertIssue({
          projectId: run.projectId,
          linearIssueId: run.linearIssueId,
          activeRunId: null,
          factoryState: "failed",
          pendingRunType: null,
          pendingRunContextJson: null,
        });
        return true;
      });
      if (!failed) {
        this.logger.warn({ runId: run.id, issueId: run.linearIssueId }, "Skipping completion-check failed writes after losing issue-session lease");
        this.clearProgressAndRelease(run);
        return;
      }
      this.syncFailureOutcome({
        run,
        fallbackIssue: freshIssue,
        message: failureReason,
        level: "warn",
        status: "completion_check_failed",
        summary: "No PR found; completion check failed",
        detail: completionCheck.summary,
      });
      return;
    }

    const refreshedIssue = await this.completionPolicy.refreshIssueAfterReactivePublish(run, freshIssue);
    const postRunFollowUp = await this.completionPolicy.resolvePostRunFollowUp(run, refreshedIssue);
    const postRunState = postRunFollowUp?.factoryState ?? resolveCompletedRunState(refreshedIssue, run);

    const completed = this.withHeldLease(run.projectId, run.linearIssueId, (lease) => {
      this.db.runs.finishRun(run.id, {
        status: "completed",
        threadId,
        ...(params.completedTurnId ? { turnId: params.completedTurnId } : {}),
        summaryJson: JSON.stringify({ latestAssistantMessage: report.assistantMessages.at(-1) ?? null }),
        reportJson: JSON.stringify(report),
      });
      this.db.issues.upsertIssue({
        projectId: run.projectId,
        linearIssueId: run.linearIssueId,
        activeRunId: null,
        ...(postRunState ? { factoryState: postRunState } : {}),
        pendingRunType: null,
        pendingRunContextJson: null,
        ...(postRunFollowUp ? {} : (postRunState === "awaiting_queue" || postRunState === "done"
          ? {
              lastGitHubFailureSource: null,
              lastGitHubFailureHeadSha: null,
              lastGitHubFailureSignature: null,
              lastGitHubFailureCheckName: null,
              lastGitHubFailureCheckUrl: null,
              lastGitHubFailureContextJson: null,
              lastGitHubFailureAt: null,
              lastQueueIncidentJson: null,
              lastAttemptedFailureHeadSha: null,
              lastAttemptedFailureSignature: null,
            }
          : {})),
      });
      if (postRunFollowUp) {
        return this.appendWakeEventWithLease(
          lease,
          issue,
          postRunFollowUp.pendingRunType,
          postRunFollowUp.context,
          "post_run",
        );
      }
      return true;
    });
    if (!completed) {
      this.logger.warn({ runId: run.id, issueId: run.linearIssueId }, "Skipping completion writes after losing issue-session lease");
      this.linearSync.clearProgress(run.id);
      this.releaseLease(run.projectId, run.linearIssueId);
      return;
    }

    if (postRunFollowUp) {
      this.feed?.publish({
        level: "info",
        kind: "stage",
        issueKey: issue.issueKey,
        projectId: run.projectId,
        stage: postRunFollowUp.factoryState,
        status: "follow_up_queued",
        summary: postRunFollowUp.summary,
      });
      this.enqueueIssue(run.projectId, run.linearIssueId);
    }

    this.publishTurnEvent({
      level: "info",
      run,
      issueKey: issue.issueKey,
      status: "completed",
      summary: params.source === "notification"
        ? `Turn completed for ${run.runType}`
        : `Reconciliation: ${run.runType} completed${postRunState ? ` -> ${postRunState}` : ""}`,
      detail: report.assistantMessages.at(-1),
    });

    const updatedIssue = this.db.issues.getIssue(run.projectId, run.linearIssueId) ?? refreshedIssue;
    const completionSummary = report.assistantMessages.at(-1)?.slice(0, 300) ?? `${run.runType} completed.`;
    const linearActivity = buildRunCompletedActivity({
      runType: run.runType,
      completionSummary,
      postRunState: updatedIssue.factoryState,
      ...(updatedIssue.prNumber !== undefined ? { prNumber: updatedIssue.prNumber } : {}),
    });
    if (linearActivity) {
      void this.linearSync.emitActivity(updatedIssue, linearActivity);
    }
    void this.linearSync.syncSession(updatedIssue);
    this.linearSync.clearProgress(run.id);
    this.releaseLease(run.projectId, run.linearIssueId);
  }
}
