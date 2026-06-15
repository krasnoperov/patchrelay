import type { Logger } from "pino";
import type { CompletionCheckExecution } from "./completion-check.ts";
import type { CodexThreadSummary } from "./types.ts";
import type { IssueRecord, IssueSessionEventRecord, RunRecord } from "./db-types.ts";
import type { FactoryState } from "./factory-state.ts";
import { parseIssueSessionEventOrWarn } from "./issue-session-events.ts";
import type { RunContext } from "./run-context.ts";
import { assertNever } from "./utils.ts";
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
import { resolvePostRunFactoryState } from "./run-completion-policy.ts";
import { computeChangeIdentityFromWorktree } from "./change-identity.ts";
import type { WakeDispatcher } from "./wake-dispatcher.ts";
import { inspectGitWorktreeStatus, isRepairRunType, type GitWorktreeStatus } from "./git-worktree-status.ts";
import { buildRunOutcomeSummary, type RunOutcomeFacts } from "./run-outcome-summary.ts";
import { settleRun } from "./run-settlement.ts";
import { evaluateTaskCompletion, projectWorkflowSnapshot, type WorkflowTask } from "./workflow-runtime.ts";

type StageReport = ReturnType<typeof buildStageReport>;

const WRITER = "run-finalizer";

function parseObjectJson(raw: string | undefined): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
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
    // Boundary over DB rows: a malformed payload degrades to "not counted".
    const typed = parseIssueSessionEventOrWarn(event);
    if (typed?.eventType !== "prompt_delivered") continue;
    if (typed.payload?.runId !== run.id) continue;
    if (typed.payload.status === "delivered") {
      delivered += 1;
    } else if (typed.payload.status === "delivery_failed") {
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
    if (!wakeEvent) {
      return facts;
    }
    // Boundary over DB rows: a malformed wake payload degrades to bare facts.
    const typed = parseIssueSessionEventOrWarn(
      wakeEvent,
      (message) => this.logger.warn({ runId: params.run.id, eventId: wakeEvent.id }, message),
    );
    if (!typed?.payload) {
      return facts;
    }

    switch (typed.eventType) {
      case "review_changes_requested":
        return {
          ...facts,
          ...(typed.payload.reviewerName !== undefined ? { reviewerName: typed.payload.reviewerName } : {}),
          ...(typed.payload.reviewBody !== undefined ? { reviewSummary: typed.payload.reviewBody } : {}),
        };
      case "settled_red_ci":
        return {
          ...facts,
          ...(typed.payload.jobName !== undefined
            ? { failingCheckName: typed.payload.jobName }
            : typed.payload.checkName !== undefined ? { failingCheckName: typed.payload.checkName } : {}),
          ...(typed.payload.summary !== undefined ? { failureSummary: typed.payload.summary } : {}),
        };
      case "merge_steward_incident":
        return {
          ...facts,
          ...(typed.payload.incidentSummary !== undefined ? { queueIncidentSummary: typed.payload.incidentSummary } : {}),
        };
      case "delegated":
      case "delegation_observed":
      case "child_changed":
      case "child_delivered":
      case "child_regressed":
      case "direct_reply":
      case "completion_check_continue":
      case "followup_prompt":
      case "followup_comment":
      case "prompt_delivered":
      case "self_comment":
      case "operator_prompt":
      case "stop_requested":
      case "operator_closed":
      case "undelegated":
      case "issue_removed":
      case "pr_closed":
      case "pr_merged":
      case "run_released_authority":
        return facts;
      default:
        return assertNever(typed, "Unhandled issue session event in run outcome facts");
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
    this.db.issueSessions.commitIssueState({
      writer: WRITER,
      expectedVersion: issue.version,
      update: {
        projectId: issue.projectId,
        linearIssueId: issue.linearIssueId,
        ...(identity.patchId ? { lastPublishedPatchId: identity.patchId } : {}),
        ...(identity.integrationTreeId ? { lastPublishedIntegrationTreeId: identity.integrationTreeId } : {}),
        lastPublishedHeadSha: issue.prHeadSha,
      },
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

  // Finalize a run whose authority/premise was revoked mid-flight.
  // No publication, no follow-up enqueue: the current external truth
  // already superseded the run's right to act.
  private releaseSuppressedRun(
    run: RunRecord,
    threadId: string,
    completedTurnId: string | undefined,
    reason: string,
  ): void {
    this.withHeldLease(run.projectId, run.linearIssueId, () => {
      this.db.runs.finishRun(run.id, {
        status: "superseded",
        threadId,
        ...(completedTurnId ? { turnId: completedTurnId } : {}),
        failureReason: run.failureReason ?? reason,
      });
      this.db.issueSessions.commitIssueState({
        writer: WRITER,
        update: {
          projectId: run.projectId,
          linearIssueId: run.linearIssueId,
          activeRunId: null,
          pendingRunType: null,
          pendingRunContextJson: null,
        },
      });
    });
    this.clearProgressAndRelease(run);
    this.feed?.publish({
      level: "info",
      kind: "agent",
      summary: `Run #${run.id} superseded — publication suppressed (${reason})`,
      ...(run.projectId ? { projectId: run.projectId } : {}),
    });
  }

  private resolveSuppressedRunReason(run: RunRecord, issue: IssueRecord): string | undefined {
    if (run.shouldNotPublish || run.status === "superseded") {
      return run.leaseRevokeReason ?? run.failureReason ?? "publication suppressed";
    }

    const workflowSnapshot = projectWorkflowSnapshot({
      issue,
      observations: this.db.workflowObservations.listObservations(issue.projectId, issue.linearIssueId),
      blockerCount: this.db.issues.countUnresolvedBlockers(issue.projectId, issue.linearIssueId),
      childCount: this.db.issues.listCanonicalChildIssues(issue.projectId, issue.linearIssueId).length,
    });
    if (!workflowSnapshot.authority.delegated) {
      return "authority revoked before run completion";
    }
    if (run.authorityEpoch > 0 && workflowSnapshot.authority.epoch > run.authorityEpoch) {
      return `authority epoch changed from ${run.authorityEpoch} to ${workflowSnapshot.authority.epoch}`;
    }
    return undefined;
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

  private resolveWorkflowCompletionTask(run: RunRecord): WorkflowTask | undefined {
    if (!isRepairRunType(run.runType)) return undefined;
    const record = this.db.workflowTasks.getTask(run.projectId, run.linearIssueId, `run:${run.runType}`);
    if (!record?.runType) return undefined;
    const requirements = parseObjectJson(record.requirementsJson);
    return {
      id: record.taskId,
      type: record.taskType as WorkflowTask["type"],
      runType: record.runType,
      reason: record.reason,
      ...(requirements ? { requirements } : {}),
    };
  }

  private evaluateWorkflowCompletionGate(
    run: RunRecord,
    issue: IssueRecord,
  ): { message: string; nextState: FactoryState; status: string; level: "warn" | "error" } | undefined {
    const task = this.resolveWorkflowCompletionTask(run);
    if (!task) return undefined;
    const snapshot = projectWorkflowSnapshot({
      issue,
      observations: this.db.workflowObservations.listObservations(issue.projectId, issue.linearIssueId),
      blockerCount: this.db.issues.countUnresolvedBlockers(issue.projectId, issue.linearIssueId),
      childCount: this.db.issues.listCanonicalChildIssues(issue.projectId, issue.linearIssueId).length,
    });
    const decision = evaluateTaskCompletion(snapshot, task);
    if (decision.action === "start") return undefined;
    if (decision.action === "ask") {
      return {
        message: decision.question,
        nextState: "awaiting_input",
        status: decision.reason,
        level: "warn",
      };
    }
    return {
      message: decision.reason,
      nextState: "escalated",
      status: decision.reason,
      level: decision.action === "wait" ? "warn" : "error",
    };
  }

  private buildSameHeadRepairRetryContext(
    run: Pick<RunRecord, "runType">,
    issue: Pick<IssueRecord, "lastGitHubFailureContextJson">,
    message: string,
  ): RunContext {
    const previousContext = parseObjectJson(issue.lastGitHubFailureContextJson) as Partial<RunContext> | undefined;
    const instruction = run.runType === "queue_repair"
      ? [
          "PatchRelay is retrying because the previous queue repair completed without publishing a newer PR head or proving the queue incident self-resolved.",
          "Before finishing, either publish a newer head on the existing PR branch or verify that GitHub no longer reports the PR as dirty against the queue/base truth.",
        ].join(" ")
      : [
          "PatchRelay is retrying because the previous CI repair completed without publishing a newer PR head or proving a fresh successful gate on the failing head.",
          "Before finishing, either push a scoped commit/new head that addresses the failure, or rerun the gate and wait until GitHub shows a successful gate run completed after this repair started.",
        ].join(" ");
    return {
      ...previousContext,
      source: "same_head_repair_retry",
      promptContext: [
        previousContext?.promptContext,
        instruction,
        `Previous verification failure: ${message}`,
      ].filter(Boolean).join("\n\n"),
    };
  }

  private requeueReactiveRepairAfterVerificationFailure(params: {
    run: RunRecord;
    issue: IssueRecord;
    message: string;
  }): boolean {
    if (params.run.runType !== "ci_repair" && params.run.runType !== "queue_repair") {
      return false;
    }
    const nextState = resolvePostRunFactoryState(params.issue, params.run, { outcome: "recovered" });
    if (!nextState || nextState === "failed" || nextState === "escalated" || nextState === "done") {
      return false;
    }
    const context = this.buildSameHeadRepairRetryContext(params.run, params.issue, params.message);
    return Boolean(this.withHeldLease(params.run.projectId, params.run.linearIssueId, (lease) => {
      settleRun({
        db: this.db,
        run: params.run,
        finish: { status: "failed", failureReason: params.message },
        lease,
        buildIssueUpdate: () => ({
          factoryState: nextState,
          pendingRunType: null,
          pendingRunContextJson: null,
          lastAttemptedFailureHeadSha: null,
          lastAttemptedFailureSignature: null,
          lastAttemptedFailureAt: null,
        }),
      });
      return this.appendWakeEventWithLease(
        lease,
        params.issue,
        params.run.runType,
        context,
        `same_head_repair:${params.run.id}`,
      );
    }));
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
      // The attempt decrements are read-modify-write against the issue row;
      // on conflict, recompute them from the fresh row instead of writing
      // counters derived from a stale read.
      const buildContinueUpdate = (record: Pick<IssueRecord, "ciRepairAttempts" | "queueRepairAttempts" | "reviewFixAttempts">) => ({
        projectId: params.run.projectId,
        linearIssueId: params.run.linearIssueId,
        activeRunId: null,
        factoryState: "delegated" as FactoryState,
        pendingRunType: null,
        pendingRunContextJson: null,
        ...(params.run.runType === "ci_repair" && record.ciRepairAttempts > 0
          ? { ciRepairAttempts: record.ciRepairAttempts - 1 }
          : {}),
        ...(params.run.runType === "queue_repair" && record.queueRepairAttempts > 0
          ? { queueRepairAttempts: record.queueRepairAttempts - 1 }
          : {}),
        ...((params.run.runType === "review_fix" || params.run.runType === "branch_upkeep") && record.reviewFixAttempts > 0
          ? { reviewFixAttempts: record.reviewFixAttempts - 1 }
          : {}),
      });
      this.db.issueSessions.commitIssueState({
        writer: WRITER,
        lease,
        expectedVersion: params.issue.version,
        update: buildContinueUpdate(params.issue),
        onConflict: (current) => buildContinueUpdate(current),
      });
      return Boolean(this.db.issueSessions.appendIssueSessionEventWithLease(lease, {
        projectId: params.run.projectId,
        linearIssueId: params.run.linearIssueId,
        eventType: "completion_check_continue",
        eventJson: JSON.stringify({
          runType: params.run.runType,
          summary: message,
          preserveDirtyWorktree: true,
          ...(params.status.summary !== undefined ? { dirtyWorktreeSummary: params.status.summary } : {}),
          dirtyWorktreeChangedPaths: params.status.changedPaths,
          dirtyWorktreeMergeInProgress: params.status.mergeInProgress,
        } satisfies RunContext),
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
  }): Promise<void> {
    const { run, issue, thread, threadId } = params;
    const freshIssue = this.db.issues.getIssue(run.projectId, run.linearIssueId) ?? issue;

    // A run flagged shouldNotPublish, or whose authority epoch no
    // longer matches current truth, must not enter publication or
    // completion-verification paths. Those policies assume the run is
    // still allowed to publish and may open follow-up work.
    const suppressedReason = this.resolveSuppressedRunReason(run, freshIssue);
    if (suppressedReason) {
      this.releaseSuppressedRun(run, threadId, params.completedTurnId, suppressedReason);
      return;
    }

    const trackedIssue = this.db.issueToTrackedIssue(issue);
    const report = buildStageReport(
      { ...run, status: "completed" },
      trackedIssue,
      thread,
      countEventMethods(this.db.runs.listThreadEvents(run.id)),
    );

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

    const workflowCompletionGate = this.evaluateWorkflowCompletionGate(run, freshIssue);
    if (workflowCompletionGate) {
      this.failRunAndClear(run, workflowCompletionGate.message, workflowCompletionGate.nextState);
      this.syncFailureOutcome({
        run,
        fallbackIssue: freshIssue,
        message: workflowCompletionGate.message,
        level: workflowCompletionGate.level,
        status: workflowCompletionGate.status,
        summary: workflowCompletionGate.message,
      });
      return;
    }

    const verifiedRepairError = await this.completionPolicy.verifyReactiveRunAdvancedBranch(run, freshIssue);
    if (verifiedRepairError) {
      // The run failed verification — it did not do its work, so resolve
      // the hold state from GitHub truth like any other recovery path.
      const requeued = this.requeueReactiveRepairAfterVerificationFailure({
        run,
        issue: freshIssue,
        message: verifiedRepairError,
      });
      if (!requeued) {
        const holdState = resolvePostRunFactoryState(freshIssue, run, { outcome: "recovered" }) ?? "failed";
        this.failRunAndClear(run, verifiedRepairError, holdState);
      }
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
    const postRunState = postRunFollowUp?.factoryState ?? resolvePostRunFactoryState(refreshedIssue, run);
    const outcomeSummary = this.buildOutcomeSummary({
      run,
      issue: refreshedIssue,
      postRunState,
      latestAssistantSummary: report.assistantMessages.at(-1),
    });

    // `refreshedIssue` was read before several async policy checks; a webhook
    // may have landed mid-finalize. settleRun re-reads the row inside its
    // transaction and resolves the post-run state from that fresh truth, so
    // we never regress it (e.g. the PR merged while we were verifying the
    // publish). settleRun also owns the slot clear (plan §B1): it refuses to
    // touch a slot that no longer points at this run.
    const buildCompletionUpdate = (record: IssueRecord) => {
      const state = postRunFollowUp?.factoryState ?? resolvePostRunFactoryState(record, run);
      return {
        ...(state ? { factoryState: state } : {}),
        pendingRunType: null,
        pendingRunContextJson: null,
        ...(postRunFollowUp ? {} : (state === "awaiting_queue" || state === "done"
          ? { ...CLEARED_FAILURE_PROVENANCE }
          : {})),
      };
    };
    const completed = this.withHeldLease(run.projectId, run.linearIssueId, (lease) => {
      settleRun({
        db: this.db,
        run,
        finish: this.buildCompletedRunUpdate({
          threadId,
          ...(params.completedTurnId ? { completedTurnId: params.completedTurnId } : {}),
          report,
          outcomeSummary,
        }),
        lease,
        buildIssueUpdate: buildCompletionUpdate,
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
