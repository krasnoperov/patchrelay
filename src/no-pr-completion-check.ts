import type { Logger } from "pino";
import type { CompletionCheckExecution } from "./completion-check.ts";
import type { PatchRelayDatabase } from "./db.ts";
import type { IssueRecord, RunRecord } from "./db-types.ts";
import type { FactoryState } from "./factory-state.ts";
import type { WithHeldIssueSessionLease } from "./issue-session-lease-service.ts";
import { buildCompletionCheckActivity } from "./linear-session-reporting.ts";
import { wakeOrchestrationParentsForChildEvent } from "./orchestration-parent-wake.ts";
import type { buildStageReport } from "./run-reporting.ts";

function shouldContinueForUnpublishedLocalChanges(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  if (!normalized) return false;
  return normalized.includes("worktree still has")
    || (normalized.includes("local commit") && normalized.includes("ahead of origin/"));
}

export async function handleNoPrCompletionCheck(params: {
  db: PatchRelayDatabase;
  logger: Logger;
  withHeldLease: WithHeldIssueSessionLease;
  completionCheck: {
    run(args: {
      issue: Pick<IssueRecord, "issueKey" | "linearIssueId" | "title" | "description" | "worktreePath">;
      run: Pick<RunRecord, "id" | "threadId" | "runType" | "failureReason" | "summaryJson" | "reportJson">;
      noPrSummary: string;
      onStarted?: ((start: { threadId: string; turnId: string }) => void | Promise<void>) | undefined;
    }): Promise<CompletionCheckExecution>;
  };
  run: RunRecord;
  issue: IssueRecord;
  report: ReturnType<typeof buildStageReport>;
  threadId: string;
  completedTurnId?: string | undefined;
  publishedOutcomeError: string;
  failRunAndClear: (run: RunRecord, message: string, nextState?: FactoryState) => void;
  emitActivity: (
    issue: IssueRecord,
    activity: ReturnType<typeof buildCompletionCheckActivity>,
    options?: { ephemeral?: boolean },
  ) => void | Promise<void>;
  publishTurnEvent: (params: {
    level: "info" | "warn" | "error";
    run: Pick<RunRecord, "projectId" | "runType">;
    issueKey?: string | undefined;
    status: string;
    summary: string;
    detail?: string | undefined;
  }) => void;
  syncFailureOutcome: (params: {
    run: RunRecord;
    fallbackIssue: IssueRecord;
    message: string;
    level: "warn" | "error";
    status: string;
    summary: string;
    detail?: string | undefined;
  }) => void;
  syncCompletionCheckOutcome: (params: {
    run: RunRecord;
    fallbackIssue: IssueRecord;
    level: "info" | "warn";
    status: string;
    summary: string;
    detail?: string | undefined;
    activity: ReturnType<typeof buildCompletionCheckActivity>;
    enqueue?: boolean | undefined;
  }) => void;
  clearProgressAndRelease: (run: Pick<RunRecord, "id" | "projectId" | "linearIssueId">) => void;
}): Promise<void> {
  const completedRunUpdate = buildCompletedRunUpdate({
    threadId: params.threadId,
    ...(params.completedTurnId ? { completedTurnId: params.completedTurnId } : {}),
    report: params.report,
  });

  params.publishTurnEvent({
    level: "info",
    run: params.run,
    issueKey: params.issue.issueKey,
    status: "completion_check_started",
    summary: "No PR found; checking next step",
    detail: params.publishedOutcomeError,
  });
  void params.emitActivity(params.issue, buildCompletionCheckActivity("started"), { ephemeral: true });

  let completionCheck: CompletionCheckExecution;
  try {
    completionCheck = await params.completionCheck.run({
      issue: params.issue,
      run: params.run,
      noPrSummary: params.publishedOutcomeError,
      onStarted: ({ threadId: completionCheckThreadId, turnId: completionCheckTurnId }) => {
        params.db.runs.markCompletionCheckStarted(params.run.id, {
          threadId: completionCheckThreadId,
          turnId: completionCheckTurnId,
        });
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failureMessage = `No PR observed and the completion check failed: ${message}`;
    params.failRunAndClear(params.run, failureMessage, "failed");
    params.syncFailureOutcome({
      run: params.run,
      fallbackIssue: params.issue,
      message: failureMessage,
      level: "error",
      status: "completion_check_failed",
      summary: "No PR found; completion check failed",
      detail: message,
    });
    return;
  }

  if (completionCheck.outcome === "continue") {
    const continued = params.withHeldLease(params.run.projectId, params.run.linearIssueId, (lease) => {
      params.db.runs.finishRun(params.run.id, completedRunUpdate);
      params.db.runs.saveCompletionCheck(params.run.id, completionCheck);
      params.db.issues.upsertIssue({
        projectId: params.run.projectId,
        linearIssueId: params.run.linearIssueId,
        activeRunId: null,
        factoryState: "delegated",
        pendingRunType: null,
        pendingRunContextJson: null,
      });
      return Boolean(params.db.issueSessions.appendIssueSessionEventWithLease(lease, {
        projectId: params.run.projectId,
        linearIssueId: params.run.linearIssueId,
        eventType: "completion_check_continue",
        eventJson: JSON.stringify({
          runType: params.run.runType,
          summary: completionCheck.summary,
        }),
        dedupeKey: `completion_check_continue:${params.run.id}`,
      }));
    });
    if (!continued) {
      params.logger.warn({ runId: params.run.id, issueId: params.run.linearIssueId }, "Skipping completion-check continue writes after losing issue-session lease");
      params.clearProgressAndRelease(params.run);
      return;
    }
    params.syncCompletionCheckOutcome({
      run: params.run,
      fallbackIssue: params.issue,
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
    const completed = params.withHeldLease(params.run.projectId, params.run.linearIssueId, (lease) => {
      params.db.runs.finishRun(params.run.id, completedRunUpdate);
      params.db.runs.saveCompletionCheck(params.run.id, completionCheck);
      params.db.issueSessions.clearPendingIssueSessionEventsWithLease(lease);
      params.db.issues.upsertIssue({
        projectId: params.run.projectId,
        linearIssueId: params.run.linearIssueId,
        activeRunId: null,
        factoryState: "awaiting_input",
        pendingRunType: null,
        pendingRunContextJson: null,
      });
      return true;
    });
    if (!completed) {
      params.logger.warn({ runId: params.run.id, issueId: params.run.linearIssueId }, "Skipping completion-check needs-input writes after losing issue-session lease");
      params.clearProgressAndRelease(params.run);
      return;
    }
    params.syncCompletionCheckOutcome({
      run: params.run,
      fallbackIssue: params.issue,
      level: "warn",
      status: "completion_check_needs_input",
      summary: "No PR found; waiting for answer",
      detail: completionCheck.question ?? completionCheck.summary,
      activity: buildCompletionCheckActivity("needs_input", completionCheck),
    });
    return;
  }

  if (completionCheck.outcome === "done") {
    if (shouldContinueForUnpublishedLocalChanges(params.publishedOutcomeError)) {
      const continued = params.withHeldLease(params.run.projectId, params.run.linearIssueId, (lease) => {
        params.db.runs.finishRun(params.run.id, completedRunUpdate);
        params.db.runs.saveCompletionCheck(params.run.id, {
          ...completionCheck,
          outcome: "continue",
          summary: "PatchRelay changed files locally but has not published them yet; continuing automatically to finish publication.",
          why: params.publishedOutcomeError,
        });
        params.db.issues.upsertIssue({
          projectId: params.run.projectId,
          linearIssueId: params.run.linearIssueId,
          activeRunId: null,
          factoryState: "delegated",
          pendingRunType: null,
          pendingRunContextJson: null,
        });
        return Boolean(params.db.issueSessions.appendIssueSessionEventWithLease(lease, {
          projectId: params.run.projectId,
          linearIssueId: params.run.linearIssueId,
          eventType: "completion_check_continue",
          eventJson: JSON.stringify({
            runType: params.run.runType,
            summary: params.publishedOutcomeError,
          }),
          dedupeKey: `completion_check_continue:${params.run.id}`,
        }));
      });
      if (!continued) {
        params.logger.warn({ runId: params.run.id, issueId: params.run.linearIssueId }, "Skipping completion-check continue writes after losing issue-session lease");
        params.clearProgressAndRelease(params.run);
        return;
      }
      params.syncCompletionCheckOutcome({
        run: params.run,
        fallbackIssue: params.issue,
        level: "info",
        status: "completion_check_continue",
        summary: "No PR found; continuing automatically to finish publication",
        detail: params.publishedOutcomeError,
        activity: buildCompletionCheckActivity("continue"),
        enqueue: true,
      });
      return;
    }

    const orchestrationOpenChildren = params.issue.issueClass === "orchestration"
      ? params.db.issues.countOpenChildIssues(params.run.projectId, params.run.linearIssueId)
      : 0;
    const completed = params.withHeldLease(params.run.projectId, params.run.linearIssueId, (lease) => {
      params.db.runs.finishRun(params.run.id, completedRunUpdate);
      params.db.runs.saveCompletionCheck(params.run.id, completionCheck);
      params.db.issueSessions.clearPendingIssueSessionEventsWithLease(lease);
      params.db.issues.upsertIssue({
        projectId: params.run.projectId,
        linearIssueId: params.run.linearIssueId,
        activeRunId: null,
        factoryState: params.issue.issueClass === "orchestration" && orchestrationOpenChildren > 0 ? "delegated" : "done",
        pendingRunType: null,
        pendingRunContextJson: null,
        orchestrationSettleUntil: null,
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
      });
      return true;
    });
    if (!completed) {
      params.logger.warn({ runId: params.run.id, issueId: params.run.linearIssueId }, "Skipping completion-check done writes after losing issue-session lease");
      params.clearProgressAndRelease(params.run);
      return;
    }
    params.syncCompletionCheckOutcome({
      run: params.run,
      fallbackIssue: params.issue,
      level: "info",
      status: "completion_check_done",
      summary: params.issue.issueClass === "orchestration" && orchestrationOpenChildren > 0
        ? "No PR found; orchestration will wait on child deliveries"
        : "No PR found; confirmed done",
      detail: params.issue.issueClass === "orchestration" && orchestrationOpenChildren > 0
        ? `${completionCheck.summary} Waiting on ${orchestrationOpenChildren} open child issue(s) before final convergence.`
        : completionCheck.summary,
      activity: buildCompletionCheckActivity("done", completionCheck),
    });
    const doneIssue = params.db.issues.getIssue(params.run.projectId, params.run.linearIssueId) ?? params.issue;
    wakeOrchestrationParentsForChildEvent({
      db: params.db,
      child: doneIssue,
      eventType: "child_delivered",
    });
    return;
  }

  const failureReason = `No PR observed and the completion check failed this run: ${completionCheck.summary}`;
  const failed = params.withHeldLease(params.run.projectId, params.run.linearIssueId, () => {
    params.db.runs.finishRun(params.run.id, {
      ...completedRunUpdate,
      status: "failed",
      failureReason,
    });
    params.db.runs.saveCompletionCheck(params.run.id, completionCheck);
    params.db.issues.upsertIssue({
      projectId: params.run.projectId,
      linearIssueId: params.run.linearIssueId,
      activeRunId: null,
      factoryState: "failed",
      pendingRunType: null,
      pendingRunContextJson: null,
    });
    return true;
  });
  if (!failed) {
    params.logger.warn({ runId: params.run.id, issueId: params.run.linearIssueId }, "Skipping completion-check failed writes after losing issue-session lease");
    params.clearProgressAndRelease(params.run);
    return;
  }
  params.syncFailureOutcome({
    run: params.run,
    fallbackIssue: params.issue,
    message: failureReason,
    level: "warn",
    status: "completion_check_failed",
    summary: "No PR found; completion check failed",
    detail: completionCheck.summary,
  });
}

function buildCompletedRunUpdate(params: {
  threadId: string;
  completedTurnId?: string | undefined;
  report: ReturnType<typeof buildStageReport>;
}): {
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
