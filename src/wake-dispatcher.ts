import type { Logger } from "pino";
import type { PatchRelayDatabase } from "./db.ts";
import type { RunRecord, WorkflowTaskRecord } from "./db-types.ts";
import type { RunType } from "./factory-state.ts";
import type { ReleaseIssueSessionLease } from "./issue-session-lease-service.ts";
import type { IssueSessionEventType } from "./issue-session-events.ts";
import type { OperatorEventFeed } from "./operator-feed.ts";
import { emitTelemetry, noopTelemetry, type PatchRelayTelemetry } from "./telemetry.ts";

export interface DispatchableSessionEvent {
  eventType: IssueSessionEventType;
  eventJson?: string | undefined;
  dedupeKey?: string | undefined;
}

export interface WakeDispatchResult {
  runType: RunType;
  wakeReason?: string | undefined;
}

interface DispatchableWake {
  runType: RunType;
  wakeReason?: string | undefined;
  eventIds: number[];
  source: "session_event" | "implicit" | "legacy_pending_run_type" | "workflow_task";
}

// Single owner of "append a session event and tell the orchestrator
// something might be runnable", and of "release a finished run so the
// next wake fires." Until this existed, 8+ call sites each made their
// own decision about whether to call `enqueueIssue`. A missed enqueue
// (lease race, in-memory queue cleared by restart) left events orphaned
// for hours — we lost 6.5h on LSR-495 to exactly this.
//
// Idempotency comes from two layers:
//   - `issue_session_events.dedupe_key` dedupes the event itself.
//   - `SerialWorkQueue` dedupes by issue key inside the worker process.
//
// Long-running scopes (the idle reconciler) can call `withTick` to
// dedupe enqueues within that scope — every call into the dispatcher
// during the callback contributes to the same Set, so a single
// reconcile pass produces at most one enqueue per issue even when
// many sub-passes detect the same wake. The `enqueuedThisTick` option
// on individual methods is for callers that thread their own Set.
export class WakeDispatcher {
  private currentTick: Set<string> | undefined;

  constructor(
    private readonly db: PatchRelayDatabase,
    private readonly enqueueIssue: (projectId: string, issueId: string) => void,
    private readonly releaseLease: ReleaseIssueSessionLease,
    private readonly logger: Logger,
    private readonly feed?: OperatorEventFeed,
    private readonly telemetry: PatchRelayTelemetry = noopTelemetry,
  ) {}

  private peekRunnableWorkflowTask(projectId: string, linearIssueId: string): WorkflowTaskRecord | undefined {
    return this.db.workflowTasks
      .listOpenRunnableTasks(projectId)
      .find((task) => task.subjectId === linearIssueId && task.runType !== undefined);
  }

  private resolveDispatchableWake(
    projectId: string,
    linearIssueId: string,
    issue: { pendingRunType?: RunType | undefined },
  ): DispatchableWake | undefined {
    const sessionWake = this.db.issueSessions.peekIssueSessionWake(projectId, linearIssueId);
    if (sessionWake) {
      return {
        runType: sessionWake.runType,
        ...(sessionWake.wakeReason ? { wakeReason: sessionWake.wakeReason } : {}),
        eventIds: sessionWake.eventIds,
        source: "session_event",
      };
    }
    const workflowTask = this.peekRunnableWorkflowTask(projectId, linearIssueId);
    if (workflowTask?.runType) {
      return {
        runType: workflowTask.runType,
        wakeReason: workflowTask.taskId,
        eventIds: [],
        source: "workflow_task",
      };
    }
    if (issue.pendingRunType) {
      return {
        runType: issue.pendingRunType,
        eventIds: [],
        source: "legacy_pending_run_type",
      };
    }
    const implicitWake = this.db.workflowWakes.peekIssueWake(projectId, linearIssueId);
    if (!implicitWake) return undefined;
    return {
      runType: implicitWake.runType,
      ...(implicitWake.wakeReason ? { wakeReason: implicitWake.wakeReason } : {}),
      eventIds: implicitWake.eventIds,
      source: "implicit",
    };
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

  // Append a session event and dispatch the issue if a wake is derivable
  // and no run is currently in flight. Returns the runType the next run
  // would have, or undefined if the event is non-actionable / no wake
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
        type: "wake.created",
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
    return this.dispatchIfWakePending(
      projectId,
      linearIssueId,
      options ?? (this.currentTick ? { enqueuedThisTick: this.currentTick } : undefined),
    );
  }

