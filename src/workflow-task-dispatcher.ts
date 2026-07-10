import type { Logger } from "pino";
import type { PatchRelayDatabase } from "./db.ts";
import type { IssueRecord, RunRecord, WorkflowTaskRecord } from "./db-types.ts";
import type { RunType } from "./run-type.ts";
import type { ReleaseIssueSessionLease } from "./issue-session-lease-service.ts";
import type { IssueSessionEventType } from "./issue-session-events.ts";
import type { OperatorEventFeed } from "./operator-feed.ts";
import { isIssueTerminalProjection } from "./issue-execution-state.ts";
import { emitTelemetry, noopTelemetry, type PatchRelayTelemetry } from "./telemetry.ts";
import { reconcileWorkflowTasksForIssue } from "./workflow-task-reconciler.ts";

export interface DispatchableSessionEvent {
  eventType: IssueSessionEventType;
  eventJson?: string | undefined;
  dedupeKey?: string | undefined;
}

export interface WorkflowTaskDispatchResult {
  runType: RunType;
  workflowReason?: string | undefined;
}

interface DispatchableWorkflowTaskDispatch {
  runType: RunType;
  workflowReason?: string | undefined;
  eventIds: number[];
  source: "workflow_task";
}

// Single owner of "append a session event and tell the orchestrator
// something might be runnable", and of "release a finished run so the next
// workflow task fires." Until this existed, 8+ call sites each made their own
// decision about whether to call `enqueueIssue`.
//
// Idempotency comes from two layers:
//   - `issue_session_events.dedupe_key` dedupes the event itself.
//   - `SerialWorkQueue` dedupes by issue key inside the worker process.
//
// Long-running scopes (the idle reconciler) can call `withTick` to
// dedupe enqueues within that scope — every call into the dispatcher
// during the callback contributes to the same Set, so a single
// reconcile pass produces at most one enqueue per issue even when
// many sub-passes detect the same runnable task. The `enqueuedThisTick` option
// on individual methods is for callers that thread their own Set.
export class WorkflowTaskDispatcher {
  private currentTick: Set<string> | undefined;

  constructor(
    private readonly db: PatchRelayDatabase,
    private readonly enqueueIssue: (projectId: string, issueId: string) => void,
    private readonly releaseLease: ReleaseIssueSessionLease,
    private readonly logger: Logger,
    private readonly feed?: OperatorEventFeed,
    private readonly telemetry: PatchRelayTelemetry = noopTelemetry,
  ) {}

  private listOpenWorkflowTasks(projectId: string, linearIssueId: string): WorkflowTaskRecord[] {
    return this.db.workflowTasks.listOpenTasks(projectId, linearIssueId);
  }

  private reconcileOpenWorkflowTasks(
    issue: IssueRecord,
    options?: { ignoreDetachedActiveRuns?: boolean | undefined },
  ): WorkflowTaskRecord[] {
    try {
      return reconcileWorkflowTasksForIssue(this.db, issue, options).result.open;
    } catch (error) {
      this.logger.warn(
        {
          projectId: issue.projectId,
          linearIssueId: issue.linearIssueId,
          ...(issue.issueKey ? { issueKey: issue.issueKey } : {}),
          error: error instanceof Error ? error.message : String(error),
        },
        "Workflow task reconciliation failed while resolving dispatchable task",
      );
      return this.listOpenWorkflowTasks(issue.projectId, issue.linearIssueId);
    }
  }

  private peekRunnableWorkflowTask(projectId: string, linearIssueId: string, openTasks?: WorkflowTaskRecord[]): WorkflowTaskRecord | undefined {
    return (openTasks ?? this.db.workflowTasks.listOpenRunnableTasks(projectId))
      .find((task) => (
        task.subjectId === linearIssueId
        && task.taskType === "run"
        && task.gateAction === "start"
        && task.runType !== undefined
      ));
  }

