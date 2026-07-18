import type { Logger } from "pino";
import type { PatchRelayDatabase } from "./db.ts";
import type { IssueRecord } from "./db-types.ts";
import type { RunType } from "./run-type.ts";
import type { IssueSessionLease } from "./issue-session-lease-service.ts";
import type { IssueSessionEventType } from "./issue-session-events.ts";
import {
  getCiRepairBudget,
  getQueueRepairBudget,
  getReviewFixBudget,
} from "./run-budgets.ts";
import { isIssueTerminalProjection } from "./issue-execution-state.ts";
import { buildRequestedChangesWorkflowIdentity } from "./reactive-workflow-keys.ts";
import { serializeRunContext, tryParseRunContextValue, type RunContext } from "./run-context.ts";
import { assertNever } from "./utils.ts";
import type { WorkflowRunIntent } from "./workflow-intent.ts";
import type { ProjectConfig } from "./workflow-types.ts";
import { reconcileWorkflowTasksForIssue } from "./workflow-task-reconciler.ts";

const WRITER = "run-task-planner";

export function buildRequestedChangesLoopEscalationReason(attempts: number, configuredLimit: number): string {
  return `Repeated/systemic requested-changes review loop after ${attempts} repair attempts (configured limit: ${configuredLimit}). Next action: consolidate the accumulated review history and audit the violated invariants, or split an oversized PR before requesting another review.`;
}

export interface RunnableWorkflowIntent extends WorkflowRunIntent {
  workflowReason?: string | undefined;
  resumeThread: boolean;
  eventIds: number[];
}

export type AppendRunIntentEventWithLease = (
  lease: IssueSessionLease,
  issue: Pick<IssueRecord, "projectId" | "linearIssueId" | "prHeadSha" | "lastGitHubFailureSignature" | "lastGitHubFailureHeadSha">,
  runType: RunType,
  context?: RunContext,
  dedupeScope?: string,
) => boolean;

function parseObjectJson(raw: string | undefined): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

export class RunTaskPlanner {
  constructor(
    private readonly db: PatchRelayDatabase,
    private readonly logger?: Logger,
  ) {}

  resolveRunTask(issue: IssueRecord): RunnableWorkflowIntent | undefined {
    const freshIssue = this.db.issues.getIssue(issue.projectId, issue.linearIssueId) ?? issue;
    if (isIssueTerminalProjection(freshIssue)) {
      return undefined;
    }
    if (this.db.issues.countUnresolvedBlockers(freshIssue.projectId, freshIssue.linearIssueId) > 0) {
      return undefined;
    }

    const existingWorkflowTask = this.resolveRunnableWorkflowTask(freshIssue);
    if (existingWorkflowTask) return existingWorkflowTask;

    this.reconcileWorkflowTasks(freshIssue);

    const workflowTask = this.resolveRunnableWorkflowTask(freshIssue);
    if (workflowTask) return workflowTask;

    return undefined;
  }

  private resolveRunnableWorkflowTask(issue: IssueRecord): RunnableWorkflowIntent | undefined {
    const task = this.db.workflowTasks
      .listOpenRunnableTasks(issue.projectId)
      .find((entry) => entry.subjectId === issue.linearIssueId);
    if (!task?.runType) return undefined;
    const runType = task.runType;
    const rawRequirements = parseObjectJson(task.requirementsJson);
    const context = tryParseRunContextValue({
      ...rawRequirements,
      ...(rawRequirements?.blockingHeadSha ? { requestedChangesHeadSha: rawRequirements.blockingHeadSha } : {}),
      source: "workflow_task",
    }) ?? { source: "workflow_task" };
    // S5: inbox tasks (run:input / run:orchestration_followup) resume the
    // existing thread even for an implementation run type — the human/child
    // follow-up continues an in-progress session. They carry `resumeThread:true`
    // in their requirements; reconciled-fact tasks keep the runType default.
    const resumeThread = rawRequirements?.resumeThread === true || runType !== "implementation";
    return {
      kind: "run",
      runType,
      ...(Object.keys(context).length > 0 ? { context } : {}),
      workflowReason: task.taskId,
      resumeThread,
      eventIds: [],
    };
  }

  private reconcileWorkflowTasks(issue: IssueRecord): void {
    try {
      reconcileWorkflowTasksForIssue(this.db, issue);
    } catch (error) {
      this.logger?.warn(
        {
          projectId: issue.projectId,
          linearIssueId: issue.linearIssueId,
          ...(issue.issueKey ? { issueKey: issue.issueKey } : {}),
          error: error instanceof Error ? error.message : String(error),
        },
        "Workflow task reconciliation failed while planning runnable task",
      );
    }
  }

