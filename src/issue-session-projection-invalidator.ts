import type { IssueRecord } from "./db-types.ts";
import type { RunType } from "./factory-state.ts";
import { emitTelemetry, noopTelemetry, type PatchRelayTelemetry, type ProjectionInvalidationReason } from "./telemetry.ts";

export interface IssueSessionProjectionOptions {
  summaryText?: string | undefined;
  lastRunType?: RunType | undefined;
  lastWorkflowReason?: string | undefined;
}

export interface IssueSessionProjectionInvalidator {
  issueChanged(issue: IssueRecord, options?: IssueSessionProjectionOptions): void;
  issueRunChanged(issue: IssueRecord, options?: IssueSessionProjectionOptions): void;
  issueDependenciesChanged(projectId: string, linearIssueId: string): void;
  dependencyBlockerChanged(projectId: string, blockerLinearIssueId: string): void;
  issueSessionEventsChanged(projectId: string, linearIssueId: string): void;
  /**
   * Dev/test-only guard: reading the issue_sessions projection while a
   * projection batch is open returns rows the deferred reprojection has not
   * refreshed yet. Implementations throw outside production; no-op when
   * absent or in production.
   */
  assertNotMidBatch?(context: string): void;
}

export class ImmediateIssueSessionProjectionInvalidator implements IssueSessionProjectionInvalidator {
  private batchDepth = 0;
  private readonly pendingProjections = new Map<string, PendingProjection>();
  // Captured once: the guard must stay a single integer compare on the hot
  // read path and be OFF in production.
  private readonly strictMidBatchReads = process.env.NODE_ENV !== "production";

  constructor(
    private readonly deps: {
      getIssue: (projectId: string, linearIssueId: string) => IssueRecord | undefined;
      listDependents: (projectId: string, blockerLinearIssueId: string) => Array<{ projectId: string; linearIssueId: string }>;
      projectIssue: (issue: IssueRecord, options?: IssueSessionProjectionOptions) => void;
      countUnresolvedBlockers?: (projectId: string, linearIssueId: string) => number;
      getIssueSessionWaitingReason?: (projectId: string, linearIssueId: string) => string | undefined;
      telemetry?: PatchRelayTelemetry | undefined;
    },
  ) {}

  batch<T>(fn: () => T): T {
    this.batchDepth += 1;
    try {
      return fn();
    } finally {
      this.batchDepth -= 1;
      if (this.batchDepth === 0) {
        this.flushPendingProjections();
      }
    }
  }

  assertNotMidBatch(context: string): void {
    if (this.batchDepth > 0 && this.strictMidBatchReads) {
      throw new Error(
        `Issue-session projection read mid-batch (${context}): the projection is stale until the `
        + "batch flushes. Read it before batchIssueSessionProjections() or after it returns.",
      );
    }
  }

  issueChanged(issue: IssueRecord, options?: IssueSessionProjectionOptions): void {
    const dependents = this.deps.listDependents(issue.projectId, issue.linearIssueId);
    this.emitInvalidated("issue_changed", issue.projectId, issue.linearIssueId, issue.issueKey, 1 + dependents.length);
    this.projectIssue(issue, "issue_changed", options);
    for (const dependent of dependents) {
      this.projectIssueById(dependent.projectId, dependent.linearIssueId, "issue_changed");
    }
  }

  issueRunChanged(issue: IssueRecord, options?: IssueSessionProjectionOptions): void {
    this.emitInvalidated("issue_run_changed", issue.projectId, issue.linearIssueId, issue.issueKey, 1);
    this.projectIssue(issue, "issue_run_changed", options);
  }

  issueDependenciesChanged(projectId: string, linearIssueId: string): void {
    this.emitInvalidated("issue_dependencies_changed", projectId, linearIssueId, undefined, 1);
    this.projectIssueById(projectId, linearIssueId, "issue_dependencies_changed");
  }

  dependencyBlockerChanged(projectId: string, blockerLinearIssueId: string): void {
    const dependents = this.deps.listDependents(projectId, blockerLinearIssueId);
    this.emitInvalidated("dependency_blocker_changed", projectId, blockerLinearIssueId, undefined, dependents.length);
    for (const dependent of dependents) {
      this.projectIssueById(dependent.projectId, dependent.linearIssueId, "dependency_blocker_changed");
    }
  }

  issueSessionEventsChanged(projectId: string, linearIssueId: string): void {
    this.emitInvalidated("issue_session_events_changed", projectId, linearIssueId, undefined, 1);
    this.projectIssueById(projectId, linearIssueId, "issue_session_events_changed");
  }