  private resolveDispatchableWorkflowTaskDispatch(
    projectId: string,
    linearIssueId: string,
    issue: IssueRecord,
    options?: { ignoreDetachedActiveRuns?: boolean | undefined },
  ): DispatchableWorkflowTaskDispatch | undefined {
    const existingWorkflowTasks = this.listOpenWorkflowTasks(projectId, linearIssueId);
    const existingWorkflowTask = this.peekRunnableWorkflowTask(projectId, linearIssueId, existingWorkflowTasks);
    if (existingWorkflowTask?.runType) {
      return {
        runType: existingWorkflowTask.runType,
        workflowReason: existingWorkflowTask.taskId,
        eventIds: [],
        source: "workflow_task",
      };
    }

    const freshIssue = this.db.issues.getIssue(projectId, linearIssueId) ?? issue;
    const openWorkflowTasks = this.reconcileOpenWorkflowTasks(freshIssue, options);
    const workflowTask = this.peekRunnableWorkflowTask(projectId, linearIssueId, openWorkflowTasks);
    if (workflowTask?.runType) {
      return {
        runType: workflowTask.runType,
        workflowReason: workflowTask.taskId,
        eventIds: [],
        source: "workflow_task",
      };
    }
    return undefined;
  }

  // Scope the next enqueue calls inside `fn` to a single dedupe Set.
  // Nested ticks reuse the outermost Set so deeply nested helpers do
  // not silently lose dedupe.
  async withTick<T>(fn: () => Promise<T>): Promise<T> {
    if (this.currentTick) return fn();
    this.currentTick = new Set<string>();
    try {
      return await fn();
    } finally {
      this.currentTick = undefined;
    }
  }

  // Append a session event and dispatch the issue if a workflow task is derivable
  // and no run is currently in flight. Returns the runType the next run
  // would have, or undefined if the event is non-actionable / no workflow task
  // exists / a run is already running (the finalizer will drain it).
  recordEventAndDispatch(
    projectId: string,
    linearIssueId: string,
    event: DispatchableSessionEvent,
    options?: { enqueuedThisTick?: Set<string> },
  ): RunType | undefined {
    const appended = this.db.issueSessions.appendIssueSessionEventRespectingActiveLease(projectId, linearIssueId, {
      projectId,
      linearIssueId,
      ...event,
    });
    const issue = this.db.issues.getIssue(projectId, linearIssueId);
    if (appended) {
      emitTelemetry(this.telemetry, {
        type: "dispatch.created",
        projectId,
        linearIssueId,
        ...(issue?.issueKey ? { issueKey: issue.issueKey } : {}),
        eventIds: [appended.id],
        sessionEventType: event.eventType,
        ...(event.dedupeKey ? { dedupeKey: event.dedupeKey } : {}),
      });
    }
    // Honour the active tick scope (set via withTick) so callers nested
    // inside a reconcile pass automatically dedupe without threading
    // the Set through every helper signature.
    return this.dispatchIfWorkflowTaskPending(
      projectId,
      linearIssueId,
      options ?? (this.currentTick ? { enqueuedThisTick: this.currentTick } : undefined),
    );
  }

