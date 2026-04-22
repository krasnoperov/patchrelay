import type { Logger } from "pino";
import type { CompletionCheckExecution } from "./completion-check.ts";
import type { PublicationRecapFacts, PublicationRecapResult } from "./publication-recap.ts";
import type { CodexThreadSummary } from "./types.ts";
import type { IssueRecord, IssueSessionEventRecord, RunRecord } from "./db-types.ts";
import type { FactoryState, RunType } from "./factory-state.ts";
import type { PatchRelayDatabase } from "./db.ts";
import type { ReleaseIssueSessionLease, WithHeldIssueSessionLease } from "./issue-session-lease-service.ts";
import type { LinearSessionSync } from "./linear-session-sync.ts";
import type { OperatorEventFeed } from "./operator-feed.ts";
import { buildStageReport, countEventMethods } from "./run-reporting.ts";
import type { AppendWakeEventWithLease } from "./run-wake-planner.ts";
import type { buildCompletionCheckActivity } from "./linear-session-reporting.ts";
import { buildRunCompletedActivity, buildRunFailureActivity } from "./linear-session-reporting.ts";
import { handleNoPrCompletionCheck } from "./no-pr-completion-check.ts";
import type { RunCompletionPolicy } from "./run-completion-policy.ts";
import { resolveCompletedRunState } from "./run-completion-policy.ts";

type StageReport = ReturnType<typeof buildStageReport>;

