import type { Logger } from "pino";
import type { PatchRelayDatabase } from "./db.ts";
import type { IssueRecord } from "./db-types.ts";
import type { LinearClientProvider } from "./types.ts";
import type { OperatorEventFeed } from "./operator-feed.ts";
import type { NormalizedGitHubEvent } from "./github-types.ts";
import { resolveClosedPrDisposition, resolveClosedPrFactoryState } from "./pr-state.ts";
import { resolvePreferredCompletedLinearState } from "./linear-workflow.ts";
import { syncGitHubLinearSession } from "./github-linear-session-sync.ts";
import type { AppConfig } from "./types.ts";

export async function handleGitHubTerminalPrEvent(params: {
  config: AppConfig;
  db: PatchRelayDatabase;
  linearProvider: LinearClientProvider;
  enqueueIssue: (projectId: string, issueId: string) => void;
  logger: Logger;
  codex: { steerTurn(options: { threadId: string; turnId: string; input: string }): Promise<void> };
  feed: OperatorEventFeed | undefined;
  issue: IssueRecord;
  event: NormalizedGitHubEvent;
}): Promise<void> {
  const { db, linearProvider, enqueueIssue, logger, codex, issue, event, config } = params;
  const eventType = event.triggerEvent === "pr_merged" ? "pr_merged" : "pr_closed";
  db.issueSessions.appendIssueSessionEvent({
    projectId: issue.projectId,
    linearIssueId: issue.linearIssueId,
    eventType,
    dedupeKey: [eventType, issue.prNumber ?? event.prNumber ?? "unknown-pr", issue.prHeadSha ?? event.headSha ?? "unknown-sha"].join("::"),
  });
  db.issueSessions.clearPendingIssueSessionEventsRespectingActiveLease(issue.projectId, issue.linearIssueId);

  const run = issue.activeRunId ? db.runs.getRunById(issue.activeRunId) : undefined;
  if (run?.threadId && run.turnId) {
    try {
      await codex.steerTurn({
        threadId: run.threadId,
        turnId: run.turnId,
        input: event.triggerEvent === "pr_merged"
          ? "STOP: The pull request has already merged. Stop working immediately and exit without making further changes."
          : "STOP: The pull request was closed. Stop working immediately and exit without making further changes.",
      });
    } catch (error) {
      logger.warn({ issueKey: issue.issueKey, runId: run.id, error: error instanceof Error ? error.message : String(error) }, "Failed to steer active run after terminal PR event");
    }
  }

  const commitTerminalUpdate = () => {
    if (run) {
      db.runs.finishRun(run.id, {
        status: "released",
        failureReason: event.triggerEvent === "pr_merged"
          ? "Pull request merged during active run"
          : "Pull request closed during active run",
      });
    }
    const terminalFactoryState = event.triggerEvent === "pr_merged"
      ? "done"
      : resolveClosedPrFactoryState(issue);
    db.issues.upsertIssue({
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      activeRunId: null,
      factoryState: terminalFactoryState,
    });
  };
  const activeLease = db.issueSessions.getActiveIssueSessionLease(issue.projectId, issue.linearIssueId);
  if (activeLease) {
    db.issueSessions.withIssueSessionLease(issue.projectId, issue.linearIssueId, activeLease.leaseId, commitTerminalUpdate);
  } else {
    db.transaction(commitTerminalUpdate);
  }
  db.issueSessions.releaseIssueSessionLeaseRespectingActiveLease(issue.projectId, issue.linearIssueId);
  const updatedIssue = db.issues.getIssue(issue.projectId, issue.linearIssueId) ?? issue;
  if (event.triggerEvent === "pr_closed" && resolveClosedPrDisposition(issue) === "redelegate") {
    db.issueSessions.appendIssueSessionEventRespectingActiveLease(issue.projectId, issue.linearIssueId, {
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      eventType: "delegated",
      dedupeKey: `github_pr_closed:implementation:${issue.linearIssueId}`,
    });
    if (db.issueSessions.peekIssueSessionWake(issue.projectId, issue.linearIssueId)) {
      enqueueIssue(issue.projectId, issue.linearIssueId);
    }
  }
  if (event.triggerEvent === "pr_merged") {
    await completeLinearIssueAfterMerge(params, updatedIssue);
  }
  void syncGitHubLinearSession({
    config,
    linearProvider,
    logger,
    issue: updatedIssue,
  });
}

async function completeLinearIssueAfterMerge(
  params: Pick<Parameters<typeof handleGitHubTerminalPrEvent>[0], "db" | "linearProvider" | "logger">,
  issue: IssueRecord,
): Promise<void> {
  const linear = await params.linearProvider.forProject(issue.projectId).catch(() => undefined);
  if (!linear) return;

  try {
    const liveIssue = await linear.getIssue(issue.linearIssueId);
    const targetState = resolvePreferredCompletedLinearState(liveIssue);
    if (!targetState) {
      params.logger.warn({ issueKey: issue.issueKey }, "Could not find a completed Linear workflow state after merge");
      return;
    }

    const normalizedCurrent = liveIssue.stateName?.trim().toLowerCase();
    if (normalizedCurrent === targetState.trim().toLowerCase()) {
      params.db.issues.upsertIssue({
        projectId: issue.projectId,
        linearIssueId: issue.linearIssueId,
        ...(liveIssue.stateName ? { currentLinearState: liveIssue.stateName } : {}),
        ...(liveIssue.stateType ? { currentLinearStateType: liveIssue.stateType } : {}),
      });
      return;
    }

    const updated = await linear.setIssueState(issue.linearIssueId, targetState);
    params.db.issues.upsertIssue({
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      ...(updated.stateName ? { currentLinearState: updated.stateName } : {}),
      ...(updated.stateType ? { currentLinearStateType: updated.stateType } : {}),
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    params.logger.warn({ issueKey: issue.issueKey, error: msg }, "Failed to move merged issue to a completed Linear state");
  }
}
