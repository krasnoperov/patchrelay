import type { PatchRelayDatabase } from "./db.ts";
import { parseGitHubFailureContext, summarizeGitHubFailureContext } from "./github-failure-context.ts";
import type { GitHubCiSnapshotRecord } from "./db-types.ts";
import { derivePatchRelayWaitingReason } from "./waiting-reason.ts";
import { deriveIssueStatusNote } from "./status-note.ts";
import { hasDetachedActiveLatestRun } from "./effective-active-run.ts";
import { deriveIssueExecutionState, isIssueExecutionReadyForExecution } from "./issue-execution-state.ts";
import { deriveIssuePhase, type IssuePhase } from "./issue-phase.ts";

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
    phase: IssuePhase;
    blockedByCount: number;
    blockedByKeys: string[];
    readyForExecution: boolean;
    currentLinearState?: string;
    activeRunType?: string;
    runnableTaskRunType?: string;
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
    const rows = this.db.issueSessions.listTrackedIssueRows();
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
      const runnableWorkflowTask = this.db.workflowTasks
        .listOpenRunnableTasks(String(row.project_id))
        .find((task) => task.subjectId === String(row.linear_issue_id));
      const detachedActiveRun = hasDetachedActiveLatestRun({
        activeRunId: row.active_run_type !== null ? 1 : undefined,
        latestRun: row.latest_run_status !== null
          ? { id: 0, status: String(row.latest_run_status) as never }
          : undefined,
      });
      const effectiveActiveRunType = row.active_run_type !== null
        ? String(row.active_run_type)
        : detachedActiveRun && row.latest_run_type !== null
          ? String(row.latest_run_type)
          : undefined;
      const effectiveActiveRunStatus = row.active_run_status !== null && row.active_run_status !== undefined
        ? String(row.active_run_status)
        : detachedActiveRun && row.latest_run_status !== null
          ? String(row.latest_run_status)
          : undefined;
      const issueFacts = {
        delegatedToPatchRelay: row.delegated_to_patchrelay === null ? true : Number(row.delegated_to_patchrelay) !== 0,
        workflowOutcome: row.workflow_outcome === null ? undefined : String(row.workflow_outcome) as "completed" | "failed" | "escalated",
        inputRequestKind: row.input_request_kind === null ? undefined : String(row.input_request_kind) as "paused_local_work" | "completion_check_question",
        currentLinearState: row.current_linear_state === null ? undefined : String(row.current_linear_state),
        currentLinearStateType: row.current_linear_state_type === null ? undefined : String(row.current_linear_state_type),
        prNumber: row.pr_number === null ? undefined : Number(row.pr_number),
        prState: row.pr_state === null ? undefined : String(row.pr_state),
        prIsDraft: row.pr_is_draft === null ? undefined : Boolean(row.pr_is_draft),
        prReviewState: row.pr_review_state === null ? undefined : String(row.pr_review_state),
        prCheckStatus: row.pr_check_status === null ? undefined : String(row.pr_check_status),
        lastGitHubFailureSource: row.last_github_failure_source === null ? undefined : String(row.last_github_failure_source) as "branch_ci" | "queue_eviction",
        deployStartedAt: row.deploy_started_at === null ? undefined : String(row.deploy_started_at),
      };
      const executionState = deriveIssueExecutionState({
        ...issueFacts,
        ...((row.active_run_type !== null || detachedActiveRun) ? { activeRunId: 1 } : {}),
        ...(effectiveActiveRunType ? { activeRunType: effectiveActiveRunType } : {}),
        ...(effectiveActiveRunStatus ? { activeRunStatus: effectiveActiveRunStatus } : {}),
        blockedByKeys,
        ...(runnableWorkflowTask?.runType ? { runnableTaskRunType: runnableWorkflowTask.runType } : {}),
        ...(row.orchestration_settle_until !== null ? { orchestrationSettleUntil: String(row.orchestration_settle_until) } : {}),
        ...(row.pr_head_sha !== null ? { prHeadSha: String(row.pr_head_sha) } : {}),
        ...(row.last_blocking_review_head_sha !== null ? { lastBlockingReviewHeadSha: String(row.last_blocking_review_head_sha) } : {}),
        ...(row.last_github_failure_check_name !== null ? { latestFailureCheckName: String(row.last_github_failure_check_name) } : {}),
      });
      const readyForExecution = isIssueExecutionReadyForExecution(executionState);
      const failureSummary = summarizeGitHubFailureContext(failureContext);
      const sessionWaitingReason = typeof row.waiting_reason === "string" && row.waiting_reason.trim().length > 0
        ? row.waiting_reason
        : undefined;
      const sessionSummary = typeof row.summary_text === "string" && row.summary_text.trim().length > 0
        ? row.summary_text
        : undefined;
      const derivedWaitingReason = derivePatchRelayWaitingReason({
        ...issueFacts,
        ...((row.active_run_type !== null || detachedActiveRun) ? { activeRunId: 1 } : {}),
        blockedByKeys,
        ...(runnableWorkflowTask?.runType ? { runnableTaskRunType: runnableWorkflowTask.runType } : {}),
        ...(row.orchestration_settle_until !== null ? { orchestrationSettleUntil: String(row.orchestration_settle_until) } : {}),
        ...(row.pr_head_sha !== null ? { prHeadSha: String(row.pr_head_sha) } : {}),
        ...(row.last_blocking_review_head_sha !== null ? { lastBlockingReviewHeadSha: String(row.last_blocking_review_head_sha) } : {}),
        ...(row.last_github_failure_check_name !== null ? { latestFailureCheckName: String(row.last_github_failure_check_name) } : {}),
      });
      // The derivation (issue-execution-state.ts via waiting-reason.ts) is the
      // single source; the stored session projection is only a fallback for
      // rows whose live facts derive no reason. A detached active run means
      // the projection is stale, so it is not consulted at all.
      const waitingReason = derivedWaitingReason ?? (detachedActiveRun ? undefined : sessionWaitingReason);
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
      const derivedStatusNote = deriveIssueStatusNote({
        issue: issueFacts,
        sessionSummary,
        latestRun: latestRun as never,
        latestEvent,
        failureSummary,
        blockedByKeys,
        waitingReason,
      });
      const statusNoteCandidate = derivedStatusNote
        ?? (waitingReason === "PatchRelay work is complete" ? undefined : waitingReason);
      const statusNoteForReturn = shouldSuppressStatusNote({
        activeRunType: effectiveActiveRunType,
        sessionState: detachedActiveRun ? "running" : row.session_state as string | null | undefined,
        statusNote: statusNoteCandidate,
      })
        ? undefined
        : statusNoteCandidate;
      const activeCompletionCheckThreadId = row.active_run_type !== null
        ? row.active_completion_check_thread_id
        : detachedActiveRun
          ? row.latest_run_completion_check_thread_id
          : null;
      const activeCompletionCheckOutcome = row.active_run_type !== null
        ? row.active_completion_check_outcome
        : detachedActiveRun
          ? row.latest_run_completion_check_outcome
          : null;
      const completionCheckActive = typeof activeCompletionCheckThreadId === "string"
        && activeCompletionCheckThreadId.length > 0
        && activeCompletionCheckOutcome === null
        && effectiveActiveRunType !== undefined;

      return {
        ...(row.issue_key !== null ? { issueKey: String(row.issue_key) } : {}),
        ...(row.title !== null ? { title: String(row.title) } : {}),
        ...(statusNoteForReturn ? { statusNote: statusNoteForReturn } : {}),
        projectId: String(row.project_id),
        delegatedToPatchRelay: row.delegated_to_patchrelay === null ? true : Number(row.delegated_to_patchrelay) !== 0,
        ...(row.session_state !== null ? { sessionState: detachedActiveRun ? "running" : String(row.session_state) } : {}),
        phase: deriveIssuePhase({
          ...issueFacts,
          activeRunType: effectiveActiveRunType as never,
          runnableTaskRunType: runnableWorkflowTask?.runType,
        }),
        blockedByCount,
        blockedByKeys,
        readyForExecution,
        ...(row.current_linear_state !== null ? { currentLinearState: String(row.current_linear_state) } : {}),
        ...(effectiveActiveRunType ? { activeRunType: effectiveActiveRunType } : {}),
        ...(runnableWorkflowTask?.runType ? { runnableTaskRunType: runnableWorkflowTask.runType } : {}),
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