function parseEventJson(eventJson?: string): Record<string, unknown> | undefined {
  if (!eventJson) return undefined;
  try {
    const parsed = JSON.parse(eventJson) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function buildRunSummaryJson(report: StageReport, publicationRecapSummary?: string): string {
  return JSON.stringify({
    latestAssistantMessage: report.assistantMessages.at(-1) ?? null,
    publicationRecapSummary: publicationRecapSummary ?? null,
  });
}

function shouldGeneratePublicationRecap(runType: RunType): boolean {
  return runType === "implementation"
    || runType === "review_fix"
    || runType === "branch_upkeep"
    || runType === "ci_repair"
    || runType === "queue_repair";
}

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
    private readonly publicationRecap?: {
      run(params: {
        issue: Pick<IssueRecord, "issueKey" | "linearIssueId" | "title" | "description">;
        run: Pick<RunRecord, "id" | "threadId" | "runType" | "failureReason" | "summaryJson" | "reportJson">;
        facts?: PublicationRecapFacts;
      }): Promise<PublicationRecapResult>;
    },
    private readonly feed?: OperatorEventFeed,
  ) {}

  private buildCompletedRunUpdate(
    params: {
      threadId: string;
      completedTurnId?: string | undefined;
      report: StageReport;
      publicationRecapSummary?: string | undefined;
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
      summaryJson: buildRunSummaryJson(params.report, params.publicationRecapSummary),
      reportJson: JSON.stringify(params.report),
    };
  }

  private resolveConsumedWakeEvent(run: Pick<RunRecord, "id" | "projectId" | "linearIssueId">): IssueSessionEventRecord | undefined {
    return this.db.issueSessions
      .listIssueSessionEvents(run.projectId, run.linearIssueId)
      .filter((event) => event.consumedByRunId === run.id)
      .at(-1);
  }

  private resolvePublicationRecapFacts(params: {
    run: Pick<RunRecord, "id" | "projectId" | "linearIssueId">;
    issue: Pick<IssueRecord, "prNumber">;
    postRunState?: FactoryState | undefined;
    latestAssistantSummary?: string | undefined;
  }): PublicationRecapFacts {
    const session = this.db.issueSessions.getIssueSession(params.run.projectId, params.run.linearIssueId);
    const facts: PublicationRecapFacts = {
      ...(session?.lastWakeReason ? { wakeReason: session.lastWakeReason } : {}),
      ...(params.postRunState ? { postRunState: params.postRunState } : {}),
      ...(params.issue.prNumber !== undefined ? { prNumber: params.issue.prNumber } : {}),
      ...(params.latestAssistantSummary ? { latestAssistantSummary: params.latestAssistantSummary } : {}),
    };

    const wakeEvent = this.resolveConsumedWakeEvent(params.run);
    const payload = parseEventJson(wakeEvent?.eventJson);
    if (!wakeEvent || !payload) {
      return facts;
    }

    switch (wakeEvent.eventType) {
      case "review_changes_requested":
        return {
          ...facts,
          ...(typeof payload.reviewerName === "string" ? { reviewerName: payload.reviewerName } : {}),
          ...(typeof payload.reviewBody === "string" ? { reviewSummary: payload.reviewBody } : {}),
        };
      case "settled_red_ci":
        return {
          ...facts,
          ...(typeof payload.jobName === "string"
            ? { failingCheckName: payload.jobName }
            : typeof payload.checkName === "string" ? { failingCheckName: payload.checkName } : {}),
          ...(typeof payload.summary === "string" ? { failureSummary: payload.summary } : {}),
        };
      case "merge_steward_incident":
        return {
          ...facts,
          ...(typeof payload.incidentSummary === "string" ? { queueIncidentSummary: payload.incidentSummary } : {}),
        };
      default:
        return facts;
    }
  }

  private async generatePublicationRecap(params: {
    run: Pick<RunRecord, "id" | "threadId" | "runType" | "failureReason" | "summaryJson" | "reportJson" | "projectId" | "linearIssueId">;
    issue: Pick<IssueRecord, "issueKey" | "linearIssueId" | "title" | "description" | "prNumber">;
    postRunState?: FactoryState | undefined;
    latestAssistantSummary?: string | undefined;
  }): Promise<string | undefined> {
    if (!this.publicationRecap || !shouldGeneratePublicationRecap(params.run.runType)) {
      return undefined;
    }

    try {
      const result = await this.publicationRecap.run({
        issue: params.issue,
        run: params.run,
        facts: this.resolvePublicationRecapFacts({
          run: params.run,
          issue: params.issue,
          postRunState: params.postRunState,
          latestAssistantSummary: params.latestAssistantSummary,
        }),
      });
      return result.summary;
    } catch (error) {
      this.logger.warn(
        {
          runId: params.run.id,
          issueKey: params.issue.issueKey,
          error: error instanceof Error ? error.message : String(error),
        },
        "Publication recap failed; falling back to the main run summary",
      );
      return undefined;
    }
  }

  private clearProgressAndRelease(run: Pick<RunRecord, "id" | "projectId" | "linearIssueId">): void {
    this.linearSync.clearProgress(run.id);
    this.releaseLease(run.projectId, run.linearIssueId);
  }

  private enqueuePendingWakeIfPresent(params: {
    run: Pick<RunRecord, "projectId" | "linearIssueId" | "runType">;
    issueKey?: string | undefined;
  }): { runType: RunType; wakeReason?: string | undefined } | undefined {
    const wake = this.db.issueSessions.peekIssueSessionWake(params.run.projectId, params.run.linearIssueId);
    if (!wake) return undefined;
    this.enqueueIssue(params.run.projectId, params.run.linearIssueId);
    this.feed?.publish({
      level: "info",
      kind: "stage",
      issueKey: params.issueKey,
      projectId: params.run.projectId,
      stage: wake.runType,
      status: "deferred_follow_up_queued",
      summary: `${wake.runType} queued after ${params.run.runType} released authority`,
      ...(wake.wakeReason ? { detail: `wake reason: ${wake.wakeReason}` } : {}),
    });
    return {
      runType: wake.runType,
      ...(wake.wakeReason ? { wakeReason: wake.wakeReason } : {}),
    };
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
    detail?: string | undefined;
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
    detail?: string | undefined;
    activity: ReturnType<typeof buildCompletionCheckActivity>;
    enqueue?: boolean | undefined;
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
      await handleNoPrCompletionCheck({
        db: this.db,
        logger: this.logger,
        withHeldLease: this.withHeldLease,
        completionCheck: this.completionCheck,
        run,
        issue: freshIssue,
        report,
        runStatus: "completed",
        threadId,
        ...(params.completedTurnId ? { completedTurnId: params.completedTurnId } : {}),
        publishedOutcomeError,
        failRunAndClear: this.failRunAndClear,
        emitActivity: (issueRecord, activity, options) => this.linearSync.emitActivity(issueRecord, activity, options),
        publishTurnEvent: (event) => this.publishTurnEvent(event),
        syncFailureOutcome: (event) => this.syncFailureOutcome(event),
        syncCompletionCheckOutcome: (event) => this.syncCompletionCheckOutcome(event),
        clearProgressAndRelease: (releaseRun) => this.clearProgressAndRelease(releaseRun),
      });
      return;
    }

    const refreshedIssue = await this.completionPolicy.refreshIssueAfterReactivePublish(run, freshIssue);
    const postRunFollowUp = await this.completionPolicy.resolvePostRunFollowUp(run, refreshedIssue);
    const postRunState = postRunFollowUp?.factoryState ?? resolveCompletedRunState(refreshedIssue, run);
    const publicationRecapSummary = await this.generatePublicationRecap({
      run,
      issue: refreshedIssue,
      postRunState,
      latestAssistantSummary: report.assistantMessages.at(-1),
    });

    const completed = this.withHeldLease(run.projectId, run.linearIssueId, (lease) => {
      this.db.runs.finishRun(run.id, this.buildCompletedRunUpdate({
        threadId,
        ...(params.completedTurnId ? { completedTurnId: params.completedTurnId } : {}),
        report,
        publicationRecapSummary,
      }));
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
              lastAttemptedFailureAt: null,
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
    }

    this.publishTurnEvent({
      level: "info",
      run,
      issueKey: issue.issueKey,
      status: "completed",
      summary: params.source === "notification"
        ? `Turn completed for ${run.runType}`
        : `Reconciliation: ${run.runType} completed${postRunState ? ` -> ${postRunState}` : ""}`,
      detail: publicationRecapSummary ?? report.assistantMessages.at(-1),
    });

    const updatedIssue = this.db.issues.getIssue(run.projectId, run.linearIssueId) ?? refreshedIssue;
    const completionSummary = publicationRecapSummary
      ?? report.assistantMessages.at(-1)?.slice(0, 300)
      ?? `${run.runType} completed.`;
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
    this.enqueuePendingWakeIfPresent({ run, issueKey: updatedIssue.issueKey });
    this.linearSync.clearProgress(run.id);
    this.releaseLease(run.projectId, run.linearIssueId);
  }

  async recoverFailedImplementationRun(params: {
    run: RunRecord;
    issue: IssueRecord;
    thread: CodexThreadSummary;
    threadId: string;
    completedTurnId?: string;
    failureReason: string;
  }): Promise<boolean> {
    const freshIssue = this.db.issues.getIssue(params.run.projectId, params.run.linearIssueId) ?? params.issue;
    const publishedOutcomeError = await this.completionPolicy.detectRecoverableFailedImplementationOutcome(params.run, freshIssue);
    if (!publishedOutcomeError) {
      return false;
    }

    const trackedIssue = this.db.issueToTrackedIssue(freshIssue);
    const report = buildStageReport(
      { ...params.run, status: "failed" },
      trackedIssue,
      params.thread,
      countEventMethods(this.db.runs.listThreadEvents(params.run.id)),
    );

    await handleNoPrCompletionCheck({
      db: this.db,
      logger: this.logger,
      withHeldLease: this.withHeldLease,
      completionCheck: this.completionCheck,
      run: params.run,
      issue: freshIssue,
      report,
      runStatus: "failed",
      threadId: params.threadId,
      ...(params.completedTurnId ? { completedTurnId: params.completedTurnId } : {}),
      failureReason: params.failureReason,
      publishedOutcomeError,
      failRunAndClear: this.failRunAndClear,
      emitActivity: (issueRecord, activity, options) => this.linearSync.emitActivity(issueRecord, activity, options),
      publishTurnEvent: (event) => this.publishTurnEvent(event),
      syncFailureOutcome: (event) => this.syncFailureOutcome(event),
      syncCompletionCheckOutcome: (event) => this.syncCompletionCheckOutcome(event),
      clearProgressAndRelease: (releaseRun) => this.clearProgressAndRelease(releaseRun),
    });
    return true;
  }
}
