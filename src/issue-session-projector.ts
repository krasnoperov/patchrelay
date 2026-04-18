import type {
  IssueRecord,
  RunRecord,
} from "./db-types.ts";
import type { RunType } from "./factory-state.ts";
import type { IssueStore } from "./db/issue-store.ts";
import type { IssueSessionStore } from "./db/issue-session-store.ts";
import type { RunStore } from "./db/run-store.ts";
import { isoNow, type DatabaseConnection } from "./db/shared.ts";
import { buildTrackedIssueRecord } from "./tracked-issue-projector.ts";
import {
  extractLatestAssistantSummary,
} from "./issue-session-events.ts";
import {
  deriveIssueSessionState,
  deriveIssueSessionWakeReason,
} from "./issue-session.ts";

export function syncIssueSessionFromIssue(params: {
  connection: DatabaseConnection;
  issues: IssueStore;
  issueSessions: IssueSessionStore;
  runs: RunStore;
  issue: IssueRecord;
  options?: {
    summaryText?: string | undefined;
    lastRunType?: RunType | undefined;
    lastWakeReason?: string | undefined;
  };
}): void {
  const { connection, issues, issueSessions, runs, issue, options } = params;
  const existing = issueSessions.getIssueSession(issue.projectId, issue.linearIssueId);
  const latestRun = runs.getLatestRunForIssue(issue.projectId, issue.linearIssueId);
  const latestRunType = options?.lastRunType ?? latestRun?.runType ?? existing?.lastRunType;
  const summaryText = resolveIssueSessionSummary(issue, runs, latestRun, existing?.summaryText, options?.summaryText);
  const activeThreadId = issue.threadId ?? existing?.activeThreadId;
  const threadGeneration = activeThreadId && activeThreadId !== existing?.activeThreadId
    ? (existing?.threadGeneration ?? 0) + 1
    : (existing?.threadGeneration ?? (activeThreadId ? 1 : 0));
  const sessionState = deriveIssueSessionState({
    ...(issue.activeRunId !== undefined ? { activeRunId: issue.activeRunId } : {}),
    factoryState: issue.factoryState,
  });
  const tracked = buildTrackedIssueRecord({
    issue,
    session: existing,
    blockedBy: issues.listIssueDependencies(issue.projectId, issue.linearIssueId),
    hasPendingWake: issueSessions.peekIssueSessionWake(issue.projectId, issue.linearIssueId) !== undefined,
    latestRun,
    latestEvent: issueSessions.listIssueSessionEvents(issue.projectId, issue.linearIssueId, { limit: 1 }).at(-1),
  });
  const lastWakeReason = options?.lastWakeReason
    ?? deriveIssueSessionWakeReason({
      delegatedToPatchRelay: issue.delegatedToPatchRelay,
      pendingRunType: issue.pendingRunType,
      factoryState: issue.factoryState,
      prNumber: issue.prNumber,
      prState: issue.prState,
      prReviewState: issue.prReviewState,
      prCheckStatus: issue.prCheckStatus,
      latestFailureSource: issue.lastGitHubFailureSource,
    })
    ?? existing?.lastWakeReason;
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
        active_thread_id = ?,
        thread_generation = ?,
        active_run_id = ?,
        last_run_type = ?,
        last_wake_reason = ?,
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
      activeThreadId ?? null,
      threadGeneration,
      issue.activeRunId ?? null,
      latestRunType ?? null,
      lastWakeReason ?? null,
      issue.ciRepairAttempts,
      issue.queueRepairAttempts,
      issue.reviewFixAttempts,
      now,
      now,
      issue.projectId,
      issue.linearIssueId,
    );
    return;
  }

  connection.prepare(`
    INSERT INTO issue_sessions (
      project_id, linear_issue_id, issue_key, repo_id, branch_name, worktree_path,
      pr_number, pr_head_sha, pr_author_login, session_state, waiting_reason, summary_text,
      active_thread_id, thread_generation, active_run_id, last_run_type, last_wake_reason,
      ci_repair_attempts, queue_repair_attempts, review_fix_attempts,
      created_at, display_updated_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    activeThreadId ?? null,
    threadGeneration,
    issue.activeRunId ?? null,
    latestRunType ?? null,
    lastWakeReason ?? null,
    issue.ciRepairAttempts,
    issue.queueRepairAttempts,
    issue.reviewFixAttempts,
    now,
    now,
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
  if (latestRun.summaryJson || latestRun.reportJson) {
    return false;
  }
  return issue.factoryState === "pr_open"
    || issue.factoryState === "awaiting_queue"
    || issue.factoryState === "done";
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
