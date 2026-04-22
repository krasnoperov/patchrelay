import type { Logger } from "pino";
import type { PatchRelayDatabase } from "./db.ts";
import type { IssueRecord } from "./db-types.ts";
import { summarizeGitHubFailureContext, type GitHubFailureContextResolver } from "./github-failure-context.ts";
import type { NormalizedGitHubEvent } from "./github-types.ts";
import { buildQueueRepairContextFromEvent } from "./merge-queue-incident.ts";
import { isIssueTerminal } from "./pr-state.ts";
import type { OperatorEventFeed } from "./operator-feed.ts";
import type { ProjectConfig } from "./workflow-types.ts";
import {
  buildGitHubQueueFailureContext,
  getRelevantGitHubCiSnapshot,
  resolveGitHubBranchFailureContext,
  resolveGitHubCheckClass,
} from "./github-webhook-failure-context.ts";
import { isQueueEvictionFailure, isSettledBranchFailure } from "./github-webhook-policy.ts";

type FetchLike = typeof fetch;

interface GitHubReviewThreadComment {
  id: number;
  body: string;
  path?: string | undefined;
  line?: number | undefined;
  side?: string | undefined;
  startLine?: number | undefined;
  startSide?: string | undefined;
  commitId?: string | undefined;
  url?: string | undefined;
  diffHunk?: string | undefined;
  authorLogin?: string | undefined;
}

export async function maybeEnqueueGitHubReactiveRun(params: {
  db: PatchRelayDatabase;
  logger: Logger;
  feed: OperatorEventFeed | undefined;
  enqueueIssue: (projectId: string, issueId: string) => void;
  issue: IssueRecord;
  event: NormalizedGitHubEvent;
  project: ProjectConfig | undefined;
  failureContextResolver: GitHubFailureContextResolver;
  fetchImpl: FetchLike;
}): Promise<void> {
  const { issue, event, project, logger, feed, enqueueIssue, db, fetchImpl, failureContextResolver } = params;

  if (isIssueTerminal(issue)) return;

  if (!issue.delegatedToPatchRelay) {
    feed?.publish({
      level: "info",
      kind: "github",
      issueKey: issue.issueKey,
      projectId: issue.projectId,
      stage: issue.factoryState,
      status: "ignored_undelegated",
      summary: `Ignored ${event.triggerEvent} because the issue is undelegated`,
    });
    return;
  }

  if (event.triggerEvent === "check_failed" && issue.prState === "open") {
    if (issue.activeRunId !== undefined) {
      return;
    }
    await handleCheckFailedEvent({
      db,
      logger,
      feed,
      enqueueIssue,
      issue,
      event,
      project,
      failureContextResolver,
    });
    return;
  }

  if (event.triggerEvent === "review_changes_requested") {
    await handleRequestedChangesEvent({
      db,
      logger,
      feed,
      enqueueIssue,
      issue,
      event,
      fetchImpl,
    });
  }
}

