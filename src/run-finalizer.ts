import type { Logger } from "pino";
import type { CompletionCheckExecution } from "./completion-check.ts";
import type { CodexThreadSummary } from "./types.ts";
import type { IssueRecord, IssueSessionEventRecord, RunRecord } from "./db-types.ts";
import type { FactoryState } from "./factory-state.ts";
import { CLEARED_FAILURE_PROVENANCE } from "./failure-provenance.ts";
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
import { computeChangeIdentityFromWorktree } from "./change-identity.ts";
import type { WakeDispatcher } from "./wake-dispatcher.ts";
import { inspectGitWorktreeStatus, isRepairRunType, type GitWorktreeStatus } from "./git-worktree-status.ts";
import { buildRunOutcomeSummary, type RunOutcomeFacts } from "./run-outcome-summary.ts";

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

function buildRunSummaryJson(report: StageReport, outcomeSummary?: string): string {
  return JSON.stringify({
    latestAssistantMessage: report.assistantMessages.at(-1) ?? null,
    outcomeSummary: outcomeSummary ?? null,
    // Backward compatibility for older CLI/status readers.
    publicationRecapSummary: outcomeSummary ?? null,
  });
}

function summarizePromptDeliveryEvents(
  events: IssueSessionEventRecord[],
  run: Pick<RunRecord, "id">,
): { delivered: number; failed: number } {
  let delivered = 0;
  let failed = 0;
  for (const event of events) {
    if (event.eventType !== "prompt_delivered") continue;
    const payload = parseEventJson(event.eventJson);
    if (payload?.runId !== run.id) continue;
    if (payload.status === "delivered") {
      delivered += 1;
    } else if (payload.status === "delivery_failed") {
      failed += 1;
    }
  }
  return { delivered, failed };
}

