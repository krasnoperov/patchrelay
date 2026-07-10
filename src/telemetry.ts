import type { Logger } from "pino";
import type { RunType } from "./factory-state.ts";
import type { IssueSessionEventType } from "./issue-session-events.ts";
import type { OperatorEventFeed } from "./operator-feed.ts";

export interface PatchRelayTelemetryIds {
  projectId?: string | undefined;
  linearIssueId?: string | undefined;
  issueKey?: string | undefined;
  runId?: number | undefined;
  eventIds?: number[] | undefined;
  runType?: RunType | undefined;
  workflowReason?: string | undefined;
  correlationId?: string | undefined;
  causationId?: string | undefined;
}

export type DispatchSuppressionReason =
  | "issue_missing"
  | "active_run_present"
  | "blocked"
  | "no_workflow_task_derivable"
  | "lease_held"
  | "inactive_requested_changes"
  | "terminal_event"
  | "undelegated";

export type RunSkipReason =
  | "project_not_configured"
  | "lease_held_locally"
  | "issue_missing"
  | "active_run_present"
  | "active_run_present_post_classify"
  | "classification_dropped_issue"
  | "lease_acquire_failed"
  | "no_workflow_task_derivable"
  | "blocked"
  | "dependency_refresh_failed"
  | "zombie_backoff"
  | "capacity_backoff"
  | "inactive_requested_changes_task"
  | "lease_lost_dismissing_inactive_requested_changes_task"
  | "budget_exceeded"
  | "lease_lost_incrementing_attempts"
  | "claim_failed";

export type ProjectionInvalidationReason =
  | "issue_changed"
  | "issue_run_changed"
  | "issue_dependencies_changed"
  | "dependency_blocker_changed"
  | "issue_session_events_changed";

export type PatchRelayTelemetryEvent =
  | (PatchRelayTelemetryIds & {
    type: "dispatch.created";
    sessionEventType: IssueSessionEventType;
    dedupeKey?: string | undefined;
  })
  | (PatchRelayTelemetryIds & {
    type: "dispatch.derived";
    source: "workflow_task";
  })
  | (PatchRelayTelemetryIds & {
    type: "dispatch.suppressed";
    reason: DispatchSuppressionReason;
    activeRunId?: number | undefined;
    blockerCount?: number | undefined;
    blockerKeys?: string[] | undefined;
  })
  | (PatchRelayTelemetryIds & { type: "dispatch.dispatched" })
  | (PatchRelayTelemetryIds & { type: "dispatch.deduped" })
  | (PatchRelayTelemetryIds & { type: "dispatch.consumed" })
  | (PatchRelayTelemetryIds & {
    type: "dispatch.dismissed";
    reason: string;
  })
  | (PatchRelayTelemetryIds & {
    type: "dependency.dependent_blocked";
    blockerLinearIssueId: string;
    blockerCount: number;
    blockerKeys?: string[] | undefined;
  })
  | (PatchRelayTelemetryIds & {
    type: "dependency.dependent_unblocked";
    blockerLinearIssueId: string;
    dispatchedRunType?: RunType | undefined;
  })
  | (PatchRelayTelemetryIds & {
    type: "dependency.remaining_blockers";
    blockerLinearIssueId: string;
    blockerCount: number;
    blockerKeys?: string[] | undefined;
  })
  | (PatchRelayTelemetryIds & {
    type: "projection.invalidated";
    reason: ProjectionInvalidationReason;
    affectedCount?: number | undefined;
  })
  | (PatchRelayTelemetryIds & {
    type: "projection.reprojected";
    reason: ProjectionInvalidationReason;
  })
  | (PatchRelayTelemetryIds & {
    type: "lease.acquired" | "lease.acquire_failed" | "lease.released" | "lease.reclaimed" | "lease.expired";
    leaseId?: string | undefined;
    workerId?: string | undefined;
  })
  | (PatchRelayTelemetryIds & { type: "queue.enqueued" | "queue.deduped" | "queue.dequeued" })
  | (PatchRelayTelemetryIds & {
    type: "run.dequeued";
  })
  | (PatchRelayTelemetryIds & {
    type: "run.skipped";
    reason: RunSkipReason;
    activeRunId?: number | undefined;
    blockerCount?: number | undefined;
    remainingDelayMs?: number | undefined;
  })
  | (PatchRelayTelemetryIds & { type: "run.claimed" | "run.started" | "run.completed" | "run.failed" | "run.released" | "run.superseded" })
  | (PatchRelayTelemetryIds & {
    type: "run.capacity_deferred";
    detail: string;
    retryAtIso?: string | undefined;
  })
  | (PatchRelayTelemetryIds & {
    type: "state.write_conflict";
    writer: string;
    expectedVersion: number | null;
    actualVersion: number | null;
    resolution: "recomputed" | "skipped" | "applied_anyway";
  })
  | (PatchRelayTelemetryIds & {
    // S4 cutover instrument: emitted when the new PR-fact-based session_state /
    // waiting_reason derivation disagrees with the legacy factory-state-keyed
    // one. Must stay silent for known shapes; gates S8/S9. Fire-and-forget.
    type: "state.projection_divergence";
    field: "session_state" | "waiting_reason";
    oldValue: string | null;
    newValue: string | null;
  })
  | (PatchRelayTelemetryIds & {
    type: "health.invariant";
    invariant:
      | "blocked_issue_with_pending_workflow_task"
      | "ready_issue_not_enqueued"
      | "stale_blocked_read_model"
      | "active_run_with_unresolved_blocker"
      | "stale_lease_blocking_runnable_work"
      | "detached_active_run";
    status: "observed" | "repaired";
    detail?: string | undefined;
    blockerCount?: number | undefined;
    blockerKeys?: string[] | undefined;
  });