async function handleCheckFailedEvent(params: {
  db: PatchRelayDatabase;
  logger: Logger;
  feed: OperatorEventFeed | undefined;
  enqueueIssue: (projectId: string, issueId: string) => void;
  issue: IssueRecord;
  event: NormalizedGitHubEvent;
  project: ProjectConfig | undefined;
  failureContextResolver: GitHubFailureContextResolver;
}): Promise<void> {
  const { db, logger, feed, enqueueIssue, issue, event, project, failureContextResolver } = params;
  if (isQueueEvictionFailure(issue, event, project)) {
    const queueRepairContext = buildQueueRepairContextFromEvent(event);
    const failureContext = buildGitHubQueueFailureContext(event, project, queueRepairContext);
    if (hasDuplicatePendingReactiveRun(db, feed, issue, "queue_repair", failureContext)) {
      return;
    }
    const hadPendingWake = db.issueSessions.hasPendingIssueSessionEvents(issue.projectId, issue.linearIssueId);
    db.issueSessions.appendIssueSessionEventRespectingActiveLease(issue.projectId, issue.linearIssueId, {
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      eventType: "merge_steward_incident",
      eventJson: JSON.stringify({
        ...queueRepairContext,
        ...failureContext,
      }),
      dedupeKey: failureContext.failureSignature,
    });
    const queuedRunType = hadPendingWake
      ? db.issueSessions.peekIssueSessionWake(issue.projectId, issue.linearIssueId)?.runType
      : enqueuePendingSessionWake(db, enqueueIssue, issue.projectId, issue.linearIssueId);
    logger.info({ issueKey: issue.issueKey, checkName: event.checkName }, "Queue eviction detected, enqueued queue repair");
    feed?.publish({
      level: "warn",
      kind: "github",
      issueKey: issue.issueKey,
      projectId: issue.projectId,
      stage: "repairing_queue",
      status: "queue_repair_queued",
      summary: `${queuedRunType ?? "queue_repair"} queued after external failure from ${event.checkName}`,
      detail: queueRepairContext.incidentSummary ?? queueRepairContext.incidentUrl ?? event.checkUrl,
    });
    return;
  }

  if (!isSettledBranchFailure(db, issue, event, project)) {
    feed?.publish({
      level: "info",
      kind: "github",
      issueKey: issue.issueKey,
      projectId: issue.projectId,
      stage: issue.factoryState,
      status: "ci_waiting_for_settlement",
      summary: `Waiting for settled ${project?.gateChecks?.[0] ?? "verify"} result before starting CI repair`,
    });
    return;
  }

  const failureContext = await resolveGitHubBranchFailureContext({
    db,
    issue,
    event,
    project,
    failureContextResolver,
  });
  if (hasDuplicatePendingReactiveRun(db, feed, issue, "ci_repair", failureContext)) {
    return;
  }
  const hadPendingWake = db.issueSessions.hasPendingIssueSessionEvents(issue.projectId, issue.linearIssueId);
  const snapshot = getRelevantGitHubCiSnapshot(db, issue, event);
  db.issues.upsertIssue({
    projectId: issue.projectId,
    linearIssueId: issue.linearIssueId,
    lastGitHubFailureSource: "branch_ci",
    lastGitHubFailureHeadSha: failureContext.failureHeadSha ?? null,
    lastGitHubFailureSignature: failureContext.failureSignature ?? null,
    lastGitHubFailureCheckName: failureContext.checkName ?? event.checkName ?? null,
    lastGitHubFailureCheckUrl: failureContext.checkUrl ?? event.checkUrl ?? null,
    lastGitHubFailureContextJson: JSON.stringify(failureContext),
    lastGitHubFailureAt: new Date().toISOString(),
    lastQueueIncidentJson: null,
  });
  db.issueSessions.appendIssueSessionEventRespectingActiveLease(issue.projectId, issue.linearIssueId, {
    projectId: issue.projectId,
    linearIssueId: issue.linearIssueId,
    eventType: "settled_red_ci",
    eventJson: JSON.stringify({
      ...failureContext,
      checkClass: resolveGitHubCheckClass(failureContext.checkName ?? event.checkName, project),
      ...(snapshot ? { ciSnapshot: snapshot } : {}),
    }),
    dedupeKey: failureContext.failureSignature,
  });
  const queuedRunType = hadPendingWake
    ? db.issueSessions.peekIssueSessionWake(issue.projectId, issue.linearIssueId)?.runType
    : enqueuePendingSessionWake(db, enqueueIssue, issue.projectId, issue.linearIssueId);
  logger.info({ issueKey: issue.issueKey, checkName: failureContext.checkName ?? event.checkName }, "Enqueued CI repair run");
  feed?.publish({
    level: "warn",
    kind: "github",
    issueKey: issue.issueKey,
    projectId: issue.projectId,
    stage: "repairing_ci",
    status: "ci_repair_queued",
    summary: `${queuedRunType ?? "ci_repair"} queued for ${failureContext.jobName ?? failureContext.checkName ?? "failed check"}`,
    detail: summarizeGitHubFailureContext(failureContext),
  });
}

