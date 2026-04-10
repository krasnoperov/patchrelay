import type { Logger } from "pino";
import { extractCompletionCheck } from "./completion-check.ts";
import type { PatchRelayDatabase } from "./db.ts";
import type { IssueRecord, RunRecord, TrackedIssueRecord } from "./db-types.ts";
import type { RunType } from "./factory-state.ts";
import { deriveIssueStatusNote } from "./status-note.ts";
import { derivePatchRelayWaitingReason } from "./waiting-reason.ts";
import { isClosedPrState } from "./pr-state.ts";
import { isUndelegatedPausedIssue } from "./paused-issue-state.ts";
import type { LinearClientProvider } from "./types.ts";

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
    const result = await linear.upsertIssueComment({
      issueId: issue.linearIssueId,
      ...(issue.statusCommentId ? { commentId: issue.statusCommentId } : {}),
      body,
    });
    if (result.id !== issue.statusCommentId) {
      db.issues.upsertIssue({
        projectId: issue.projectId,
        linearIssueId: issue.linearIssueId,
        statusCommentId: result.id,
      });
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.warn({ issueKey: issue.issueKey, error: msg }, "Failed to sync Linear status comment");
  }
}

export function shouldSyncVisibleIssueComment(
  issue: Pick<IssueRecord, "factoryState" | "prNumber" | "prUrl" | "prState" | "delegatedToPatchRelay"> & {
    sessionState?: string | undefined;
  },
  hasAgentSession: boolean,
): boolean {
  if (!hasAgentSession) {
    return true;
  }

  if (issue.sessionState === "waiting_input" || issue.sessionState === "failed"
    || issue.factoryState === "awaiting_input" || issue.factoryState === "failed" || issue.factoryState === "escalated") {
    return true;
  }

  if (isUndelegatedPausedIssue(issue)) {
    return true;
  }

  if (
    (issue.sessionState === "done" || issue.factoryState === "done")
    && (
      (issue.prNumber === undefined && !issue.prUrl)
      || isClosedPrState(issue.prState)
    )
  ) {
    return true;
  }

  return false;
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
  const waitingReason = trackedIssue?.waitingReason ?? derivePatchRelayWaitingReason({
    delegatedToPatchRelay: issue.delegatedToPatchRelay,
    ...(activeRunType ? { activeRunType } : {}),
    ...(issue.activeRunId !== undefined ? { activeRunId: issue.activeRunId } : {}),
    factoryState: issue.factoryState,
    pendingRunType: issue.pendingRunType,
    ...(issue.prNumber !== undefined ? { prNumber: issue.prNumber } : {}),
    ...(issue.prState ? { prState: issue.prState } : {}),
    prHeadSha: issue.prHeadSha,
    prReviewState: issue.prReviewState,
    prCheckStatus: issue.prCheckStatus,
    lastBlockingReviewHeadSha: issue.lastBlockingReviewHeadSha,
    latestFailureCheckName: issue.lastGitHubFailureCheckName,
  });

  const lines = [
    "## PatchRelay status",
    "",
    statusHeadline(
      trackedIssue
        ? {
            ...trackedIssue,
            delegatedToPatchRelay: issue.delegatedToPatchRelay,
            prNumber: issue.prNumber,
            prReviewState: issue.prReviewState,
            prCheckStatus: issue.prCheckStatus,
          }
        : issue,
      activeRunType,
    ),
  ];
  const statusNote = trackedIssue?.statusNote ?? deriveIssueStatusNote({ issue, latestRun, latestEvent, waitingReason });

  if (waitingReason) {
    lines.push("", `Waiting: ${waitingReason}`);
  }
  if (statusNote && statusNote !== waitingReason) {
    const label = trackedIssue?.sessionState === "waiting_input" || issue.factoryState === "awaiting_input" ? "Input needed"
      : trackedIssue?.sessionState === "failed" || issue.factoryState === "failed" || issue.factoryState === "escalated" ? "Action needed"
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
    const prLabel = issue.prNumber !== undefined ? `#${issue.prNumber}` : "open";
    lines.push("", `PR: ${issue.prUrl ? `[${prLabel}](${issue.prUrl})` : prLabel}`);
  }

  if (latestRun) {
    lines.push("", `Latest run: ${formatLatestRun(latestRun)}`);
    if (latestRun.failureReason) {
      lines.push("", `Failure: ${latestRun.failureReason}`);
    }
    if (completionCheck && completionCheck.outcome !== "needs_input" && completionCheck.summary !== statusNote) {
      lines.push("", `Completion check: ${completionCheck.summary}`);
    }
  }

  if (issue.lastGitHubFailureCheckName && (issue.factoryState === "repairing_ci" || issue.prCheckStatus === "failed" || issue.prCheckStatus === "failure")) {
    lines.push("", `Latest failing check: ${issue.lastGitHubFailureCheckName}`);
  }

  lines.push(
    "",
    "_PatchRelay updates this comment as it works. Review and merge remain downstream._",
  );

  return lines.join("\n");
}

function statusHeadline(
  issue: Pick<IssueRecord, "factoryState" | "prNumber" | "prState" | "delegatedToPatchRelay" | "prReviewState" | "prCheckStatus"> & {
    sessionState?: string | undefined;
    waitingReason?: string | undefined;
  },
  activeRunType?: string,
): string {
  if (activeRunType) {
    return `Running ${humanize(activeRunType)}`;
  }
  switch (issue.sessionState) {
    case "waiting_input":
      return issue.waitingReason ?? "Waiting for more input";
    case "running":
      return issue.prNumber !== undefined ? `PR #${issue.prNumber} is actively running` : "Actively running";
    case "done":
      if (issue.prNumber !== undefined && issue.prState === "merged") return `Completed with merged PR #${issue.prNumber}`;
      if (issue.prNumber !== undefined && isClosedPrState(issue.prState)) return `Completed without merging PR #${issue.prNumber}`;
      return issue.prNumber !== undefined ? `Completed with PR #${issue.prNumber}` : "Completed";
    case "failed":
      return "Needs operator intervention";
    default:
      break;
  }
  if (!issue.delegatedToPatchRelay && issue.prNumber !== undefined) {
    if (issue.factoryState === "awaiting_queue" || issue.prReviewState === "approved") {
      return `PR #${issue.prNumber} is awaiting downstream merge while PatchRelay is paused`;
    }
    if (issue.factoryState === "changes_requested" || issue.prReviewState === "changes_requested") {
      return `PR #${issue.prNumber} has requested changes while PatchRelay is paused`;
    }
    if (issue.factoryState === "repairing_ci" || issue.prCheckStatus === "failed" || issue.prCheckStatus === "failure") {
      return `PR #${issue.prNumber} has failing CI while PatchRelay is paused`;
    }
    return `PR #${issue.prNumber} is awaiting review while PatchRelay is paused`;
  }
  if (!issue.delegatedToPatchRelay) {
    if (issue.factoryState === "implementing") {
      return "Implementation is paused because the issue is undelegated";
    }
    if (issue.factoryState === "delegated") {
      return "Queued to start work while PatchRelay is paused";
    }
  }
  switch (issue.factoryState) {
    case "delegated":
      return "Queued to start work";
    case "implementing":
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
    default:
      return humanize(issue.factoryState);
  }
}

function formatLatestRun(run: Pick<RunRecord, "runType" | "status" | "endedAt" | "startedAt">): string {
  const at = run.endedAt ?? run.startedAt;
  return `${humanize(run.runType)} ${run.status} at ${at}`;
}

function humanize(value: string): string {
  return value.replaceAll("_", " ");
}
