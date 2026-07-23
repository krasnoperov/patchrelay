import type { Logger } from "pino";
import { extractCompletionCheck } from "./completion-check.ts";
import type { PatchRelayDatabase } from "./db.ts";
import type { IssueRecord, TrackedIssueRecord } from "./db-types.ts";
import type { RunType } from "./run-type.ts";
import { isClosedPrState } from "./pr-state.ts";
import { derivePrDisplayContext } from "./pr-display-context.ts";
import { deriveIssueStatusNote } from "./status-note.ts";
import { derivePatchRelayWaitingReason } from "./waiting-reason.ts";
import { peekRunnableWorkflowTaskRunType } from "./pending-workflow-task.ts";
import {
  isIssueAwaitingInputProjection,
  isIssueCiRepairProjection,
  isIssueDoneProjection,
  isIssueTerminalFailureProjection,
} from "./issue-execution-state.ts";
import type { LinearClientProvider } from "./types.ts";
import { deriveIssuePhase, type IssuePhase } from "./issue-phase.ts";

const WRITER = "linear-status-comment-sync";

// Idempotence guard: skip the Linear write when the target comment already
// carries the body we are about to write. Without this, every sync re-updates
// the comment, Linear echoes a commentUpdated webhook, and any webhook-driven
// sync path turns into a self-sustaining update loop (observed live: USE-478
// collapsed its placeholder every ~30-60s for two hours, ~90 comment writes).
// Process-lifetime cache keyed by comment id; a restart costs at most one
// redundant write per comment, which the cache then absorbs.
const lastWrittenCommentBody = new Map<string, string>();

function shouldSkipCommentWrite(commentId: string | undefined, body: string): boolean {
  return commentId !== undefined && lastWrittenCommentBody.get(commentId) === body;
}

function noteCommentWrite(commentId: string, body: string): void {
  // Bound the cache; entries are tiny but issues are unbounded over months.
  if (lastWrittenCommentBody.size > 5000) lastWrittenCommentBody.clear();
  lastWrittenCommentBody.set(commentId, body);
}