async function handleRequestedChangesEvent(params: {
  db: PatchRelayDatabase;
  logger: Logger;
  feed: OperatorEventFeed | undefined;
  enqueueIssue: (projectId: string, issueId: string) => void;
  issue: IssueRecord;
  event: NormalizedGitHubEvent;
  fetchImpl: FetchLike;
}): Promise<void> {
  const { db, logger, feed, enqueueIssue, issue, event, fetchImpl } = params;
  const hadPendingWake = db.issueSessions.hasPendingIssueSessionEvents(issue.projectId, issue.linearIssueId);
  const reviewComments = await fetchReviewCommentsForEvent(event, fetchImpl).catch((error) => {
    logger.warn(
      {
        issueKey: issue.issueKey,
        prNumber: event.prNumber,
        reviewId: event.reviewId,
        error: error instanceof Error ? error.message : String(error),
      },
      "Failed to fetch inline review comments for requested-changes event",
    );
    return undefined;
  });
  db.issueSessions.appendIssueSessionEventRespectingActiveLease(issue.projectId, issue.linearIssueId, {
    projectId: issue.projectId,
    linearIssueId: issue.linearIssueId,
    eventType: "review_changes_requested",
    eventJson: JSON.stringify({
      reviewBody: event.reviewBody,
      reviewCommitId: event.reviewCommitId,
      reviewId: event.reviewId,
      reviewUrl: buildGitHubReviewUrl(event.repoFullName, event.prNumber, event.reviewId),
      reviewerName: event.reviewerName,
      ...(reviewComments && reviewComments.length > 0 ? { reviewComments } : {}),
    }),
    dedupeKey: [
      "review_changes_requested",
      issue.prHeadSha ?? event.headSha ?? "unknown-sha",
      event.reviewerName ?? "unknown-reviewer",
    ].join("::"),
  });
  const queuedRunType = hadPendingWake
    ? db.issueSessions.peekIssueSessionWake(issue.projectId, issue.linearIssueId)?.runType
    : issue.activeRunId === undefined
      ? enqueuePendingSessionWake(db, enqueueIssue, issue.projectId, issue.linearIssueId)
      : db.issueSessions.peekIssueSessionWake(issue.projectId, issue.linearIssueId)?.runType;
  logger.info(
    {
      issueKey: issue.issueKey,
      reviewerName: event.reviewerName,
      deferredUntilRunRelease: issue.activeRunId !== undefined,
    },
    "Captured requested-changes follow-up",
  );
  feed?.publish({
    level: "warn",
    kind: "github",
    issueKey: issue.issueKey,
    projectId: issue.projectId,
    stage: "changes_requested",
    status: "review_fix_queued",
    summary: issue.activeRunId === undefined
      ? `${queuedRunType ?? "review_fix"} queued after requested changes`
      : `${queuedRunType ?? "review_fix"} recorded and will resume after the active run finishes`,
    detail: reviewComments && reviewComments.length > 0
      ? `${reviewComments.length} inline review comment${reviewComments.length === 1 ? "" : "s"} captured`
      : event.reviewBody?.slice(0, 200) ?? event.reviewerName,
  });
}

