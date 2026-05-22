import type { Logger } from "pino";
import type { PatchRelayDatabase } from "./db.ts";
import type { RunRecord } from "./db-types.ts";
import type { RunType } from "./factory-state.ts";
import type { ReleaseIssueSessionLease } from "./issue-session-lease-service.ts";
import type { IssueSessionEventType } from "./issue-session-events.ts";
import type { OperatorEventFeed } from "./operator-feed.ts";

export interface DispatchableSessionEvent {
  eventType: IssueSessionEventType;
  eventJson?: string | undefined;
  dedupeKey?: string | undefined;
}

export interface WakeDispatchResult {
  runType: RunType;
  wakeReason?: string | undefined;
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
  ) {}

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
    this.db.issueSessions.appendIssueSessionEventRespectingActiveLease(projectId, linearIssueId, {
      projectId,
      linearIssueId,
      ...event,
    });
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
    if (issue?.activeRunId !== undefined) return undefined;
    const wake = this.db.workflowWakes.peekIssueWake(projectId, linearIssueId);
    // Fall back to the legacy pending_run_type column. The orchestrator
    // materializes it into a real event at run time, but the poke still
    // needs to happen now so the orchestrator gets called at all.
    const runType = wake?.runType ?? issue?.pendingRunType;
    if (!runType) return undefined;
    const tick = options?.enqueuedThisTick ?? this.currentTick;
    const key = `${projectId}:${linearIssueId}`;
    if (tick?.has(key)) {
      return runType;
    }
    tick?.add(key);
    this.enqueueIssue(projectId, linearIssueId);
    return runType;
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
    const wake = this.db.workflowWakes.peekIssueWake(
      params.run.projectId,
      params.run.linearIssueId,
    );
    if (!wake) return undefined;
    this.enqueueIssue(params.run.projectId, params.run.linearIssueId);
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
}