  // "Make sure the orchestrator looks at this issue, if anything is worth
  // looking at." Used by recovery and dependency-readiness flows that want to
  // poke the orchestrator after durable workflow-task reconciliation.
  // Suppressed when an active run is in flight — the run finalizer owns the
  // post-run drain via releaseRunAndDispatch.
  dispatchIfWorkflowTaskPending(
    projectId: string,
    linearIssueId: string,
    options?: { enqueuedThisTick?: Set<string> },
  ): RunType | undefined {
    const issue = this.db.issues.getIssue(projectId, linearIssueId);
    if (!issue) {
      emitTelemetry(this.telemetry, {
        type: "dispatch.suppressed",
        projectId,
        linearIssueId,
        reason: "issue_missing",
      });
      return undefined;
    }
    if (issue.activeRunId !== undefined) {
      const blockerCount = this.db.issues.countUnresolvedBlockers(projectId, linearIssueId);
      emitTelemetry(this.telemetry, {
        type: "dispatch.suppressed",
        projectId,
        linearIssueId,
        ...(issue.issueKey ? { issueKey: issue.issueKey } : {}),
        reason: "active_run_present",
        activeRunId: issue.activeRunId,
        ...(blockerCount > 0 ? { blockerCount } : {}),
      });
      if (blockerCount > 0) {
        emitTelemetry(this.telemetry, {
          type: "health.invariant",
          invariant: "active_run_with_unresolved_blocker",
          status: "observed",
          projectId,
          linearIssueId,
          ...(issue.issueKey ? { issueKey: issue.issueKey } : {}),
          runId: issue.activeRunId,
          blockerCount,
          detail: "Dispatch suppressed because an active run exists while blockers are unresolved",
        });
      }
      return undefined;
    }
    const unresolvedBlockers = this.db.issues.countUnresolvedBlockers(projectId, linearIssueId);
    if (unresolvedBlockers > 0) {
      const blockerKeys = this.unresolvedBlockerKeys(projectId, linearIssueId);
      emitTelemetry(this.telemetry, {
        type: "dispatch.suppressed",
        projectId,
        linearIssueId,
        ...(issue.issueKey ? { issueKey: issue.issueKey } : {}),
        reason: "blocked",
        blockerCount: unresolvedBlockers,
        blockerKeys,
      });
      const blockedRunnableTask = this.peekRunnableWorkflowTask(projectId, linearIssueId);
      if (blockedRunnableTask) {
        emitTelemetry(this.telemetry, {
          type: "health.invariant",
          invariant: "blocked_issue_with_pending_workflow_task",
          status: "observed",
          projectId,
          linearIssueId,
          ...(issue.issueKey ? { issueKey: issue.issueKey } : {}),
          blockerCount: unresolvedBlockers,
          detail: "Runnable workflow task remains pending while blockers are unresolved",
        });
      }
      return undefined;
    }
    const dispatchable = this.resolveDispatchableWorkflowTaskDispatch(projectId, linearIssueId, issue);
    if (!dispatchable) {
      emitTelemetry(this.telemetry, {
        type: "dispatch.suppressed",
        projectId,
        linearIssueId,
        ...(issue.issueKey ? { issueKey: issue.issueKey } : {}),
        reason: "no_workflow_task_derivable",
      });
      if (this.db.listIssuesReadyForExecution().some((entry) => entry.projectId === projectId && entry.linearIssueId === linearIssueId)) {
        emitTelemetry(this.telemetry, {
          type: "health.invariant",
          invariant: "ready_issue_not_enqueued",
          status: "observed",
          projectId,
          linearIssueId,
          ...(issue.issueKey ? { issueKey: issue.issueKey } : {}),
          detail: "Issue appears ready for execution but no workflow task was derivable for enqueue",
        });
      }
      return undefined;
    }
    emitTelemetry(this.telemetry, {
      type: "dispatch.derived",
      projectId,
      linearIssueId,
      ...(issue.issueKey ? { issueKey: issue.issueKey } : {}),
      runType: dispatchable.runType,
      ...(dispatchable.workflowReason ? { workflowReason: dispatchable.workflowReason } : {}),
      eventIds: dispatchable.eventIds,
      source: dispatchable.source,
    });
    const tick = options?.enqueuedThisTick ?? this.currentTick;
    const key = `${projectId}:${linearIssueId}`;
    if (tick?.has(key)) {
      emitTelemetry(this.telemetry, {
        type: "dispatch.deduped",
        projectId,
        linearIssueId,
        ...(issue.issueKey ? { issueKey: issue.issueKey } : {}),
        runType: dispatchable.runType,
        ...(dispatchable.workflowReason ? { workflowReason: dispatchable.workflowReason } : {}),
        eventIds: dispatchable.eventIds,
      });
      emitTelemetry(this.telemetry, {
        type: "queue.deduped",
        projectId,
        linearIssueId,
        ...(issue.issueKey ? { issueKey: issue.issueKey } : {}),
        runType: dispatchable.runType,
      });
      return dispatchable.runType;
    }
    tick?.add(key);
    this.enqueueIssue(projectId, linearIssueId);
    emitTelemetry(this.telemetry, {
      type: "dispatch.dispatched",
      projectId,
      linearIssueId,
      ...(issue.issueKey ? { issueKey: issue.issueKey } : {}),
      runType: dispatchable.runType,
      ...(dispatchable.workflowReason ? { workflowReason: dispatchable.workflowReason } : {}),
      eventIds: dispatchable.eventIds,
    });
    emitTelemetry(this.telemetry, {
      type: "queue.enqueued",
      projectId,
      linearIssueId,
      ...(issue.issueKey ? { issueKey: issue.issueKey } : {}),
      runType: dispatchable.runType,
    });
    return dispatchable.runType;
  }