  // "Make sure the orchestrator looks at this issue, if anything is worth
  // looking at." Used by the idle reconciler safety net for orphan
  // recovery, by dependency-readiness flows that don't append a new
  // event but want to poke, and by the stack-coordination fan-out that
  // sets the legacy `pending_run_type` column on the issue. Suppressed
  // when an active run is in flight — the run finalizer owns the
  // post-run drain via releaseRunAndDispatch.
  dispatchIfWakePending(
    projectId: string,
    linearIssueId: string,
    options?: { enqueuedThisTick?: Set<string> },
  ): RunType | undefined {
    const issue = this.db.issues.getIssue(projectId, linearIssueId);
    if (!issue) {
      emitTelemetry(this.telemetry, {
        type: "wake.suppressed",
        projectId,
        linearIssueId,
        reason: "issue_missing",
      });
      return undefined;
    }
    if (issue.activeRunId !== undefined) {
      const blockerCount = this.db.issues.countUnresolvedBlockers(projectId, linearIssueId);
      emitTelemetry(this.telemetry, {
        type: "wake.suppressed",
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
          detail: "Wake suppressed because an active run exists while blockers are unresolved",
        });
      }
      return undefined;
    }
    const unresolvedBlockers = this.db.issues.countUnresolvedBlockers(projectId, linearIssueId);
    if (unresolvedBlockers > 0) {
      const blockerKeys = this.unresolvedBlockerKeys(projectId, linearIssueId);
      emitTelemetry(this.telemetry, {
        type: "wake.suppressed",
        projectId,
        linearIssueId,
        ...(issue.issueKey ? { issueKey: issue.issueKey } : {}),
        reason: "blocked",
        blockerCount: unresolvedBlockers,
        blockerKeys,
      });
      const pendingBlockedWake = this.db.issueSessions.peekIssueSessionWake(projectId, linearIssueId) ?? issue.pendingRunType;
      if (pendingBlockedWake) {
        emitTelemetry(this.telemetry, {
          type: "health.invariant",
          invariant: "blocked_issue_with_pending_wake",
          status: "observed",
          projectId,
          linearIssueId,
          ...(issue.issueKey ? { issueKey: issue.issueKey } : {}),
          blockerCount: unresolvedBlockers,
          detail: "Wake remains pending while blockers are unresolved",
        });
      }
      return undefined;
    }
    const dispatchable = this.resolveDispatchableWake(projectId, linearIssueId, issue);
    if (!dispatchable) {
      emitTelemetry(this.telemetry, {
        type: "wake.suppressed",
        projectId,
        linearIssueId,
        ...(issue.issueKey ? { issueKey: issue.issueKey } : {}),
        reason: "no_wake_derivable",
      });
      if (this.db.listIssuesReadyForExecution().some((entry) => entry.projectId === projectId && entry.linearIssueId === linearIssueId)) {
        emitTelemetry(this.telemetry, {
          type: "health.invariant",
          invariant: "ready_issue_not_enqueued",
          status: "observed",
          projectId,
          linearIssueId,
          ...(issue.issueKey ? { issueKey: issue.issueKey } : {}),
          detail: "Issue appears ready for execution but no wake was derivable for enqueue",
        });
      }
      return undefined;
    }
    emitTelemetry(this.telemetry, {
      type: "wake.derived",
      projectId,
      linearIssueId,
      ...(issue.issueKey ? { issueKey: issue.issueKey } : {}),
      runType: dispatchable.runType,
      ...(dispatchable.wakeReason ? { wakeReason: dispatchable.wakeReason } : {}),
      eventIds: dispatchable.eventIds,
      source: dispatchable.source,
    });
    const tick = options?.enqueuedThisTick ?? this.currentTick;
    const key = `${projectId}:${linearIssueId}`;
    if (tick?.has(key)) {
      emitTelemetry(this.telemetry, {
        type: "wake.deduped",
        projectId,
        linearIssueId,
        ...(issue.issueKey ? { issueKey: issue.issueKey } : {}),
        runType: dispatchable.runType,
        ...(dispatchable.wakeReason ? { wakeReason: dispatchable.wakeReason } : {}),
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
      type: "wake.dispatched",
      projectId,
      linearIssueId,
      ...(issue.issueKey ? { issueKey: issue.issueKey } : {}),
      runType: dispatchable.runType,
      ...(dispatchable.wakeReason ? { wakeReason: dispatchable.wakeReason } : {}),
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

  // Release the lease for a finished run, then drain any wake that
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
  }): WakeDispatchResult | undefined {
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
    const wake = issue ? this.resolveDispatchableWake(
      params.run.projectId,
      params.run.linearIssueId,
      issue,
    ) : undefined;
    if (!wake) {
      emitTelemetry(this.telemetry, {
        type: "wake.suppressed",
        projectId: params.run.projectId,
        linearIssueId: params.run.linearIssueId,
        ...(params.issueKey ? { issueKey: params.issueKey } : {}),
        reason: "no_wake_derivable",
      });
      return undefined;
    }
    this.enqueueIssue(params.run.projectId, params.run.linearIssueId);
    emitTelemetry(this.telemetry, {
      type: "wake.dispatched",
      projectId: params.run.projectId,
      linearIssueId: params.run.linearIssueId,
      ...(params.issueKey ? { issueKey: params.issueKey } : {}),
      runType: wake.runType,
      ...(wake.wakeReason ? { wakeReason: wake.wakeReason } : {}),
      eventIds: wake.eventIds,
    });
    emitTelemetry(this.telemetry, {
      type: "queue.enqueued",
      projectId: params.run.projectId,
      linearIssueId: params.run.linearIssueId,
      ...(params.issueKey ? { issueKey: params.issueKey } : {}),
      runType: wake.runType,
    });
    if (params.publishDeferredFollowUp) {
      this.feed?.publish({
        level: "info",
        kind: "stage",
        ...(params.issueKey ? { issueKey: params.issueKey } : {}),
        projectId: params.run.projectId,
        stage: wake.runType,
        status: "deferred_follow_up_queued",
        summary: `${wake.runType} queued after ${params.run.runType} released authority`,
        ...(wake.wakeReason ? { detail: `wake reason: ${wake.wakeReason}` } : {}),
      });
    }
    return {
      runType: wake.runType,
      ...(wake.wakeReason ? { wakeReason: wake.wakeReason } : {}),
    };
  }

  private unresolvedBlockerKeys(projectId: string, linearIssueId: string): string[] {
    return this.db.issues.listIssueDependencies(projectId, linearIssueId)
      .filter((entry) => entry.blockerCurrentLinearStateType !== "completed"
        && entry.blockerCurrentLinearState?.trim().toLowerCase() !== "done")
      .map((entry) => entry.blockerIssueKey ?? entry.blockerLinearIssueId);
  }
}