  private projectIssueById(projectId: string, linearIssueId: string, reason: ProjectionInvalidationReason): void {
    if (this.batchDepth > 0) {
      this.queueProjection({ projectId, linearIssueId, reason });
      return;
    }
    const issue = this.deps.getIssue(projectId, linearIssueId);
    if (issue) {
      this.projectIssue(issue, reason);
    }
  }

  private projectIssue(
    issue: IssueRecord,
    reason: ProjectionInvalidationReason,
    options?: IssueSessionProjectionOptions,
  ): void {
    if (this.batchDepth > 0) {
      this.queueProjection({
        projectId: issue.projectId,
        linearIssueId: issue.linearIssueId,
        issue,
        reason,
        ...(options ? { options } : {}),
      });
      return;
    }
    const beforeWaitingReason = this.deps.getIssueSessionWaitingReason?.(issue.projectId, issue.linearIssueId);
    this.deps.projectIssue(issue, options);
    this.emitReprojected(reason, issue);
    const unresolved = this.deps.countUnresolvedBlockers?.(issue.projectId, issue.linearIssueId);
    const afterWaitingReason = this.deps.getIssueSessionWaitingReason?.(issue.projectId, issue.linearIssueId);
    if (
      unresolved === 0
      && beforeWaitingReason?.startsWith("Blocked by ")
      && !afterWaitingReason?.startsWith("Blocked by ")
    ) {
      emitTelemetry(this.deps.telemetry ?? noopTelemetry, {
        type: "health.invariant",
        invariant: "stale_blocked_read_model",
        status: "repaired",
        projectId: issue.projectId,
        linearIssueId: issue.linearIssueId,
        ...(issue.issueKey ? { issueKey: issue.issueKey } : {}),
        detail: "Projection cleared stale blocked waiting reason after blockers resolved",
      });
    } else if (unresolved === 0 && afterWaitingReason?.startsWith("Blocked by ")) {
      emitTelemetry(this.deps.telemetry ?? noopTelemetry, {
        type: "health.invariant",
        invariant: "stale_blocked_read_model",
        status: "observed",
        projectId: issue.projectId,
        linearIssueId: issue.linearIssueId,
        ...(issue.issueKey ? { issueKey: issue.issueKey } : {}),
        detail: "Issue session still reports blocked after source blockers resolved",
      });
    }
  }

  private emitInvalidated(
    reason: ProjectionInvalidationReason,
    projectId: string,
    linearIssueId: string,
    issueKey: string | undefined,
    affectedCount: number,
  ): void {
    emitTelemetry(this.deps.telemetry ?? noopTelemetry, {
      type: "projection.invalidated",
      reason,
      projectId,
      linearIssueId,
      ...(issueKey ? { issueKey } : {}),
      affectedCount,
    });
  }

  private emitReprojected(reason: ProjectionInvalidationReason, issue: IssueRecord): void {
    emitTelemetry(this.deps.telemetry ?? noopTelemetry, {
      type: "projection.reprojected",
      reason,
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      ...(issue.issueKey ? { issueKey: issue.issueKey } : {}),
    });
  }

  private queueProjection(projection: PendingProjection): void {
    const key = `${projection.projectId}::${projection.linearIssueId}`;
    const current = this.pendingProjections.get(key);
    this.pendingProjections.set(key, {
      projectId: projection.projectId,
      linearIssueId: projection.linearIssueId,
      issue: projection.issue ?? current?.issue,
      reason: projection.reason,
      options: mergeProjectionOptions(current?.options, projection.options),
    });
  }

  private flushPendingProjections(): void {
    const pending = Array.from(this.pendingProjections.values());
    this.pendingProjections.clear();
    for (const projection of pending) {
      const issue = projection.issue ?? this.deps.getIssue(projection.projectId, projection.linearIssueId);
      if (issue) {
        this.projectIssue(issue, projection.reason, projection.options);
      }
    }
  }
}

interface PendingProjection {
  projectId: string;
  linearIssueId: string;
  issue?: IssueRecord | undefined;
  reason: ProjectionInvalidationReason;
  options?: IssueSessionProjectionOptions | undefined;
}

function mergeProjectionOptions(
  current: IssueSessionProjectionOptions | undefined,
  next: IssueSessionProjectionOptions | undefined,
): IssueSessionProjectionOptions | undefined {
  if (!current) return next;
  if (!next) return current;
  return { ...current, ...next };
}
