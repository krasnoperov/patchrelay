import type { Logger } from "pino";
import type { CodexThreadSummary } from "./types.ts";
import type { IssueRecord, RunRecord } from "./db-types.ts";
import type { FactoryState, RunType } from "./factory-state.ts";
import type { PatchRelayDatabase } from "./db.ts";
import type { ReleaseIssueSessionLease, WithHeldIssueSessionLease } from "./issue-session-lease-service.ts";
import type { LinearSessionSync } from "./linear-session-sync.ts";
import type { OperatorEventFeed } from "./operator-feed.ts";
import { buildStageReport, countEventMethods } from "./run-reporting.ts";
import type { AppendWakeEventWithLease } from "./run-wake-planner.ts";
import { buildRunCompletedActivity, buildRunFailureActivity } from "./linear-session-reporting.ts";

interface PostRunFollowUp {
  pendingRunType: RunType;
  factoryState: FactoryState;
  context?: Record<string, unknown> | undefined;
  summary: string;
}

export class RunFinalizer {
  constructor(
    private readonly db: PatchRelayDatabase,
    private readonly logger: Logger,
    private readonly linearSync: LinearSessionSync,
    private readonly enqueueIssue: (projectId: string, issueId: string) => void,
    private readonly feed?: OperatorEventFeed,
  ) {}

  async finalizeCompletedRun(params: {
    source: "notification" | "reconciliation";
    run: RunRecord;
    issue: IssueRecord;
    thread: CodexThreadSummary;
    threadId: string;
    completedTurnId?: string;
    withHeldLease: WithHeldIssueSessionLease;
    releaseLease: ReleaseIssueSessionLease;
    failRunAndClear: (run: RunRecord, message: string, nextState?: FactoryState) => void;
    verifyReactiveRunAdvancedBranch: (run: RunRecord, issue: IssueRecord) => Promise<string | undefined>;
    verifyReviewFixAdvancedHead: (run: RunRecord, issue: IssueRecord) => Promise<string | undefined>;
    verifyPublishedRunOutcome: (run: RunRecord, issue: IssueRecord) => Promise<string | undefined>;
    refreshIssueAfterReactivePublish: (run: RunRecord, issue: IssueRecord) => Promise<IssueRecord>;
    resolvePostRunFollowUp: (run: Pick<RunRecord, "runType" | "projectId">, issue: IssueRecord) => Promise<PostRunFollowUp | undefined>;
    resolveCompletedRunState: (issue: IssueRecord, run: Pick<RunRecord, "runType" | "promptText">) => FactoryState | undefined;
    resolveRecoverableRunState: (issue: IssueRecord) => FactoryState | undefined;
    appendWakeEventWithLease: AppendWakeEventWithLease;
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
    const verifiedRepairError = await params.verifyReactiveRunAdvancedBranch(run, freshIssue);
    if (verifiedRepairError) {
      const holdState = params.resolveRecoverableRunState(freshIssue) ?? "failed";
      params.failRunAndClear(run, verifiedRepairError, holdState);
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
      params.releaseLease(run.projectId, run.linearIssueId);
      return;
    }

    const missingReviewFixHeadError = await params.verifyReviewFixAdvancedHead(run, freshIssue);
    if (missingReviewFixHeadError) {
      params.failRunAndClear(run, missingReviewFixHeadError, "escalated");
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
      params.releaseLease(run.projectId, run.linearIssueId);
      return;
    }

    const publishedOutcomeError = await params.verifyPublishedRunOutcome(run, freshIssue);
    if (publishedOutcomeError) {
      params.failRunAndClear(run, publishedOutcomeError, "failed");
      const failedIssue = this.db.issues.getIssue(run.projectId, run.linearIssueId) ?? freshIssue;
      this.feed?.publish({
        level: "warn",
        kind: "turn",
        issueKey: freshIssue.issueKey,
        projectId: run.projectId,
        stage: run.runType,
        status: "publish_incomplete",
        summary: publishedOutcomeError,
      });
      void this.linearSync.emitActivity(failedIssue, buildRunFailureActivity(run.runType, publishedOutcomeError));
      void this.linearSync.syncSession(failedIssue, { activeRunType: run.runType });
      this.linearSync.clearProgress(run.id);
      if (params.source === "notification") {
        params.releaseLease(run.projectId, run.linearIssueId);
      }
      return;
    }

    const refreshedIssue = await params.refreshIssueAfterReactivePublish(run, freshIssue);
    const postRunFollowUp = await params.resolvePostRunFollowUp(run, refreshedIssue);
    const postRunState = postRunFollowUp?.factoryState ?? params.resolveCompletedRunState(refreshedIssue, run);

    const completed = params.withHeldLease(run.projectId, run.linearIssueId, (lease) => {
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
        return params.appendWakeEventWithLease(
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
      params.releaseLease(run.projectId, run.linearIssueId);
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
    void this.linearSync.emitActivity(updatedIssue, buildRunCompletedActivity({
      runType: run.runType,
      completionSummary,
      postRunState: updatedIssue.factoryState,
      ...(updatedIssue.prNumber !== undefined ? { prNumber: updatedIssue.prNumber } : {}),
    }));
    void this.linearSync.syncSession(updatedIssue);
    this.linearSync.clearProgress(run.id);
    params.releaseLease(run.projectId, run.linearIssueId);
  }
}