  // Release the lease for a finished run, then dispatch any workflow task that
  // landed during the run. The single owner of "run is over, what's
  // next?". Lease is released BEFORE the dispatch so the orchestrator's
  // lease guard succeeds on dequeue. Every code path that ends a run
  // must go through here, not bare releaseLease.
  //
  // The optional `publishDeferredFollowUp` flag is for callers that
  // want the "deferred_follow_up_queued" operator-feed event emitted
  // here (success path of the run finalizer). Failure / completion-
  // check paths publish their own more-specific event and pass false.
  releaseRunAndDispatch(params: {
    run: Pick<RunRecord, "projectId" | "linearIssueId" | "runType" | "id">;
    issueKey?: string | undefined;
    publishDeferredFollowUp?: boolean;
  }): WorkflowTaskDispatchResult | undefined {
    this.releaseLease(params.run.projectId, params.run.linearIssueId);
    emitTelemetry(this.telemetry, {
      type: "run.released",
      projectId: params.run.projectId,
      linearIssueId: params.run.linearIssueId,
      ...(params.issueKey ? { issueKey: params.issueKey } : {}),
      runId: params.run.id,
      runType: params.run.runType,
    });
    const issue = this.db.issues.getIssue(params.run.projectId, params.run.linearIssueId);
    if (issue && isIssueTerminalProjection(issue)) {
      emitTelemetry(this.telemetry, {
        type: "dispatch.suppressed",
        projectId: params.run.projectId,
        linearIssueId: params.run.linearIssueId,
        ...(params.issueKey ? { issueKey: params.issueKey } : {}),
        reason: "terminal_event",
      });
      return undefined;
    }
    const dispatchable = issue ? this.resolveDispatchableWorkflowTaskDispatch(
      params.run.projectId,
      params.run.linearIssueId,
      issue,
      { ignoreDetachedActiveRuns: true },
    ) : undefined;
    if (!dispatchable) {
      emitTelemetry(this.telemetry, {
        type: "dispatch.suppressed",
        projectId: params.run.projectId,
        linearIssueId: params.run.linearIssueId,
        ...(params.issueKey ? { issueKey: params.issueKey } : {}),
        reason: "no_workflow_task_derivable",
      });
      return undefined;
    }
    this.enqueueIssue(params.run.projectId, params.run.linearIssueId);
    emitTelemetry(this.telemetry, {
      type: "dispatch.dispatched",
      projectId: params.run.projectId,
      linearIssueId: params.run.linearIssueId,
      ...(params.issueKey ? { issueKey: params.issueKey } : {}),
      runType: dispatchable.runType,
      ...(dispatchable.workflowReason ? { workflowReason: dispatchable.workflowReason } : {}),
      eventIds: dispatchable.eventIds,
    });
    emitTelemetry(this.telemetry, {
      type: "queue.enqueued",
      projectId: params.run.projectId,
      linearIssueId: params.run.linearIssueId,
      ...(params.issueKey ? { issueKey: params.issueKey } : {}),
      runType: dispatchable.runType,
    });
    if (params.publishDeferredFollowUp) {
      this.feed?.publish({
        level: "info",
        kind: "stage",
        ...(params.issueKey ? { issueKey: params.issueKey } : {}),
        projectId: params.run.projectId,
        stage: dispatchable.runType,
        status: "deferred_follow_up_queued",
        summary: `${dispatchable.runType} queued after ${params.run.runType} released authority`,
        ...(dispatchable.workflowReason ? { detail: `workflow reason: ${dispatchable.workflowReason}` } : {}),
      });
    }
    return {
      runType: dispatchable.runType,
      ...(dispatchable.workflowReason ? { workflowReason: dispatchable.workflowReason } : {}),
    };
  }

  private unresolvedBlockerKeys(projectId: string, linearIssueId: string): string[] {
    return this.db.issues.listIssueDependencies(projectId, linearIssueId)
      .filter((entry) => entry.blockerCurrentLinearStateType !== "completed"
        && entry.blockerCurrentLinearState?.trim().toLowerCase() !== "done")
      .map((entry) => entry.blockerIssueKey ?? entry.blockerLinearIssueId);
  }
}