function hasDuplicatePendingReactiveRun(
  db: PatchRelayDatabase,
  feed: OperatorEventFeed | undefined,
  issue: IssueRecord,
  runType: "ci_repair" | "queue_repair",
  failureContext: { failureSignature?: string | undefined; failureHeadSha?: string | undefined; headSha?: string | undefined },
): boolean {
  const signature = typeof failureContext.failureSignature === "string" ? failureContext.failureSignature : undefined;
  const headSha = typeof failureContext.failureHeadSha === "string"
    ? failureContext.failureHeadSha
    : typeof failureContext.headSha === "string" ? failureContext.headSha : undefined;
  if (!signature) return false;

  const pendingWake = db.issueSessions.peekIssueSessionWake(issue.projectId, issue.linearIssueId);
  if (pendingWake?.runType === runType && pendingWake.eventIds.length > 0) {
    const existing = pendingWake.context;
    if (existing?.failureSignature === signature
      && (headSha === undefined || existing.failureHeadSha === headSha || existing.headSha === headSha)) {
      feed?.publish({
        level: "info",
        kind: "github",
        issueKey: issue.issueKey,
        projectId: issue.projectId,
        stage: issue.factoryState,
        status: "repair_deduped",
        summary: `Skipped duplicate ${runType} for ${signature}`,
      });
      return true;
    }
  }

  if (issue.lastAttemptedFailureSignature === signature
    && (headSha === undefined || issue.lastAttemptedFailureHeadSha === headSha)) {
    feed?.publish({
      level: "info",
      kind: "github",
      issueKey: issue.issueKey,
      projectId: issue.projectId,
      stage: issue.factoryState,
      status: "repair_deduped",
      summary: `Already attempted ${runType} for this failing PR head`,
    });
    return true;
  }

  return false;
}

function enqueuePendingSessionWake(
  db: PatchRelayDatabase,
  enqueueIssue: (projectId: string, issueId: string) => void,
  projectId: string,
  issueId: string,
): string | undefined {
  const wake = db.issueSessions.peekIssueSessionWake(projectId, issueId);
  if (!wake) {
    return undefined;
  }
  enqueueIssue(projectId, issueId);
  return wake.runType;
}

async function fetchReviewCommentsForEvent(
  event: NormalizedGitHubEvent,
  fetchImpl: FetchLike,
): Promise<GitHubReviewThreadComment[] | undefined> {
  if (event.triggerEvent !== "review_changes_requested") {
    return undefined;
  }
  if (!event.repoFullName || event.prNumber === undefined || event.reviewId === undefined) {
    return undefined;
  }

  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (!token) {
    return undefined;
  }

  const [owner, repo] = event.repoFullName.split("/", 2);
  if (!owner || !repo) {
    return undefined;
  }

  const response = await fetchImpl(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${event.prNumber}/reviews/${event.reviewId}/comments?per_page=100`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "patchrelay",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );
  if (!response.ok) {
    throw new Error(`GitHub review comment fetch failed (${response.status})`);
  }

  const payload = await response.json() as unknown;
  if (!Array.isArray(payload)) {
    return undefined;
  }

  const comments: GitHubReviewThreadComment[] = [];
  for (const entry of payload) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const body = typeof record.body === "string" ? record.body.trim() : "";
    const id = typeof record.id === "number" ? record.id : undefined;
    if (!body || id === undefined) continue;
    comments.push({
      id,
      body,
      ...(typeof record.path === "string" ? { path: record.path } : {}),
      ...(typeof record.line === "number" ? { line: record.line } : {}),
      ...(typeof record.side === "string" ? { side: record.side } : {}),
      ...(typeof record.start_line === "number" ? { startLine: record.start_line } : {}),
      ...(typeof record.start_side === "string" ? { startSide: record.start_side } : {}),
      ...(typeof record.commit_id === "string" ? { commitId: record.commit_id } : {}),
      ...(typeof record.html_url === "string" ? { url: record.html_url } : {}),
      ...(typeof record.diff_hunk === "string" ? { diffHunk: record.diff_hunk } : {}),
      ...(typeof (record.user as Record<string, unknown> | undefined)?.login === "string"
        ? { authorLogin: String((record.user as Record<string, unknown>).login) }
        : {}),
    });
  }

  return comments;
}

function buildGitHubReviewUrl(
  repoFullName: string | undefined,
  prNumber: number | undefined,
  reviewId: number | undefined,
): string | undefined {
  if (!repoFullName || prNumber === undefined || reviewId === undefined) {
    return undefined;
  }
  return `https://github.com/${repoFullName}/pull/${prNumber}#pullrequestreview-${reviewId}`;
}
