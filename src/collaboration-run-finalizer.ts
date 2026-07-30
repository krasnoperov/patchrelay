import type { PatchRelayDatabase } from "./db.ts";
import type { IssueRecord, RunRecord } from "./db-types.ts";
import type { WithHeldIssueSessionLease } from "./issue-session-lease-service.ts";
import type { LinearSessionSync } from "./linear-session-sync.ts";
import { buildStageReport } from "./run-reporting.ts";
import { settleRun } from "./run-settlement.ts";
import type { CodexThreadSummary } from "./types.ts";

type TurnPublisher = (params: {
  level: "info" | "warn" | "error";
  run: Pick<RunRecord, "projectId" | "runType">;
  issueKey?: string | undefined;
  status: string;
  summary: string;
  detail?: string | undefined;
}) => void;

function summaryJson(
  report: ReturnType<typeof buildStageReport>,
  outcomeSummary?: string,
): string {
  return JSON.stringify({
    latestAssistantMessage: report.latestAssistantMessage ?? null,
    latestPlan: report.latestPlan ?? null,
    commandCount: report.commandCount,
    fileChangeCount: report.fileChangeCount,
    toolCallCount: report.toolCallCount,
    outcomeSummary: outcomeSummary ?? null,
  });
}

interface CollaborationFinalizerDependencies {
  db: PatchRelayDatabase;
  linearSync: LinearSessionSync;
  withHeldLease: WithHeldIssueSessionLease;
  clearProgressAndRelease: (run: RunRecord) => void;
  publishTurnEvent: TurnPublisher;
}

interface CollaborationFinalizerInput {
  run: RunRecord;
  issue: IssueRecord;
  thread: CodexThreadSummary;
  threadId: string;
  completedTurnId?: string | undefined;
}

export function finalizeCompletedCollaborationRun(
  dependencies: CollaborationFinalizerDependencies,
  params: CollaborationFinalizerInput,
): void {
  const report = buildStageReport(
    { ...params.run, status: "completed" },
    dependencies.db.issueToTrackedIssue(params.issue),
    params.thread,
  );
  const settled = dependencies.withHeldLease(
    params.run.projectId,
    params.run.linearIssueId,
    (lease) => settleRun({
      db: dependencies.db,
      run: params.run,
      finish: {
        status: "completed",
        threadId: params.threadId,
        ...(params.completedTurnId ? { turnId: params.completedTurnId } : {}),
        summaryJson: summaryJson(
          report,
          report.latestAssistantMessage ?? "Collaboration turn completed.",
        ),
      },
      lease,
    }),
  );
  if (!settled) {
    dependencies.clearProgressAndRelease(params.run);
    return;
  }

  const updatedIssue = dependencies.db.issues.getIssue(
    params.run.projectId,
    params.run.linearIssueId,
  ) ?? params.issue;
  const body = report.latestAssistantMessage?.trim()
    || "I finished this investigation. Reply here with the next question or direction.";
  void dependencies.linearSync.emitActivity(updatedIssue, {
    type: body.endsWith("?") ? "elicitation" : "response",
    body,
  });
  void dependencies.linearSync.syncCodexPlan(updatedIssue, {
    runType: "collaboration",
    plan: [
      { step: "Understand the question", status: "completed" },
      { step: "Investigate relevant context", status: "completed" },
      { step: "Share findings or a draft", status: "completed" },
      { step: "Continue the conversation", status: "inProgress" },
    ],
  });
  dependencies.publishTurnEvent({
    level: "info",
    run: params.run,
    issueKey: params.issue.issueKey,
    status: "completed",
    summary: "Collaboration turn completed without requiring publication",
  });
  dependencies.clearProgressAndRelease(params.run);
}

export function finalizeFailedCollaborationRun(
  dependencies: CollaborationFinalizerDependencies,
  params: CollaborationFinalizerInput & { failureReason: string },
): void {
  const report = buildStageReport(
    { ...params.run, status: "failed" },
    dependencies.db.issueToTrackedIssue(params.issue),
    params.thread,
  );
  dependencies.withHeldLease(params.run.projectId, params.run.linearIssueId, (lease) => {
    settleRun({
      db: dependencies.db,
      run: params.run,
      finish: {
        status: "failed",
        threadId: params.threadId,
        ...(params.completedTurnId ? { turnId: params.completedTurnId } : {}),
        failureReason: params.failureReason,
        summaryJson: summaryJson(report),
      },
      lease,
    });
  });
  const updatedIssue = dependencies.db.issues.getIssue(
    params.run.projectId,
    params.run.linearIssueId,
  ) ?? params.issue;
  void dependencies.linearSync.emitActivity(updatedIssue, {
    type: "error",
    body: `The collaboration turn stopped before I could answer: ${params.failureReason}`,
  });
  void dependencies.linearSync.syncCodexPlan(updatedIssue, {
    runType: "collaboration",
    plan: [
      { step: "Understand the question", status: "completed" },
      { step: "Investigate relevant context", status: "completed" },
      { step: "Collaboration turn failed", status: "inProgress" },
    ],
  });
  dependencies.clearProgressAndRelease(params.run);
}