export async function syncVisibleStatusComment(params: {
  db: PatchRelayDatabase;
  issue: IssueRecord;
  linear: NonNullable<Awaited<ReturnType<LinearClientProvider["forProject"]>>>;
  logger: Logger;
  trackedIssue?: TrackedIssueRecord;
  options?: { activeRunType?: RunType };
}): Promise<void> {
  const { db, issue, linear, logger, trackedIssue, options } = params;
  try {
    const body = renderStatusComment(db, issue, trackedIssue, options);
    if (shouldSkipCommentWrite(issue.statusCommentId, body)) {
      return;
    }
    const result = await linear.upsertIssueComment({
      issueId: issue.linearIssueId,
      ...(issue.statusCommentId ? { commentId: issue.statusCommentId } : {}),
      body,
    });
    noteCommentWrite(result.id, body);
    if (result.id !== issue.statusCommentId) {
      db.issueSessions.commitIssueState({
        writer: WRITER,
        update: {
          projectId: issue.projectId,
          linearIssueId: issue.linearIssueId,
          statusCommentId: result.id,
        },
      });
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.warn({ issueKey: issue.issueKey, error: msg }, "Failed to sync Linear status comment");
  }
}

export function shouldSyncVisibleIssueComment(
  issue: Pick<IssueRecord,
    | "prNumber" | "prUrl" | "prState" | "delegatedToPatchRelay" | "workflowOutcome" | "inputRequestKind"
    | "currentLinearState" | "currentLinearStateType"
  >,
  hasAgentSession: boolean,
): boolean {
  if (!hasAgentSession) {
    return true;
  }
  if (isIssueAwaitingInputProjection(issue)) {
    return true;
  }
  if (isIssueTerminalFailureProjection(issue)) {
    return true;
  }
  if (isIssueDoneProjection(issue)) {
    return issue.prState !== "merged";
  }
  return false;
}

export async function collapseVisibleStatusComment(params: {
  issue: Pick<IssueRecord, "projectId" | "linearIssueId" | "statusCommentId">;
  linear: NonNullable<Awaited<ReturnType<LinearClientProvider["forProject"]>>>;
  logger: Logger;
}): Promise<void> {
  const { issue, linear, logger } = params;
  if (!issue.statusCommentId) {
    return;
  }
  try {
    const body = renderCollapsedStatusComment();
    if (shouldSkipCommentWrite(issue.statusCommentId, body)) {
      return;
    }
    await linear.upsertIssueComment({
      issueId: issue.linearIssueId,
      commentId: issue.statusCommentId,
      body,
    });
    noteCommentWrite(issue.statusCommentId, body);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.warn({ issueId: issue.linearIssueId, error: msg }, "Failed to collapse Linear status comment");
  }
}

function renderStatusComment(
  db: PatchRelayDatabase,
  issue: IssueRecord,
  trackedIssue: TrackedIssueRecord | undefined,
  options?: { activeRunType?: RunType },
): string {
  const activeRun = issue.activeRunId ? db.runs.getRunById(issue.activeRunId) : undefined;
  const latestRun = db.runs.getLatestRunForIssue(issue.projectId, issue.linearIssueId);
  const latestEvent = db.issueSessions.listIssueSessionEvents(issue.projectId, issue.linearIssueId, { limit: 1 }).at(-1);
  const activeRunType = issue.activeRunId !== undefined
    ? (options?.activeRunType ?? activeRun?.runType)
    : undefined;
  const runnableTaskRunType = peekRunnableWorkflowTaskRunType(db, issue.projectId, issue.linearIssueId);
  const waitingReason = trackedIssue?.waitingReason ?? derivePatchRelayWaitingReason({
    delegatedToPatchRelay: issue.delegatedToPatchRelay,
    currentLinearState: issue.currentLinearState,
    currentLinearStateType: issue.currentLinearStateType,
    ...(activeRunType ? { activeRunType } : {}),
    ...(issue.activeRunId !== undefined ? { activeRunId: issue.activeRunId } : {}),
    workflowOutcome: issue.workflowOutcome,
    inputRequestKind: issue.inputRequestKind,
    ...(runnableTaskRunType ? { runnableTaskRunType } : {}),
    orchestrationSettleUntil: issue.orchestrationSettleUntil,
    ...(issue.prNumber !== undefined ? { prNumber: issue.prNumber } : {}),
    ...(issue.prState ? { prState: issue.prState } : {}),
    prHeadSha: issue.prHeadSha,
    prReviewState: issue.prReviewState,
    prCheckStatus: issue.prCheckStatus,
    lastBlockingReviewHeadSha: issue.lastBlockingReviewHeadSha,
    latestFailureCheckName: issue.lastGitHubFailureCheckName,
    lastGitHubFailureSource: issue.lastGitHubFailureSource,
    deployStartedAt: issue.deployStartedAt,
  });

  const lines = [
    "## PatchRelay status",
    "",
    statusHeadline(
      trackedIssue
        ? {
            ...trackedIssue,
            phase: trackedIssue.phase,
            delegatedToPatchRelay: issue.delegatedToPatchRelay,
            prNumber: issue.prNumber,
            prReviewState: issue.prReviewState,
            prCheckStatus: issue.prCheckStatus,
          }
        : { ...issue, phase: deriveIssuePhase({ ...issue, activeRunType, runnableTaskRunType }) },
      activeRunType,
    ),
  ];
  const statusNote = trackedIssue?.statusNote ?? deriveIssueStatusNote({ issue, latestRun, latestEvent, waitingReason });

  if (waitingReason) {
    lines.push("", `Waiting: ${waitingReason}`);
  }
  if (statusNote && statusNote !== waitingReason) {
    const label = isIssueAwaitingInputProjection(issue) ? "Input needed"
      : isIssueTerminalFailureProjection(issue) ? "Action needed"
      : "Note";
    lines.push("", `${label}: ${statusNote}`);
  }

  const completionCheck = extractCompletionCheck(latestRun);
  if (completionCheck?.outcome === "needs_input") {
    if (completionCheck.why) {
      lines.push("", `Why: ${completionCheck.why}`);
    }
    if (completionCheck.recommendedReply) {
      lines.push("", `Suggested reply: ${completionCheck.recommendedReply}`);
    }
    const issueRef = issue.issueKey ?? issue.linearIssueId;
    lines.push("", `Reply in a Linear comment to continue, or run \`patchrelay issue prompt ${issueRef} "..."\`.`);
  }

  if (issue.prNumber !== undefined || issue.prUrl) {
    const prContext = derivePrDisplayContext(issue);
    const prLabel = issue.prNumber !== undefined ? `#${issue.prNumber}` : "open";
    const linkedLabel = issue.prUrl ? `[${prLabel}](${issue.prUrl})` : prLabel;
    const prLine = prContext.kind === "closed_historical_pr"
      ? `Previous PR: ${linkedLabel} (closed)`
      : prContext.kind === "closed_replacement_pending"
        ? `Previous PR: ${linkedLabel} (closed; replacement PR needed)`
        : prContext.kind === "closed_pr_paused"
          ? `Previous PR: ${linkedLabel} (closed; redelegate to replace it)`
          : `PR: ${linkedLabel}`;
    lines.push("", prLine);
  }

  if (issue.lastGitHubFailureCheckName && isIssueCiRepairProjection(issue)) {
    lines.push("", `Latest failing check: ${issue.lastGitHubFailureCheckName}`);
  }

  return lines.join("\n");
}

function renderCollapsedStatusComment(): string {
  return [
    "## PatchRelay status",
    "",
    "No human action needed. PatchRelay is updating the Linear agent session activity feed; this placeholder will be reused if human input is needed later.",
  ].join("\n");
}

function statusHeadline(
  issue: {
    phase: IssuePhase;
    prNumber?: number | undefined;
    prState?: string | undefined;
    delegatedToPatchRelay: boolean;
    prReviewState?: string | undefined;
    prCheckStatus?: string | undefined;
    workflowOutcome?: "completed" | "failed" | "escalated" | undefined;
    inputRequestKind?: "paused_local_work" | "completion_check_question" | undefined;
  },
  activeRunType?: string,
): string {
  const prContext = derivePrDisplayContext(issue);
  if (activeRunType) {
    return `Running ${humanize(activeRunType)}`;
  }
  if (!issue.delegatedToPatchRelay && issue.prNumber !== undefined) {
    if (prContext.kind === "closed_pr_paused") {
      return `Closed PR #${prContext.prNumber} is waiting for redelegation before replacement`;
    }
    if (issue.phase === "awaiting_queue") {
      return `PR #${issue.prNumber} is awaiting downstream merge while PatchRelay is paused`;
    }
    if (issue.phase === "changes_requested") {
      return `PR #${issue.prNumber} has requested changes while PatchRelay is paused`;
    }
    if (issue.phase === "repairing_ci") {
      return `PR #${issue.prNumber} has failing CI while PatchRelay is paused`;
    }
    return `PR #${issue.prNumber} is awaiting review while PatchRelay is paused`;
  }
  if (!issue.delegatedToPatchRelay) {
    if (issue.phase === "implementing") {
      return "Implementation is paused because the issue is undelegated";
    }
    if (issue.phase === "delegated") {
      return "Queued to start work while PatchRelay is paused";
    }
  }
  switch (issue.phase) {
    case "delegated":
      if (prContext.kind === "closed_replacement_pending") {
        return `Queued to replace closed PR #${prContext.prNumber}`;
      }
      return "Queued to start work";
    case "implementing":
      if (prContext.kind === "closed_replacement_pending") {
        return `Replacing closed PR #${prContext.prNumber} with a fresh PR`;
      }
      return "Implementing requested change";
    case "pr_open":
      return issue.prNumber !== undefined ? `PR #${issue.prNumber} opened` : "PR opened";
    case "changes_requested":
      return "Addressing requested review changes";
    case "repairing_ci":
      return "Repairing failing CI";
    case "awaiting_queue":
      return "Handed off downstream for merge";
    case "repairing_queue":
      return "Repairing merge handoff";
    case "deploying":
      return issue.prNumber !== undefined ? `Deploying merged PR #${issue.prNumber}` : "Deploying after merge";
    case "awaiting_input":
      return "Waiting for more input";
    case "failed":
      return "Needs operator intervention";
    case "escalated":
      return "Needs operator intervention";
    case "done":
      if (issue.prNumber !== undefined && issue.prState === "merged") return `Completed with merged PR #${issue.prNumber}`;
      if (issue.prNumber !== undefined && isClosedPrState(issue.prState)) return `Completed without merging PR #${issue.prNumber}`;
      return issue.prNumber !== undefined ? `Completed with PR #${issue.prNumber}` : "Completed";
    case "paused":
      return "PatchRelay automation is paused";
  }
}

function humanize(value: string): string {
  return value.replaceAll("_", " ");
}
