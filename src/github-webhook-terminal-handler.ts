import type { Logger } from "pino";
import type { PatchRelayDatabase } from "./db.ts";
import type { IssueRecord } from "./db-types.ts";
import type { LinearClientProvider } from "./types.ts";
import type { OperatorEventFeed } from "./operator-feed.ts";
import type { NormalizedGitHubEvent } from "./github-types.ts";
import { resolveClosedPrDisposition, resolveClosedPrFactoryState } from "./pr-state.ts";
import { resolvePostMergeFactoryState } from "./post-merge-deploy.ts";
import { resolvePreferredCompletedLinearState } from "./linear-workflow.ts";
import { syncGitHubLinearSession } from "./github-linear-session-sync.ts";
import type { AppConfig } from "./types.ts";
import { dispatchOrchestrationParentsForChildEvent } from "./orchestration-parent-dispatch.ts";
import type { WorkflowTaskDispatcher } from "./workflow-task-dispatcher.ts";

const WRITER = "github-webhook-terminal-handler";

export async function handleGitHubTerminalPrEvent(params: {
  config: AppConfig;
  db: PatchRelayDatabase;
  linearProvider: LinearClientProvider;
  workflowTaskDispatcher: WorkflowTaskDispatcher;
  logger: Logger;
  codex: { steerTurn(options: { threadId: string; turnId: string; input: string }): Promise<void> };
  feed: OperatorEventFeed | undefined;
  issue: IssueRecord;
  event: NormalizedGitHubEvent;
}): Promise<void> {
  const { db, linearProvider, workflowTaskDispatcher, logger, codex, issue, event, config } = params;
  const eventType = event.triggerEvent === "pr_merged" ? "pr_merged" : "pr_closed";
  // PR3: when the project configures a deploy workflow, a merge enters the
  // `deploying` watch state instead of completing immediately. Linear
  // completion is deferred until the deploy succeeds (idle reconciler).
  const project = config.projects.find((candidate) => candidate.id === issue.projectId);
  const postMergeState = resolvePostMergeFactoryState(project);
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

  const buildTerminalUpdate = (row: IssueRecord) => {
    const terminalFactoryState = event.triggerEvent === "pr_merged"
      ? postMergeState
      : resolveClosedPrFactoryState(row);
    return {
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      activeRunId: null,
      factoryState: terminalFactoryState,
      ...(terminalFactoryState === "deploying" ? { deployStartedAt: new Date().toISOString() } : {}),
    };
  };
  const activeLease = db.issueSessions.getActiveIssueSessionLease(issue.projectId, issue.linearIssueId);
  const terminalCommit = db.issueSessions.commitIssueState({
    writer: WRITER,
    expectedVersion: issue.version,
    ...(activeLease ? { lease: activeLease } : {}),
    update: buildTerminalUpdate(issue),
    // The terminal PR fact comes from GitHub; re-derive the closed-PR
    // disposition from the fresh row instead of dropping the event.
    onConflict: (current) => buildTerminalUpdate(current),
  });
  if (terminalCommit.outcome === "applied" && run) {
    db.runs.finishRun(run.id, {
      status: "released",
      failureReason: event.triggerEvent === "pr_merged"
        ? "Pull request merged during active run"
        : "Pull request closed during active run",
    });
  }
  db.issueSessions.releaseIssueSessionLeaseRespectingActiveLease(issue.projectId, issue.linearIssueId);
  const updatedIssue = db.issues.getIssue(issue.projectId, issue.linearIssueId) ?? issue;
  if (event.triggerEvent === "pr_closed" && resolveClosedPrDisposition(issue) === "redelegate") {
    workflowTaskDispatcher.recordEventAndDispatch(issue.projectId, issue.linearIssueId, {
      eventType: "delegated",
      dedupeKey: `github_pr_closed:implementation:${issue.linearIssueId}`,
    });
  }
  if (event.triggerEvent === "pr_merged") {
    dispatchOrchestrationParentsForChildEvent({
      db,
      child: updatedIssue,
      eventType: "child_delivered",
      workflowTaskDispatcher,
    });
    // Only complete Linear now when there's no deploy to watch. While
    // `deploying`, the issue stays in the Deploying state and the idle
    // reconciler completes it once the deploy workflow succeeds.
    if (postMergeState === "done") {
      await completeLinearIssueAfterMerge(params, updatedIssue);
    }
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
      params.db.issueSessions.commitIssueState({
        writer: WRITER,
        update: {
          projectId: issue.projectId,
          linearIssueId: issue.linearIssueId,
          ...(liveIssue.stateName ? { currentLinearState: liveIssue.stateName } : {}),
          ...(liveIssue.stateType ? { currentLinearStateType: liveIssue.stateType } : {}),
        },
      });
      return;
    }

    const updated = await linear.setIssueState(issue.linearIssueId, targetState);
    params.db.issueSessions.commitIssueState({
      writer: WRITER,
      update: {
        projectId: issue.projectId,
        linearIssueId: issue.linearIssueId,
        ...(updated.stateName ? { currentLinearState: updated.stateName } : {}),
        ...(updated.stateType ? { currentLinearStateType: updated.stateType } : {}),
      },
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    params.logger.warn({ issueKey: issue.issueKey, error: msg }, "Failed to move merged issue to a completed Linear state");
  }
}