  appendRunIntentEventWithLease(
    lease: IssueSessionLease,
    issue: Pick<IssueRecord, "projectId" | "linearIssueId" | "prHeadSha" | "lastGitHubFailureSignature" | "lastGitHubFailureHeadSha">,
    runType: RunType,
    context?: RunContext,
    dedupeScope?: string,
  ): boolean {
    let eventType: IssueSessionEventType;
    let dedupeKey: string;
    let eventContext = context;
    switch (runType) {
      case "queue_repair":
        eventType = "merge_steward_incident";
        dedupeKey = `${dedupeScope ?? "workflow"}:queue_repair:${issue.linearIssueId}:${issue.prHeadSha ?? issue.lastGitHubFailureHeadSha ?? "unknown-sha"}`;
        break;
      case "ci_repair":
        eventType = "settled_red_ci";
        dedupeKey = `${dedupeScope ?? "workflow"}:ci_repair:${issue.linearIssueId}:${issue.lastGitHubFailureSignature ?? issue.prHeadSha ?? "unknown-sha"}`;
        break;
      case "review_fix":
      case "branch_upkeep": {
        eventType = "review_changes_requested";
        const identity = buildRequestedChangesWorkflowIdentity({
          linearIssueId: issue.linearIssueId,
          runType,
          headSha: issue.prHeadSha,
        });
        dedupeKey = identity.dedupeKey;
        eventContext = {
          ...context,
          requestedChangesCoalesceKey: identity.coalesceKey,
          ...(identity.headSha ? { requestedChangesHeadSha: identity.headSha } : {}),
        };
        break;
      }
      case "implementation":
        eventType = "delegated";
        dedupeKey = `${dedupeScope ?? "workflow"}:implementation:${issue.linearIssueId}`;
        break;
      default:
        return assertNever(runType, "Unhandled run type in session event append");
    }

    return Boolean(this.db.issueSessions.appendIssueSessionEventWithLease(lease, {
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      eventType,
      ...(eventContext ? { eventJson: serializeRunContext(eventContext, "workflow intent event context") } : {}),
      dedupeKey,
    }));
  }

  budgetExceeded(
    issue: IssueRecord,
    project: ProjectConfig | undefined,
    runType: RunType,
    isRequestedChangesRunType: (runType: RunType) => boolean,
  ): string | undefined {
    const ciRepairBudget = getCiRepairBudget(project);
    if (runType === "ci_repair" && issue.ciRepairAttempts >= ciRepairBudget) {
      return `CI repair budget exhausted (${ciRepairBudget} attempts)`;
    }
    const queueRepairBudget = getQueueRepairBudget(project);
    if (runType === "queue_repair" && issue.queueRepairAttempts >= queueRepairBudget) {
      return `Queue repair budget exhausted (${queueRepairBudget} attempts)`;
    }
    const reviewFixBudget = getReviewFixBudget(project);
    if (isRequestedChangesRunType(runType) && issue.reviewFixAttempts >= reviewFixBudget) {
      return buildRequestedChangesLoopEscalationReason(issue.reviewFixAttempts, reviewFixBudget);
    }
    return undefined;
  }

  incrementAttemptCounters(
    issue: IssueRecord,
    lease: IssueSessionLease,
    runType: RunType,
    isRequestedChangesRunType: (runType: RunType) => boolean,
  ): boolean {
    // The increments are read-modify-write against the issue row (which may
    // be stale by the time the launch path gets here); on conflict, recompute
    // from the fresh row instead of writing a counter derived from the stale
    // read.
    const buildIncrement = (record: Pick<IssueRecord, "ciRepairAttempts" | "queueRepairAttempts" | "reviewFixAttempts">) => {
      if (runType === "ci_repair") {
        return { projectId: issue.projectId, linearIssueId: issue.linearIssueId, ciRepairAttempts: record.ciRepairAttempts + 1 };
      }
      if (runType === "queue_repair") {
        return { projectId: issue.projectId, linearIssueId: issue.linearIssueId, queueRepairAttempts: record.queueRepairAttempts + 1 };
      }
      if (isRequestedChangesRunType(runType)) {
        return { projectId: issue.projectId, linearIssueId: issue.linearIssueId, reviewFixAttempts: record.reviewFixAttempts + 1 };
      }
      return undefined;
    };
    const update = buildIncrement(issue);
    if (!update) return true;
    const commit = this.db.issueSessions.commitIssueState({
      writer: WRITER,
      lease,
      expectedVersion: issue.version,
      update,
      onConflict: (current) => buildIncrement(current),
    });
    return commit.outcome === "applied";
  }
}
