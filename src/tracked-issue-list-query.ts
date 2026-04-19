import type { PatchRelayDatabase } from "./db.ts";
import { parseGitHubFailureContext, summarizeGitHubFailureContext } from "./github-failure-context.ts";
import type { GitHubCiSnapshotRecord } from "./db-types.ts";
import { derivePatchRelayWaitingReason } from "./waiting-reason.ts";
import { deriveIssueStatusNote } from "./status-note.ts";
import { isIssueSessionReadyForExecution } from "./issue-session.ts";

function shouldSuppressStatusNote(params: {
  activeRunType?: string | null | undefined;
  sessionState?: string | null | undefined;
  statusNote?: string | undefined;
}): boolean {
  if (!params.activeRunType && params.sessionState !== "running") return false;
  const note = params.statusNote?.trim().toLowerCase();
  if (!note) return true;
  return note === "codex turn was interrupted"
    || note.startsWith("zombie: never started")
    || note === "stale thread after restart"
    || note === "patchrelay received your mention. delegate the issue to patchrelay to start work.";
}

export function parseCiSnapshotSummary(snapshotJson?: string): {
  total: number;
  completed: number;
  passed: number;
  failed: number;
  pending: number;
  overall: "pending" | "success" | "failure";
  failedNames?: string[] | undefined;
} | undefined {
  if (!snapshotJson) return undefined;
  try {
    const snapshot = JSON.parse(snapshotJson) as GitHubCiSnapshotRecord;
    const rawChecks = Array.isArray(snapshot.checks) ? snapshot.checks : [];
    const checks = collapseEffectiveChecks(rawChecks);
    if (checks.length === 0) return undefined;
    let passed = 0;
    let failed = 0;
    let pending = 0;
    const failedNames: string[] = [];
    for (const check of checks) {
      if (check.status === "success") passed++;
      else if (check.status === "failure") {
        failed++;
        failedNames.push(check.name);
      } else pending++;
    }
    return {
      total: checks.length,
      completed: passed + failed,
      passed,
      failed,
      pending,
      overall: snapshot.gateCheckStatus,
      ...(failedNames.length > 0 ? { failedNames } : {}),
    };
  } catch {
    return undefined;
  }
}

function collapseEffectiveChecks(checks: GitHubCiSnapshotRecord["checks"]): GitHubCiSnapshotRecord["checks"] {
  const effective = new Map<string, GitHubCiSnapshotRecord["checks"][number]>();
  for (const check of checks) {
    const name = typeof check?.name === "string" ? check.name.trim() : "";
    if (!name || effective.has(name)) continue;
    effective.set(name, check);
  }
  return [...effective.values()];
}