export class RunFinalizer {
  constructor(
    private readonly db: PatchRelayDatabase,
    private readonly logger: Logger,
    private readonly linearSync: LinearSessionSync,
    private readonly wakeDispatcher: WakeDispatcher,
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
      completedTurnId?: string | undefined;
      report: StageReport;
      outcomeSummary?: string | undefined;
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
      summaryJson: buildRunSummaryJson(params.report, params.outcomeSummary),
      reportJson: JSON.stringify(params.report),
    };
  }

  private resolveConsumedWakeEvent(run: Pick<RunRecord, "id" | "projectId" | "linearIssueId">): IssueSessionEventRecord | undefined {
    return this.db.issueSessions
      .listIssueSessionEvents(run.projectId, run.linearIssueId)
      .filter((event) => event.consumedByRunId === run.id)
      .at(-1);
  }

  private resolveRunOutcomeFacts(params: {
    run: Pick<RunRecord, "id" | "projectId" | "linearIssueId">;
    issue: Pick<IssueRecord, "prNumber">;
    postRunState?: FactoryState | undefined;
    latestAssistantSummary?: string | undefined;
  }): RunOutcomeFacts {
    const session = this.db.issueSessions.getIssueSession(params.run.projectId, params.run.linearIssueId);
    const facts: RunOutcomeFacts = {
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

  private buildOutcomeSummary(params: {
    run: Pick<RunRecord, "id" | "runType" | "projectId" | "linearIssueId">;
    issue: Pick<IssueRecord, "prNumber">;
    postRunState?: FactoryState | undefined;
    latestAssistantSummary?: string | undefined;
  }): string {
    return buildRunOutcomeSummary({
      runType: params.run.runType,
      facts: this.resolveRunOutcomeFacts({
        run: params.run,
        issue: params.issue,
        postRunState: params.postRunState,
        latestAssistantSummary: params.latestAssistantSummary,
      }),
    });
  }

  // Plan §4.2(c): record the identity of the head we just published
  // so subsequent runs can recognize a patch-id-equivalent re-push.
  // Only fires when the current head SHA is observably different from
  // the run's starting sourceHeadSha — a no-op publish would not
  // advance the head.
  private maybeUpdateLastPublishedIdentity(
    run: RunRecord,
    issue: IssueRecord,
  ): void {
    if (!issue.worktreePath || !issue.prHeadSha) return;
    if (run.sourceHeadSha && run.sourceHeadSha === issue.prHeadSha) return;
    if (issue.lastPublishedHeadSha === issue.prHeadSha) return;
    const identity = computeChangeIdentityFromWorktree({
      worktreePath: issue.worktreePath,
      baseRef: "origin/main",
      headSha: issue.prHeadSha,
    });
    if (!identity.patchId && !identity.integrationTreeId) return;
    this.db.issues.upsertIssue({
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      ...(identity.patchId ? { lastPublishedPatchId: identity.patchId } : {}),
      ...(identity.integrationTreeId ? { lastPublishedIntegrationTreeId: identity.integrationTreeId } : {}),
      lastPublishedHeadSha: issue.prHeadSha,
    });
    this.logger.info(
      {
        issueKey: issue.issueKey,
        prHeadSha: issue.prHeadSha,
        patchId: identity.patchId,
      },
      "Recorded last-published change identity after run completion",
    );
  }

  // Single owner of "clear Linear progress + release lease + drain pending
  // wake". Every run-end path goes through here. Routes the release through
  // the WakeDispatcher so a wake that landed during the run is picked up
  // even on failure paths (the previous implementation only drained on the
  // success path). Failure and completion-check paths publish their own
  // more-specific operator-feed event before getting here, so the
  // dispatcher's "deferred_follow_up_queued" notification is opt-in via
  // `publishDeferredFollowUp` and used only by the success path.
  private clearProgressAndRelease(
    run: Pick<RunRecord, "id" | "projectId" | "linearIssueId" | "runType">,
    options?: { issueKey?: string | undefined; publishDeferredFollowUp?: boolean },
  ): void {
    this.linearSync.clearProgress(run.id);
    this.wakeDispatcher.releaseRunAndDispatch({
      run,
      ...(options?.issueKey ? { issueKey: options.issueKey } : {}),
      ...(options?.publishDeferredFollowUp ? { publishDeferredFollowUp: true } : {}),
    });
  }

  // Plan §4.4: finalize a run that was superseded mid-flight. The
  // status row was already moved to `superseded` by the trigger
  // observer; this just makes sure the issue's activeRunId is
  // cleared, the lease is released, and the operator sees a
  // clean recap event. No publication, no follow-up enqueue —
  // the approval that triggered supersedure already advanced the
  // factoryState.
  private releaseSupersededRun(
    run: RunRecord,
    threadId: string,
    completedTurnId: string | undefined,
  ): void {
    this.withHeldLease(run.projectId, run.linearIssueId, () => {
      this.db.runs.finishRun(run.id, {
        status: "superseded",
        threadId,
        ...(completedTurnId ? { turnId: completedTurnId } : {}),
        failureReason: run.failureReason ?? "approved on the same head; further publication suppressed",
      });
      this.db.issues.upsertIssue({
        projectId: run.projectId,
        linearIssueId: run.linearIssueId,
        activeRunId: null,
        pendingRunType: null,
        pendingRunContextJson: null,
      });
    });
    this.clearProgressAndRelease(run);
    this.feed?.publish({
      level: "info",
      kind: "agent",
      summary: `Run #${run.id} superseded — publication suppressed (approved on the same head)`,
      ...(run.projectId ? { projectId: run.projectId } : {}),
    });
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
    // releaseRunAndDispatch always drains any pending wake — the
    // explicit `params.enqueue` flag is no longer needed because the
    // dispatcher peeks the wake itself and only enqueues when one
    // exists. Keeping the parameter would be redundant.
    this.clearProgressAndRelease(params.run);
  }

  private inspectDirtyRepairWorktree(run: RunRecord, issue: IssueRecord): GitWorktreeStatus | undefined {
    if (!isRepairRunType(run.runType) || !issue.worktreePath) return undefined;
    const status = inspectGitWorktreeStatus(issue.worktreePath);
    if (!status.dirty) return undefined;
    return status;
  }

  private continueDirtyRepairWorktree(params: {
    run: RunRecord;
    issue: IssueRecord;
    status: GitWorktreeStatus;
    threadId: string;
    completedTurnId?: string | undefined;
    report: StageReport;
  }): void {
    const message = params.status.summary
      ? `Repair run finished with a dirty worktree; ${params.status.summary}`
      : "Repair run finished with a dirty worktree";
    const outcomeSummary = "Repair left unpublished local changes; continuing automatically to publish them.";
    const continued = this.withHeldLease(params.run.projectId, params.run.linearIssueId, (lease) => {
      this.db.runs.finishRun(params.run.id, this.buildCompletedRunUpdate({
        threadId: params.threadId,
        ...(params.completedTurnId ? { completedTurnId: params.completedTurnId } : {}),
        report: params.report,
        outcomeSummary,
      }));
      this.db.issueSessions.upsertIssueWithLease(lease, {
        projectId: params.run.projectId,
        linearIssueId: params.run.linearIssueId,
        activeRunId: null,
        factoryState: "delegated",
        pendingRunType: null,
        pendingRunContextJson: null,
        ...(params.run.runType === "ci_repair" && params.issue.ciRepairAttempts > 0
          ? { ciRepairAttempts: params.issue.ciRepairAttempts - 1 }
          : {}),
        ...(params.run.runType === "queue_repair" && params.issue.queueRepairAttempts > 0
          ? { queueRepairAttempts: params.issue.queueRepairAttempts - 1 }
          : {}),
        ...((params.run.runType === "review_fix" || params.run.runType === "branch_upkeep") && params.issue.reviewFixAttempts > 0
          ? { reviewFixAttempts: params.issue.reviewFixAttempts - 1 }
          : {}),
      });
      return Boolean(this.db.issueSessions.appendIssueSessionEventWithLease(lease, {
        projectId: params.run.projectId,
        linearIssueId: params.run.linearIssueId,
        eventType: "completion_check_continue",
        eventJson: JSON.stringify({
          runType: params.run.runType,
          summary: message,
          preserveDirtyWorktree: true,
          dirtyWorktreeSummary: params.status.summary,
          dirtyWorktreeChangedPaths: params.status.changedPaths,
          dirtyWorktreeMergeInProgress: params.status.mergeInProgress,
        }),
        dedupeKey: `dirty_repair_continue:${params.run.id}`,
      }));
    });

    if (!continued) {
      this.logger.warn({ runId: params.run.id, issueId: params.run.linearIssueId }, "Skipping dirty-repair continuation after losing issue-session lease");
      this.clearProgressAndRelease(params.run);
      return;
    }

    this.publishTurnEvent({
      level: "warn",
      run: params.run,
      issueKey: params.issue.issueKey,
      status: "dirty_repair_continue",
      summary: "Repair left unpublished local changes; continuing automatically",
      detail: message,
    });
    void this.linearSync.emitActivity(params.issue, {
      type: "thought",
      body: "PatchRelay found unpublished repair changes and is continuing automatically to commit and push them.",
    }, { ephemeral: true });
    void this.linearSync.syncSession(params.issue, { activeRunType: params.run.runType });
    this.clearProgressAndRelease(params.run);
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

    // Plan §4.4: a run flagged shouldNotPublish was deliberately
    // superseded mid-flight (the PR was approved on the same head
    // while a review_fix run was still producing output). The Codex
    // turn may have completed; the finalizer must NOT run any of
    // the publication-verification policies — they all assume the
    // run was supposed to publish, and would either fail it
    // spuriously (`verifyReviewFixAdvancedHead`) or open new
    // follow-up work. Just record the supersedure outcome and
    // release the lease.
    if (run.shouldNotPublish || run.status === "superseded") {
      this.releaseSupersededRun(run, threadId, params.completedTurnId);
      return;
    }

    const trackedIssue = this.db.issueToTrackedIssue(issue);
    const report = buildStageReport(
      { ...run, status: "completed" },
      trackedIssue,
      thread,
      countEventMethods(this.db.runs.listThreadEvents(run.id)),
    );

    const freshIssue = this.db.issues.getIssue(run.projectId, run.linearIssueId) ?? issue;
    const dirtyRepairWorktree = this.inspectDirtyRepairWorktree(run, freshIssue);
    if (dirtyRepairWorktree) {
      this.continueDirtyRepairWorktree({
        run,
        issue: freshIssue,
        status: dirtyRepairWorktree,
        threadId,
        ...(params.completedTurnId ? { completedTurnId: params.completedTurnId } : {}),
        report,
      });
      return;
    }

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

    const reactiveScopeError = await this.completionPolicy.verifyReactiveRunStayedInScope(run, freshIssue);
    if (reactiveScopeError) {
      this.failRunAndClear(run, reactiveScopeError, "escalated");
      this.syncFailureOutcome({
        run,
        fallbackIssue: freshIssue,
        message: reactiveScopeError,
        level: "error",
        status: "reactive_scope_drift_blocked",
        summary: reactiveScopeError,
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
        wakeDispatcher: this.wakeDispatcher,
      });
      return;
    }

    const refreshedIssue = await this.completionPolicy.refreshIssueAfterReactivePublish(run, freshIssue);
    // Plan §4.2(c): post-hoc change-identity detection. When the run
    // produced a new head SHA, compute and persist the patch-id and
    // integration-tree-id so the next run's prompt rule can recognize
    // a patch-id-equivalent re-push and skip the publish. Best-effort:
    // any git error returns undefined and we leave the cache as-is.
    this.maybeUpdateLastPublishedIdentity(run, refreshedIssue);
    const postRunFollowUp = await this.completionPolicy.resolvePostRunFollowUp(run, refreshedIssue);
    const postRunState = postRunFollowUp?.factoryState ?? resolveCompletedRunState(refreshedIssue, run);
    const outcomeSummary = this.buildOutcomeSummary({
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
        outcomeSummary,
      }));
      this.db.issues.upsertIssue({
        projectId: run.projectId,
        linearIssueId: run.linearIssueId,
        activeRunId: null,
        ...(postRunState ? { factoryState: postRunState } : {}),
        pendingRunType: null,
        pendingRunContextJson: null,
        ...(postRunFollowUp ? {} : (postRunState === "awaiting_queue" || postRunState === "done"
          ? { ...CLEARED_FAILURE_PROVENANCE }
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
      this.clearProgressAndRelease(run);
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
      detail: outcomeSummary,
    });

    const updatedIssue = this.db.issues.getIssue(run.projectId, run.linearIssueId) ?? refreshedIssue;
    const completionSummary = outcomeSummary;
    const steeringSummary = summarizePromptDeliveryEvents(
      this.db.issueSessions.listIssueSessionEvents(run.projectId, run.linearIssueId),
      run,
    );
    const linearActivity = buildRunCompletedActivity({
      runType: run.runType,
      completionSummary,
      postRunState: updatedIssue.factoryState,
      ...(updatedIssue.prNumber !== undefined ? { prNumber: updatedIssue.prNumber } : {}),
      ...(run.runType === "review_fix" ? { reviewRound: Math.max(1, updatedIssue.reviewFixAttempts) } : {}),
      ...(steeringSummary.delivered > 0 ? { steeringDeliveredCount: steeringSummary.delivered } : {}),
      ...(steeringSummary.failed > 0 ? { steeringFailedCount: steeringSummary.failed } : {}),
    });
    if (linearActivity) {
      void this.linearSync.emitActivity(updatedIssue, linearActivity);
    }
    void this.linearSync.syncSession(updatedIssue);
    this.clearProgressAndRelease(run, {
      ...(updatedIssue.issueKey ? { issueKey: updatedIssue.issueKey } : {}),
      publishDeferredFollowUp: true,
    });
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
      wakeDispatcher: this.wakeDispatcher,
    });
    return true;
  }
}
