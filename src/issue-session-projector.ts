import type {
  IssueRecord,
  RunRecord,
} from "./db-types.ts";
import type { RunType } from "./run-type.ts";
import type { IssueSessionStore } from "./db/issue-session-store.ts";
import type { RunStore } from "./db/run-store.ts";
import { isoNow, type DatabaseConnection } from "./db/shared.ts";
import {
  extractLatestAssistantSummary,
} from "./issue-session-events.ts";
import { isIssuePublishedOrDownstreamOrDoneProjection } from "./issue-execution-state.ts";

export function projectIssueSessionMetadata(params: {
  connection: DatabaseConnection;
  issueSessions: IssueSessionStore;
  runs: RunStore;
  issue: IssueRecord;
  options?: {
    summaryText?: string | undefined;
    lastRunType?: RunType | undefined;
    lastWorkflowReason?: string | undefined;
  };
}): void {
  const { connection, issueSessions, runs, issue, options } = params;
  const existing = issueSessions.getIssueSession(issue.projectId, issue.linearIssueId);
  const latestRun = runs.getLatestRunForIssue(issue.projectId, issue.linearIssueId);
  const latestRunType = options?.lastRunType ?? latestRun?.runType ?? existing?.lastRunType;
  const summaryText = resolveIssueSessionSummary(issue, runs, latestRun, existing?.summaryText, options?.summaryText);
  const activeThreadId = issue.threadId ?? existing?.activeThreadId;
  const threadGeneration = activeThreadId && activeThreadId !== existing?.activeThreadId
    ? (existing?.threadGeneration ?? 0) + 1
    : (existing?.threadGeneration ?? (activeThreadId ? 1 : 0));
  const lastWorkflowReason = options?.lastWorkflowReason
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
      pr_number, pr_head_sha, pr_author_login, summary_text,
      active_run_id, last_run_type, last_workflow_reason,
      ci_repair_attempts, queue_repair_attempts, review_fix_attempts,
      created_at, display_updated_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