export function parseStringArray(value: string | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

export class TrackedIssueListQuery {
  constructor(private readonly db: PatchRelayDatabase) {}

  listTrackedIssues(): Array<{
    issueKey?: string;
    title?: string;
    statusNote?: string;
    projectId: string;
    delegatedToPatchRelay: boolean;
    sessionState?: string;
    factoryState: string;
    blockedByCount: number;
    blockedByKeys: string[];
    readyForExecution: boolean;
    currentLinearState?: string;
    activeRunType?: string;
    pendingRunType?: string;
    latestRunType?: string;
    latestRunStatus?: string;
    prNumber?: number;
    prState?: string;
    prReviewState?: string;
    prCheckStatus?: string;
    prChecksSummary?: {
      total: number;
      completed: number;
      passed: number;
      failed: number;
      pending: number;
      overall: "pending" | "success" | "failure";
      failedNames?: string[] | undefined;
    };
    latestFailureSource?: string;
    latestFailureHeadSha?: string;
    latestFailureCheckName?: string;
    latestFailureStepName?: string;
    latestFailureSummary?: string;
    waitingReason?: string;
    completionCheckActive?: boolean;
    updatedAt: string;
  }> {
    const rows = this.db.connection
      .prepare(
        `SELECT
          s.project_id, s.linear_issue_id, s.issue_key, i.title,
          i.current_linear_state, i.factory_state, i.delegated_to_patchrelay, s.session_state, s.waiting_reason, s.summary_text, s.display_updated_at,
          i.pending_run_type,
          i.orchestration_settle_until,
          i.pr_number, i.pr_state, i.pr_head_sha, i.pr_review_state, i.pr_check_status, i.last_blocking_review_head_sha,
          i.last_github_ci_snapshot_json,
          i.last_github_failure_source,
          i.last_github_failure_head_sha,
          i.last_github_failure_check_name,
          i.last_github_failure_context_json,
          active_run.run_type AS active_run_type,
          active_run.completion_check_thread_id AS active_completion_check_thread_id,
          active_run.completion_check_outcome AS active_completion_check_outcome,
          latest_run.run_type AS latest_run_type,
          latest_run.status AS latest_run_status,
          latest_run.summary_json AS latest_run_summary_json,
          latest_run.report_json AS latest_run_report_json,
          latest_run.completion_check_thread_id AS latest_run_completion_check_thread_id,
          latest_run.completion_check_outcome AS latest_run_completion_check_outcome,
          latest_run.completion_check_summary AS latest_run_completion_check_summary,
          latest_run.completion_check_question AS latest_run_completion_check_question,
          latest_run.completion_check_why AS latest_run_completion_check_why,
          latest_run.completion_check_recommended_reply AS latest_run_completion_check_recommended_reply,
          (
            SELECT COUNT(*)
            FROM issue_session_events e
            WHERE e.project_id = s.project_id
              AND e.linear_issue_id = s.linear_issue_id
              AND e.processed_at IS NULL
          ) AS pending_session_event_count,
          (
            SELECT COUNT(*)
            FROM issue_dependencies d
            LEFT JOIN issues blockers
              ON blockers.project_id = d.project_id
             AND blockers.linear_issue_id = d.blocker_linear_issue_id
            WHERE d.project_id = s.project_id
              AND d.linear_issue_id = s.linear_issue_id
              AND (
                COALESCE(blockers.current_linear_state_type, d.blocker_current_linear_state_type, '') != 'completed'
                AND LOWER(TRIM(COALESCE(blockers.current_linear_state, d.blocker_current_linear_state, ''))) != 'done'
              )
          ) AS blocked_by_count,
          (
            SELECT json_group_array(COALESCE(blockers.issue_key, d.blocker_issue_key, d.blocker_linear_issue_id))
            FROM issue_dependencies d
            LEFT JOIN issues blockers
              ON blockers.project_id = d.project_id
             AND blockers.linear_issue_id = d.blocker_linear_issue_id
            WHERE d.project_id = s.project_id
              AND d.linear_issue_id = s.linear_issue_id
              AND (
                COALESCE(blockers.current_linear_state_type, d.blocker_current_linear_state_type, '') != 'completed'
                AND LOWER(TRIM(COALESCE(blockers.current_linear_state, d.blocker_current_linear_state, ''))) != 'done'
              )
          ) AS blocked_by_keys_json
        FROM issue_sessions s
        LEFT JOIN issues i
          ON i.project_id = s.project_id
         AND i.linear_issue_id = s.linear_issue_id
        LEFT JOIN runs active_run ON active_run.id = COALESCE(s.active_run_id, i.active_run_id)
        LEFT JOIN runs latest_run ON latest_run.id = (
          SELECT r.id FROM runs r
          WHERE r.project_id = s.project_id AND r.linear_issue_id = s.linear_issue_id
          ORDER BY r.id DESC LIMIT 1
        )
        ORDER BY s.display_updated_at DESC, s.issue_key ASC`,
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map((row) => {
      const failureContext = parseGitHubFailureContext(
        typeof row.last_github_failure_context_json === "string" ? row.last_github_failure_context_json : undefined,
      );
      const prChecksSummary = parseCiSnapshotSummary(
        typeof row.last_github_ci_snapshot_json === "string" ? row.last_github_ci_snapshot_json : undefined,
      );
      const blockedByKeys = parseStringArray(
        typeof row.blocked_by_keys_json === "string" ? row.blocked_by_keys_json : undefined,
      );
      const blockedByCount = Number(row.blocked_by_count ?? 0);
      const hasPendingSessionEvents = Number(row.pending_session_event_count ?? 0) > 0;
      const hasPendingWake = hasPendingSessionEvents
        || this.db.issueSessions.peekIssueSessionWake(String(row.project_id), String(row.linear_issue_id)) !== undefined;
      const readyForExecution = isIssueSessionReadyForExecution({
        ...(typeof row.session_state === "string" ? { sessionState: String(row.session_state) as never } : {}),
        factoryState: String(row.factory_state ?? "delegated") as never,
        ...(row.delegated_to_patchrelay !== null ? { delegatedToPatchRelay: Number(row.delegated_to_patchrelay) !== 0 } : {}),
        ...(row.active_run_type !== null ? { activeRunId: 1 } : {}),
        blockedByCount,
        hasPendingWake,
        hasLegacyPendingRun: row.pending_run_type !== null && row.pending_run_type !== undefined,
        ...(row.orchestration_settle_until !== null ? { orchestrationSettleUntil: String(row.orchestration_settle_until) } : {}),
        ...(row.pr_number !== null ? { prNumber: Number(row.pr_number) } : {}),
        ...(row.pr_state !== null ? { prState: String(row.pr_state) } : {}),
        ...(row.pr_review_state !== null ? { prReviewState: String(row.pr_review_state) } : {}),
        ...(row.pr_check_status !== null ? { prCheckStatus: String(row.pr_check_status) } : {}),
        ...(row.last_github_failure_source !== null ? { latestFailureSource: String(row.last_github_failure_source) } : {}),
      });
      const failureSummary = summarizeGitHubFailureContext(failureContext);
      const sessionWaitingReason = typeof row.waiting_reason === "string" && row.waiting_reason.trim().length > 0
        ? row.waiting_reason
        : undefined;
      const sessionSummary = typeof row.summary_text === "string" && row.summary_text.trim().length > 0
        ? row.summary_text
        : undefined;
      const waitingReason = sessionWaitingReason ?? derivePatchRelayWaitingReason({
        ...(row.delegated_to_patchrelay !== null ? { delegatedToPatchRelay: Number(row.delegated_to_patchrelay) !== 0 } : {}),
        ...(row.active_run_type !== null ? { activeRunType: String(row.active_run_type) } : {}),
        blockedByKeys,
        factoryState: String(row.factory_state ?? "delegated"),
        ...(row.pending_run_type !== null ? { pendingRunType: String(row.pending_run_type) } : {}),
        ...(row.orchestration_settle_until !== null ? { orchestrationSettleUntil: String(row.orchestration_settle_until) } : {}),
        ...(row.pr_number !== null ? { prNumber: Number(row.pr_number) } : {}),
        ...(row.pr_state !== null ? { prState: String(row.pr_state) } : {}),
        ...(row.pr_head_sha !== null ? { prHeadSha: String(row.pr_head_sha) } : {}),
        ...(row.pr_review_state !== null ? { prReviewState: String(row.pr_review_state) } : {}),
        ...(row.pr_check_status !== null ? { prCheckStatus: String(row.pr_check_status) } : {}),
        ...(row.last_blocking_review_head_sha !== null ? { lastBlockingReviewHeadSha: String(row.last_blocking_review_head_sha) } : {}),
        ...(row.last_github_failure_check_name !== null ? { latestFailureCheckName: String(row.last_github_failure_check_name) } : {}),
      });
      const latestRun = row.latest_run_type !== null && row.latest_run_status !== null
        ? {
            id: 0,
            issueId: 0,
            projectId: String(row.project_id),
            linearIssueId: String(row.linear_issue_id),
            runType: String(row.latest_run_type) as never,
            status: String(row.latest_run_status) as never,
            ...(typeof row.latest_run_summary_json === "string" ? { summaryJson: row.latest_run_summary_json } : {}),
            ...(typeof row.latest_run_report_json === "string" ? { reportJson: row.latest_run_report_json } : {}),
            ...(typeof row.latest_run_completion_check_thread_id === "string" ? { completionCheckThreadId: row.latest_run_completion_check_thread_id } : {}),
            ...(typeof row.latest_run_completion_check_outcome === "string" ? { completionCheckOutcome: row.latest_run_completion_check_outcome as never } : {}),
            ...(typeof row.latest_run_completion_check_summary === "string" ? { completionCheckSummary: row.latest_run_completion_check_summary } : {}),
            ...(typeof row.latest_run_completion_check_question === "string" ? { completionCheckQuestion: row.latest_run_completion_check_question } : {}),
            ...(typeof row.latest_run_completion_check_why === "string" ? { completionCheckWhy: row.latest_run_completion_check_why } : {}),
            ...(typeof row.latest_run_completion_check_recommended_reply === "string" ? { completionCheckRecommendedReply: row.latest_run_completion_check_recommended_reply } : {}),
            startedAt: String(row.display_updated_at),
          }
        : undefined;
      const latestEvent = this.db.issueSessions.listIssueSessionEvents(String(row.project_id), String(row.linear_issue_id), { limit: 1 }).at(-1);
      const statusNoteCandidate = deriveIssueStatusNote({
        issue: { factoryState: String(row.factory_state ?? "delegated") } as never,
        sessionSummary,
        latestRun: latestRun as never,
        latestEvent,
        failureSummary,
        blockedByKeys,
        waitingReason,
      }) ?? waitingReason;
      const statusNoteForReturn = shouldSuppressStatusNote({
        activeRunType: row.active_run_type as string | null | undefined,
        sessionState: row.session_state as string | null | undefined,
        statusNote: statusNoteCandidate,
      })
        ? undefined
        : statusNoteCandidate;
      const completionCheckActive = typeof row.active_completion_check_thread_id === "string"
        && row.active_completion_check_thread_id.length > 0
        && row.active_completion_check_outcome === null
        && row.active_run_type !== null;

      return {
        ...(row.issue_key !== null ? { issueKey: String(row.issue_key) } : {}),
        ...(row.title !== null ? { title: String(row.title) } : {}),
        ...(statusNoteForReturn ? { statusNote: statusNoteForReturn } : {}),
        projectId: String(row.project_id),
        delegatedToPatchRelay: row.delegated_to_patchrelay === null ? true : Number(row.delegated_to_patchrelay) !== 0,
        ...(row.session_state !== null ? { sessionState: String(row.session_state) } : {}),
        factoryState: String(row.factory_state ?? "delegated"),
        blockedByCount,
        blockedByKeys,
        readyForExecution,
        ...(row.current_linear_state !== null ? { currentLinearState: String(row.current_linear_state) } : {}),
        ...(row.active_run_type !== null ? { activeRunType: String(row.active_run_type) } : {}),
        ...(row.pending_run_type !== null ? { pendingRunType: String(row.pending_run_type) } : {}),
        ...(row.latest_run_type !== null ? { latestRunType: String(row.latest_run_type) } : {}),
        ...(row.latest_run_status !== null ? { latestRunStatus: String(row.latest_run_status) } : {}),
        ...(row.pr_number !== null ? { prNumber: Number(row.pr_number) } : {}),
        ...(row.pr_state !== null ? { prState: String(row.pr_state) } : {}),
        ...(row.pr_review_state !== null ? { prReviewState: String(row.pr_review_state) } : {}),
        ...(row.pr_check_status !== null ? { prCheckStatus: String(row.pr_check_status) } : {}),
        ...(prChecksSummary ? { prChecksSummary } : {}),
        ...(row.last_github_failure_source !== null ? { latestFailureSource: String(row.last_github_failure_source) } : {}),
        ...(row.last_github_failure_head_sha !== null ? { latestFailureHeadSha: String(row.last_github_failure_head_sha) } : {}),
        ...(row.last_github_failure_check_name !== null ? { latestFailureCheckName: String(row.last_github_failure_check_name) } : {}),
        ...(failureContext?.stepName ? { latestFailureStepName: failureContext.stepName } : {}),
        ...(failureContext?.summary ? { latestFailureSummary: failureContext.summary } : {}),
        ...(waitingReason ? { waitingReason } : {}),
        ...(completionCheckActive ? { completionCheckActive } : {}),
        updatedAt: String(row.display_updated_at),
      };
    });
  }
}
