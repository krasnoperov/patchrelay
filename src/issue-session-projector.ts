import type {
  IssueRecord,
  RunRecord,
} from "./db-types.ts";
import type { RunType } from "./run-type.ts";
import type { IssueStore } from "./db/issue-store.ts";
import type { IssueSessionStore } from "./db/issue-session-store.ts";
import type { RunStore } from "./db/run-store.ts";
import type { WorkflowTaskStore } from "./db/workflow-task-store.ts";
import { peekRunnableWorkflowTaskRunType } from "./pending-workflow-task.ts";
import { isoNow, type DatabaseConnection } from "./db/shared.ts";
import { buildTrackedIssueRecord } from "./tracked-issue-projector.ts";
import {
  extractLatestAssistantSummary,
} from "./issue-session-events.ts";
import {
  deriveIssueExecutionStateFromRecords,
  isIssuePublishedOrDownstreamOrDoneProjection,
  type IssueExecutionState,
} from "./issue-execution-state.ts";
import type { IssueSessionState } from "./issue-session-state.ts";
import type { PatchRelayTelemetry } from "./telemetry.ts";

export function projectIssueSessionReadModel(params: {
  connection: DatabaseConnection;
  issues: IssueStore;
  issueSessions: IssueSessionStore;
  runs: RunStore;
  workflowTasks: WorkflowTaskStore;
  issue: IssueRecord;
  telemetry?: PatchRelayTelemetry | undefined;
  options?: {
    summaryText?: string | undefined;
    lastRunType?: RunType | undefined;
    lastWorkflowReason?: string | undefined;
  };
}): void {
  const { connection, issues, issueSessions, runs, workflowTasks, issue, options } = params;
  const existing = issueSessions.getIssueSession(issue.projectId, issue.linearIssueId);
  const latestRun = runs.getLatestRunForIssue(issue.projectId, issue.linearIssueId);
  const activeRun = issue.activeRunId !== undefined ? runs.getRunById(issue.activeRunId) : undefined;
  const latestRunType = options?.lastRunType ?? latestRun?.runType ?? existing?.lastRunType;
  const summaryText = resolveIssueSessionSummary(issue, runs, latestRun, existing?.summaryText, options?.summaryText);
  const activeThreadId = issue.threadId ?? existing?.activeThreadId;
  const threadGeneration = activeThreadId && activeThreadId !== existing?.activeThreadId
    ? (existing?.threadGeneration ?? 0) + 1
    : (existing?.threadGeneration ?? (activeThreadId ? 1 : 0));
  const runnableTaskRunType = peekRunnableWorkflowTaskRunType(
    { workflowTasks },
    issue.projectId,
    issue.linearIssueId,
  );
  const blockedBy = issues.listIssueDependencies(issue.projectId, issue.linearIssueId);
  const executionState = deriveIssueExecutionStateFromRecords(issue, {
    ...(activeRun ? { activeRun } : {}),
    ...(latestRun ? { latestRun } : {}),
    blockedByKeys: blockedBy
      .filter((entry) => entry.blockerCurrentLinearStateType !== "completed"
        && entry.blockerCurrentLinearState?.trim().toLowerCase() !== "done")
      .map((entry) => entry.blockerIssueKey ?? entry.blockerLinearIssueId),
    ...(runnableTaskRunType ? { runnableTaskRunType: runnableTaskRunType } : {}),
  });
  const sessionState = renderIssueSessionState(executionState);
  const tracked = buildTrackedIssueRecord({
    issue,
    session: existing,
    blockedBy,
    ...(runnableTaskRunType ? { runnableTaskRunType } : {}),
    latestRun,
    latestEvent: issueSessions.listIssueSessionEvents(issue.projectId, issue.linearIssueId, { limit: 1 }).at(-1),
  });
  const derivedWorkflowReason = renderIssueSessionWorkflowReason(executionState);
  const lastWorkflowReason = options?.lastWorkflowReason
    ?? derivedWorkflowReason
    ?? existing?.lastWorkflowReason;
  const now = isoNow();

  if (existing) {
    connection.prepare(`
      UPDATE issue_sessions SET
        issue_key = ?,
        repo_id = ?,
        branch_name = ?,
        worktree_path = ?,
        pr_number = ?,
        pr_head_sha = ?,
        pr_author_login = ?,
        session_state = ?,
        waiting_reason = ?,
        summary_text = ?,
        active_run_id = ?,
        last_run_type = ?,
        last_workflow_reason = ?,
        ci_repair_attempts = ?,
        queue_repair_attempts = ?,
        review_fix_attempts = ?,
        display_updated_at = ?,
        updated_at = ?
      WHERE project_id = ? AND linear_issue_id = ?
    `).run(
      issue.issueKey ?? null,
      issue.projectId,
      issue.branchName ?? null,
      issue.worktreePath ?? null,
      issue.prNumber ?? null,
      issue.prHeadSha ?? null,
      issue.prAuthorLogin ?? null,
      sessionState,
      tracked.waitingReason ?? null,
      summaryText ?? null,
      issue.activeRunId ?? null,
      latestRunType ?? null,
      lastWorkflowReason ?? null,
      issue.ciRepairAttempts,
      issue.queueRepairAttempts,
      issue.reviewFixAttempts,
      now,
      now,
      issue.projectId,
      issue.linearIssueId,
    );
    upsertIssueSessionThreadState(connection, issue, activeThreadId, threadGeneration, now);
    return;
  }

  connection.prepare(`
    INSERT INTO issue_sessions (
      project_id, linear_issue_id, issue_key, repo_id, branch_name, worktree_path,
      pr_number, pr_head_sha, pr_author_login, session_state, waiting_reason, summary_text,
      active_run_id, last_run_type, last_workflow_reason,
      ci_repair_attempts, queue_repair_attempts, review_fix_attempts,
      created_at, display_updated_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    issue.projectId,
    issue.linearIssueId,
    issue.issueKey ?? null,
    issue.projectId,
    issue.branchName ?? null,
    issue.worktreePath ?? null,
    issue.prNumber ?? null,
    issue.prHeadSha ?? null,
    issue.prAuthorLogin ?? null,
    sessionState,
    tracked.waitingReason ?? null,
    summaryText ?? null,
    issue.activeRunId ?? null,
    latestRunType ?? null,
    lastWorkflowReason ?? null,
    issue.ciRepairAttempts,
    issue.queueRepairAttempts,
    issue.reviewFixAttempts,
    now,
    now,
    now,
  );
  upsertIssueSessionThreadState(connection, issue, activeThreadId, threadGeneration, now);
}

function upsertIssueSessionThreadState(
  connection: DatabaseConnection,
  issue: Pick<IssueRecord, "projectId" | "linearIssueId">,
  activeThreadId: string | undefined,
  threadGeneration: number,
  now: string,
): void {
  connection.prepare(`
    INSERT INTO issue_session_threads (
      project_id,
      linear_issue_id,
      active_thread_id,
      thread_generation,
      updated_at
    ) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(project_id, linear_issue_id) DO UPDATE SET
      active_thread_id = excluded.active_thread_id,
      thread_generation = excluded.thread_generation,
      updated_at = excluded.updated_at
  `).run(
    issue.projectId,
    issue.linearIssueId,
    activeThreadId ?? null,
    threadGeneration,
    now,
  );
}

function renderIssueSessionState(state: IssueExecutionState): IssueSessionState {
  switch (state.kind) {
    case "running":
    case "inconsistent":
      return "running";
    case "waiting_input":
      return "waiting_input";
    case "terminal":
      return state.outcome === "done" ? "done" : "failed";
    default:
      return "idle";
  }
}

function renderIssueSessionWorkflowReason(state: IssueExecutionState): string | undefined {
  switch (state.kind) {
    case "ready":
      return workflowReasonForRunType(state.runnableTaskRunType);
    case "awaiting_followup":
      return workflowReasonForRunType(state.followup);
    case "waiting_input":
      return "waiting_for_human_reply";
    default:
      return undefined;
  }
}

function workflowReasonForRunType(runType: string): string | undefined {
  switch (runType) {
    case "implementation":
      return "delegated";
    case "review_fix":
      return "review_changes_requested";
    case "branch_upkeep":
      return "branch_upkeep";
    case "ci_repair":
      return "settled_red_ci";
    case "queue_repair":
      return "merge_steward_incident";
    default:
      return undefined;
  }
}

function resolveIssueSessionSummary(
  issue: IssueRecord,
  runs: RunStore,
  latestRun: RunRecord | undefined,
  existingSummaryText: string | undefined,
  explicitSummaryText: string | undefined,
): string | undefined {
  if (explicitSummaryText?.trim()) {
    return explicitSummaryText;
  }

  const latestSummary = extractLatestAssistantSummary(latestRun);
  if (latestRun && (latestRun.status === "queued" || latestRun.status === "running")) {
    return latestSummary;
  }
  if (shouldKeepPreviousIssueSummary(issue, latestRun)) {
    return findLatestCompletedRunSummary(runs, issue.projectId, issue.linearIssueId)
      ?? existingSummaryText
      ?? latestSummary;
  }

  return latestSummary ?? existingSummaryText;
}

function shouldKeepPreviousIssueSummary(issue: IssueRecord, latestRun: RunRecord | undefined): boolean {
  if (!latestRun || latestRun.status !== "failed") {
    return false;
  }
  if (latestRun.summaryJson) {
    return false;
  }
  return isIssuePublishedOrDownstreamOrDoneProjection(issue);
}

function findLatestCompletedRunSummary(runs: RunStore, projectId: string, linearIssueId: string): string | undefined {
  const issueRuns = runs.listRunsForIssue(projectId, linearIssueId);
  for (let index = issueRuns.length - 1; index >= 0; index -= 1) {
    const run = issueRuns[index];
    if (!run || run.status !== "completed") {
      continue;
    }
    const summary = extractLatestAssistantSummary(run);
    if (summary?.trim()) {
      return summary;
    }
  }
  return undefined;
}
