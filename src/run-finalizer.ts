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
      const heldIssue = this.db.issues.getIssue(run.projectId, run.linearIssueId) ?? freshIssue;
      this.feed?.publish({
        level: "warn",
        kind: "turn",
        issueKey: freshIssue.issueKey,
        projectId: run.projectId,
        stage: run.runType,
        status: "branch_not_advanced",
        summary: verifiedRepairError,
      });
      void this.linearSync.emitActivity(heldIssue, buildRunFailureActivity(run.runType, verifiedRepairError));
      void this.linearSync.syncSession(heldIssue, { activeRunType: run.runType });
      this.linearSync.clearProgress(run.id);
      this.releaseLease(run.projectId, run.linearIssueId);
      return;
    }

    const missingReviewFixHeadError = await this.completionPolicy.verifyReviewFixAdvancedHead(run, freshIssue);
    if (missingReviewFixHeadError) {
      this.failRunAndClear(run, missingReviewFixHeadError, "escalated");
      const failedIssue = this.db.issues.getIssue(run.projectId, run.linearIssueId) ?? freshIssue;
      this.feed?.publish({
        level: "error",
        kind: "turn",
        issueKey: freshIssue.issueKey,
        projectId: run.projectId,
        stage: run.runType,
        status: "same_head_review_handoff_blocked",
        summary: missingReviewFixHeadError,
      });
      void this.linearSync.emitActivity(failedIssue, buildRunFailureActivity(run.runType, missingReviewFixHeadError));
      void this.linearSync.syncSession(failedIssue, { activeRunType: run.runType });
      this.linearSync.clearProgress(run.id);
      this.releaseLease(run.projectId, run.linearIssueId);
      return;
    }

    const publishedOutcomeError = await this.completionPolicy.verifyPublishedRunOutcome(run, freshIssue);
    if (publishedOutcomeError) {
      this.feed?.publish({
        level: "info",
        kind: "turn",
        issueKey: freshIssue.issueKey,
        projectId: run.projectId,
        stage: run.runType,
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
        this.failRunAndClear(run, `No PR observed and the completion check failed: ${message}`, "failed");
        const failedIssue = this.db.issues.getIssue(run.projectId, run.linearIssueId) ?? freshIssue;
        this.feed?.publish({
          level: "error",
          kind: "turn",
          issueKey: freshIssue.issueKey,
          projectId: run.projectId,
          stage: run.runType,
          status: "completion_check_failed",
          summary: "No PR found; completion check failed",
          detail: message,
        });
        void this.linearSync.emitActivity(failedIssue, buildRunFailureActivity(run.runType, `No PR observed and the completion check failed: ${message}`));
        void this.linearSync.syncSession(failedIssue, { activeRunType: run.runType });
        this.clearProgressAndRelease(run);
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
        const continuedIssue = this.db.issues.getIssue(run.projectId, run.linearIssueId) ?? freshIssue;
        this.feed?.publish({
          level: "info",
          kind: "turn",
          issueKey: freshIssue.issueKey,
          projectId: run.projectId,
          stage: run.runType,
          status: "completion_check_continue",
          summary: "No PR found; continuing automatically",
          detail: completionCheck.summary,
        });
        void this.linearSync.emitActivity(continuedIssue, buildCompletionCheckActivity("continue"), { ephemeral: true });
        void this.linearSync.syncSession(continuedIssue);
        this.linearSync.clearProgress(run.id);
        this.enqueueIssue(run.projectId, run.linearIssueId);
        this.releaseLease(run.projectId, run.linearIssueId);
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
        const awaitingIssue = this.db.issues.getIssue(run.projectId, run.linearIssueId) ?? freshIssue;
        this.feed?.publish({
          level: "warn",
          kind: "turn",
          issueKey: freshIssue.issueKey,
          projectId: run.projectId,
          stage: run.runType,
          status: "completion_check_needs_input",
          summary: "No PR found; waiting for answer",
          detail: completionCheck.question ?? completionCheck.summary,
        });
        void this.linearSync.emitActivity(awaitingIssue, buildCompletionCheckActivity("needs_input", completionCheck));
        void this.linearSync.syncSession(awaitingIssue);
        this.clearProgressAndRelease(run);
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
        const doneIssue = this.db.issues.getIssue(run.projectId, run.linearIssueId) ?? freshIssue;
        this.feed?.publish({
          level: "info",
          kind: "turn",
          issueKey: freshIssue.issueKey,
          projectId: run.projectId,
          stage: run.runType,
          status: "completion_check_done",
          summary: "No PR found; confirmed done",
          detail: completionCheck.summary,
        });
        void this.linearSync.emitActivity(doneIssue, buildCompletionCheckActivity("done", completionCheck));
        void this.linearSync.syncSession(doneIssue);
        this.clearProgressAndRelease(run);
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
      const failedIssue = this.db.issues.getIssue(run.projectId, run.linearIssueId) ?? freshIssue;
      this.feed?.publish({
        level: "warn",
        kind: "turn",
        issueKey: freshIssue.issueKey,
        projectId: run.projectId,
        stage: run.runType,
        status: "completion_check_failed",
        summary: "No PR found; completion check failed",
        detail: completionCheck.summary,
      });
      void this.linearSync.emitActivity(failedIssue, buildRunFailureActivity(run.runType, failureReason));
      void this.linearSync.syncSession(failedIssue, { activeRunType: run.runType });
      this.clearProgressAndRelease(run);
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

    this.feed?.publish({
      level: "info",
      kind: "turn",
      issueKey: issue.issueKey,
      projectId: run.projectId,
      stage: run.runType,
      status: "completed",
      summary: params.source === "notification"
        ? `Turn completed for ${run.runType}`
        : `Reconciliation: ${run.runType} completed${postRunState ? ` -> ${postRunState}` : ""}`,
      ...(report.assistantMessages.at(-1) ? { detail: report.assistantMessages.at(-1) } : {}),
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
