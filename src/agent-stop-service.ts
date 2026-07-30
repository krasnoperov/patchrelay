import type { Logger } from "pino";
import type { CodexAppServerClient } from "./codex-app-server.ts";
import type { PatchRelayDatabase } from "./db.ts";
import type { IssueRecord } from "./db-types.ts";
import { dirtyWorktreeEventPayload, inspectGitWorktreeStatus } from "./git-worktree-status.ts";
import type { StopRequestedEventPayload } from "./issue-session-events.ts";
import type { OperatorEventFeed } from "./operator-feed.ts";
import { reconcileWorkflowTasksForIssue } from "./workflow-task-reconciler.ts";
import { listUnconsumedInboxObservationIds } from "./workflow-observation-context.ts";
import { SIGNAL_CONSUMED_OBSERVATION } from "./workflow-model.ts";

const WRITER = "agent-stop-service";

export type AgentStopSource =
  | "linear_agent_session"
  | "linear_addressed_comment"
  | "patchrelay_operator_prompt"
  | "linear_stop_signal"
  | "operator_stop";

export interface AgentStopResult {
  status: "stopped" | "failed";
  activeRunType?: NonNullable<ReturnType<PatchRelayDatabase["runs"]["getRunById"]>>["runType"] | undefined;
  reason?: string | undefined;
  dirtySummary?: string | undefined;
}

/**
 * Owns the complete stop transaction: interrupt the executor, release its run,
 * cancel queued inbox work, and preserve a durable paused-work record.
 */
export class AgentStopService {
  constructor(
    private readonly db: PatchRelayDatabase,
    private readonly codex: CodexAppServerClient,
    private readonly logger: Logger,
    private readonly feed?: OperatorEventFeed,
  ) {}

  async stopIssue(params: {
    issue: IssueRecord;
    body: string;
    source: AgentStopSource;
    author?: string | undefined;
  }): Promise<AgentStopResult> {
    const issue = this.db.issues.getIssue(params.issue.projectId, params.issue.linearIssueId) ?? params.issue;
    const run = issue.activeRunId ? this.db.runs.getRunById(issue.activeRunId) : undefined;
    const worktreeStatus = issue.worktreePath ? inspectGitWorktreeStatus(issue.worktreePath) : undefined;
    const dirtyPayload = worktreeStatus ? dirtyWorktreeEventPayload(worktreeStatus) : undefined;
    const dirtySummary = typeof dirtyPayload?.summary === "string" ? dirtyPayload.summary : undefined;

    if (run?.threadId && run.turnId) {
      try {
        await this.codex.interruptTurn({
          threadId: run.threadId,
          turnId: run.turnId,
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        this.logger.warn({ issueKey: issue.issueKey, runId: run.id, error: reason }, "Failed to interrupt Codex turn for stop request");
        this.feed?.publish({
          level: "error",
          kind: "workflow",
          projectId: issue.projectId,
          issueKey: issue.issueKey,
          stage: run.runType,
          status: "stop_failed",
          summary: "Could not confirm that the active Codex turn stopped",
          detail: reason,
        });
        return { status: "failed", activeRunType: run.runType, reason };
      }
    }

    const stopCommit = this.db.transaction(() => {
      const commit = this.db.issueSessions.commitIssueState({
        writer: WRITER,
        expectedVersion: issue.version,
        update: {
          projectId: issue.projectId,
          linearIssueId: issue.linearIssueId,
          activeRunId: null,
          inputRequestKind: "paused_local_work",
        },
        onConflict: (current) => (
          current.activeRunId === run?.id || current.activeRunId === undefined
            ? {
                projectId: issue.projectId,
                linearIssueId: issue.linearIssueId,
                activeRunId: null,
                inputRequestKind: "paused_local_work",
              }
            : undefined
        ),
      });
      if (commit.outcome !== "applied") {
        return { applied: false, canceledObservationIds: [] };
      }
      if (run) {
        this.db.runs.finishRun(run.id, {
          status: "released",
          ...(run.threadId ? { threadId: run.threadId } : {}),
          ...(run.turnId ? { turnId: run.turnId } : {}),
          failureReason: dirtySummary ? `Stop requested; ${dirtySummary}` : "Stop requested",
        });
      }
      const observations = this.db.workflowObservations.listObservations(issue.projectId, issue.linearIssueId);
      const canceledObservationIds = listUnconsumedInboxObservationIds(observations);
      if (canceledObservationIds.length > 0) {
        this.db.workflowObservations.appendObservation({
          projectId: issue.projectId,
          subjectId: issue.linearIssueId,
          source: "operator",
          type: SIGNAL_CONSUMED_OBSERVATION,
          payloadJson: JSON.stringify({
            ...(run ? { runId: run.id } : {}),
            consumedObservationIds: canceledObservationIds,
            method: "stop",
          }),
          dedupeKey: `signal_consumed:stop:${canceledObservationIds.join(",")}`,
        });
      }
      return { applied: true, canceledObservationIds };
    });
    if (!stopCommit.applied) {
      const reason = "The active run changed while PatchRelay was confirming the stop";
      this.feed?.publish({
        level: "error",
        kind: "workflow",
        projectId: issue.projectId,
        issueKey: issue.issueKey,
        ...(run ? { stage: run.runType } : {}),
        status: "stop_failed",
        summary: "Could not safely apply the stop to the current run",
        detail: reason,
      });
      return {
        status: "failed",
        ...(run?.runType ? { activeRunType: run.runType } : {}),
        reason,
      };
    }
    const { canceledObservationIds } = stopCommit;

    this.db.issueSessions.appendIssueSessionEvent({
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      eventType: "stop_requested",
      eventJson: JSON.stringify({
        body: params.body,
        source: params.source,
        ...(params.author ? { author: params.author } : {}),
        ...dirtyPayload,
      } satisfies StopRequestedEventPayload),
      dedupeKey: `stop_requested:${issue.linearIssueId}:${run?.id ?? `idle:${canceledObservationIds.join(",") || "none"}`}`,
    });
    this.db.issueSessions.clearPendingIssueSessionEventsRespectingActiveLease(issue.projectId, issue.linearIssueId);
    this.db.issueSessions.releaseIssueSessionLeaseRespectingActiveLease(issue.projectId, issue.linearIssueId);
    const updatedIssue = this.db.issues.getIssue(issue.projectId, issue.linearIssueId);
    if (updatedIssue) {
      reconcileWorkflowTasksForIssue(this.db, updatedIssue);
    }
    this.feed?.publish({
      level: "warn",
      kind: "workflow",
      projectId: issue.projectId,
      issueKey: issue.issueKey,
      ...(run ? { stage: run.runType } : {}),
      status: "stopped",
      summary: dirtySummary
        ? `Stopped work with a dirty worktree: ${dirtySummary}`
        : "Stopped work",
    });
    return {
      status: "stopped",
      ...(run?.runType ? { activeRunType: run.runType } : {}),
      ...(dirtySummary ? { dirtySummary } : {}),
    };
  }
}