export interface PatchRelayTelemetry {
  emit(event: PatchRelayTelemetryEvent): void;
}

export const noopTelemetry: PatchRelayTelemetry = {
  emit: () => undefined,
};

export function emitTelemetry(telemetry: PatchRelayTelemetry, event: PatchRelayTelemetryEvent): void {
  try {
    telemetry.emit(event);
  } catch {
    // Telemetry must never affect workflow execution.
  }
}

export class FanoutPatchRelayTelemetry implements PatchRelayTelemetry {
  constructor(private readonly sinks: PatchRelayTelemetry[]) {}

  emit(event: PatchRelayTelemetryEvent): void {
    for (const sink of this.sinks) {
      emitTelemetry(sink, event);
    }
  }
}

export class MemoryPatchRelayTelemetry implements PatchRelayTelemetry {
  readonly events: PatchRelayTelemetryEvent[] = [];

  emit(event: PatchRelayTelemetryEvent): void {
    this.events.push(event);
  }

  list(): PatchRelayTelemetryEvent[];
  list<T extends PatchRelayTelemetryEvent["type"]>(type: T): Array<Extract<PatchRelayTelemetryEvent, { type: T }>>;
  list<T extends PatchRelayTelemetryEvent["type"]>(type?: T): PatchRelayTelemetryEvent[] | Array<Extract<PatchRelayTelemetryEvent, { type: T }>> {
    if (!type) return this.events;
    return this.events.filter((event) => event.type === type) as Array<Extract<PatchRelayTelemetryEvent, { type: T }>>;
  }
}

export class LoggerTelemetrySink implements PatchRelayTelemetry {
  constructor(private readonly logger: Logger) {}

  emit(event: PatchRelayTelemetryEvent): void {
    this.logger.info({ telemetryEvent: event.type, ...event }, "PatchRelay telemetry event");
  }
}

export class OperatorFeedTelemetrySink implements PatchRelayTelemetry {
  constructor(private readonly feed: OperatorEventFeed) {}

  emit(event: PatchRelayTelemetryEvent): void {
    const feedEvent = this.toFeedEvent(event);
    if (feedEvent) {
      this.feed.publish(feedEvent);
    }
  }

  private toFeedEvent(event: PatchRelayTelemetryEvent): Parameters<OperatorEventFeed["publish"]>[0] | undefined {
    switch (event.type) {
      case "dependency.dependent_unblocked":
        return {
          level: "info",
          kind: "workflow",
          ...(event.issueKey ? { issueKey: event.issueKey } : {}),
          ...(event.projectId ? { projectId: event.projectId } : {}),
          ...(event.dispatchedRunType ? { stage: event.dispatchedRunType } : {}),
          status: "dependency_unblocked",
          summary: event.dispatchedRunType
            ? `Dependency unblocked; ${event.dispatchedRunType} queued`
            : "Dependency unblocked",
        };
      case "run.skipped":
        if (event.reason === "blocked" || event.reason === "lease_acquire_failed" || event.reason === "no_workflow_task_derivable") {
          return {
            level: event.reason === "blocked" ? "info" : "warn",
            kind: "stage",
            ...(event.issueKey ? { issueKey: event.issueKey } : {}),
            ...(event.projectId ? { projectId: event.projectId } : {}),
            ...(event.runType ? { stage: event.runType } : {}),
            status: "skipped",
            summary: `Run skipped: ${event.reason}`,
          };
        }
        return undefined;
      case "run.capacity_deferred":
        return {
          level: "warn",
          kind: "workflow",
          ...(event.issueKey ? { issueKey: event.issueKey } : {}),
          ...(event.projectId ? { projectId: event.projectId } : {}),
          ...(event.runType ? { stage: event.runType } : {}),
          status: "capacity_deferred",
          summary: event.retryAtIso
            ? `Codex capacity limit; retrying ${event.runType ?? "run"} at ${event.retryAtIso}`
            : `Codex capacity limit; retrying ${event.runType ?? "run"} after backoff`,
          detail: event.detail,
        };
      case "state.write_conflict":
        return {
          level: "warn",
          kind: "workflow",
          ...(event.issueKey ? { issueKey: event.issueKey } : {}),
          ...(event.projectId ? { projectId: event.projectId } : {}),
          status: "state_write_conflict",
          summary: `Issue-state write conflict (${event.writer}): expected v${event.expectedVersion ?? "none"}, found v${event.actualVersion ?? "none"} — ${event.resolution.replaceAll("_", " ")}`,
        };
      case "health.invariant":
        return {
          level: event.status === "observed" ? "warn" : "info",
          kind: "workflow",
          ...(event.issueKey ? { issueKey: event.issueKey } : {}),
          ...(event.projectId ? { projectId: event.projectId } : {}),
          ...(event.runType ? { stage: event.runType } : {}),
          status: `health_${event.status}`,
          summary: event.status === "observed"
            ? `Health warning: ${formatInvariant(event.invariant)}`
            : `Health repaired: ${formatInvariant(event.invariant)}`,
          ...(event.detail ? { detail: event.detail } : {}),
        };
      default:
        return undefined;
    }
  }
}

function formatInvariant(invariant: string): string {
  return invariant.replaceAll("_", " ");
}
