import type { Logger } from "pino";
import type { PatchRelayDatabase } from "./db.ts";
import type { IssueRecord, WorkflowTaskRecord } from "./db-types.ts";
import type { RunType } from "./run-type.ts";
import type { IssueSessionLease } from "./issue-session-lease-service.ts";
import type { IssueSessionEventType } from "./issue-session-events.ts";
import {
  getCiRepairBudget,
  getQueueRepairBudget,
  getReviewFixBudget,
} from "./run-budgets.ts";
import { isTerminalLinearState } from "./pr-state.ts";
import { buildRequestedChangesWakeIdentity } from "./reactive-wake-keys.ts";
import { parseRunContextOrWarn, serializeRunContext, tryParseRunContextValue, type RunContext } from "./run-context.ts";
import { assertNever } from "./utils.ts";
import type { ProjectConfig } from "./workflow-types.ts";
import { reconcileWorkflowTasksForIssue } from "./workflow-task-reconciler.ts";

const WRITER = "run-wake-planner";

export interface PendingRunWake {
  runType: RunType;
  context?: RunContext | undefined;
  wakeReason?: string | undefined;
  resumeThread: boolean;
  eventIds: number[];
}

export type AppendWakeEventWithLease = (
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

export class RunWakePlanner {
  constructor(
    private readonly db: PatchRelayDatabase,
    private readonly logger?: Logger,
  ) {}

  resolveRunWake(issue: IssueRecord): PendingRunWake | undefined {
    const freshIssue = this.db.issues.getIssue(issue.projectId, issue.linearIssueId) ?? issue;
    if (
      freshIssue.factoryState === "done"
      || isTerminalLinearState(freshIssue.currentLinearStateType, freshIssue.currentLinearState)
    ) {
      return undefined;
    }
    if (this.db.issues.countUnresolvedBlockers(freshIssue.projectId, freshIssue.linearIssueId) > 0) {
      return undefined;
    }

    const existingWorkflowTaskWake = this.resolveWorkflowTaskWake(freshIssue);
    if (existingWorkflowTaskWake) return existingWorkflowTaskWake;

    this.reconcileWorkflowTasks(freshIssue);

    const workflowTaskWake = this.resolveWorkflowTaskWake(freshIssue);
    if (workflowTaskWake) return workflowTaskWake;

    const sessionWake = this.db.issueSessions.peekIssueSessionWake(freshIssue.projectId, freshIssue.linearIssueId);
    if (sessionWake) {
      if (this.workflowTasksSuppressSessionWake(freshIssue, sessionWake.wakeReason)) {
        return undefined;
      }
      return {
        runType: sessionWake.runType,
        context: sessionWake.context,
        wakeReason: sessionWake.wakeReason,
        resumeThread: sessionWake.resumeThread,
        eventIds: sessionWake.eventIds,
      };
    }

    if (this.workflowTasksSuppressSessionWake(freshIssue, undefined)) {
      return undefined;
    }

    const implicitWake = this.db.workflowWakes.peekIssueWake(freshIssue.projectId, freshIssue.linearIssueId);
    if (!implicitWake) return undefined;
    return {
      runType: implicitWake.runType,
      context: implicitWake.context,
      wakeReason: implicitWake.wakeReason,
      resumeThread: implicitWake.resumeThread,
      eventIds: implicitWake.eventIds,
    };
  }

  private resolveWorkflowTaskWake(issue: IssueRecord): PendingRunWake | undefined {
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
    return {
      runType,
      ...(Object.keys(context).length > 0 ? { context } : {}),
      wakeReason: task.taskId,
      resumeThread: runType !== "implementation",
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
        "Workflow task reconciliation failed while planning run wake",
      );
    }
  }

  private workflowTasksSuppressSessionWake(issue: IssueRecord, wakeReason: string | undefined): boolean {
    const openTasks = this.db.workflowTasks.listOpenTasks(issue.projectId, issue.linearIssueId);
    if (openTasks.length === 0) return false;
    if (openTasks.some((task) => task.taskType === "run" && task.gateAction === "start" && task.runType !== undefined)) {
      return false;
    }
    if (!openTasks.some((task) => this.isBlockingWorkflowGate(task))) return false;
    if (!openTasks.every((task) => task.taskId === "wait:input")) {
      return true;
    }
    return wakeReason !== "direct_reply"
      && wakeReason !== "followup_prompt"
      && wakeReason !== "followup_comment"
      && wakeReason !== "human_instruction"
      && wakeReason !== "operator_prompt"
      && wakeReason !== "completion_check_continue";
  }

  private isBlockingWorkflowGate(task: WorkflowTaskRecord): boolean {
    if (task.taskId === "wait:input") return true;
    if (task.taskId === "wait:children" || task.taskId === "wait:blockers" || task.taskId.startsWith("wait:active-run:")) {
      return true;
    }
    if (task.taskId === "wait:authority") {
      return this.workflowAuthorityObserved(task.projectId, task.subjectId);
    }
    return task.taskType === "verify" || task.taskType === "ask" || task.taskType === "escalate" || task.taskType === "publish";
  }

  private workflowAuthorityObserved(projectId: string, linearIssueId: string): boolean {
    return this.db.workflowObservations
      .listObservations(projectId, linearIssueId)
      .some((observation) => (
        observation.type === "linear.delegated"
        || observation.type === "linear.undelegated"
        || observation.type === "operator.authority_changed"
      ));
  }

  appendWakeEventWithLease(
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
        dedupeKey = `${dedupeScope ?? "wake"}:queue_repair:${issue.linearIssueId}:${issue.prHeadSha ?? issue.lastGitHubFailureHeadSha ?? "unknown-sha"}`;
        break;
      case "ci_repair":
        eventType = "settled_red_ci";
        dedupeKey = `${dedupeScope ?? "wake"}:ci_repair:${issue.linearIssueId}:${issue.lastGitHubFailureSignature ?? issue.prHeadSha ?? "unknown-sha"}`;
        break;
      case "review_fix":
      case "branch_upkeep": {
        eventType = "review_changes_requested";
        const identity = buildRequestedChangesWakeIdentity({
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
        dedupeKey = `${dedupeScope ?? "wake"}:implementation:${issue.linearIssueId}`;
        break;
      default:
        return assertNever(runType, "Unhandled run type in wake event append");
    }

    return Boolean(this.db.issueSessions.appendIssueSessionEventWithLease(lease, {
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      eventType,
      ...(eventContext ? { eventJson: serializeRunContext(eventContext, "wake event context") } : {}),
      dedupeKey,
    }));
  }

  materializeLegacyPendingWake(
    issue: IssueRecord,
    lease: IssueSessionLease,
  ): IssueRecord {
    if (!issue.pendingRunType) return issue;
    // Boundary over possibly-old DB rows: a legacy pending context that no
    // longer parses is dropped (with a warning) instead of wedging the wake.
    const context = parseRunContextOrWarn(
      issue.pendingRunContextJson,
      (message) => this.logger?.warn(
        { issueKey: issue.issueKey, linearIssueId: issue.linearIssueId },
        `Dropping unparseable legacy pending run context: ${message}`,
      ),
      "legacy pending run context",
    );
    this.appendWakeEventWithLease(lease, issue, issue.pendingRunType, context, "legacy_pending");
    const commit = this.db.issueSessions.commitIssueState({
      writer: WRITER,
      lease,
      update: {
        projectId: issue.projectId,
        linearIssueId: issue.linearIssueId,
        pendingRunType: null,
        pendingRunContextJson: null,
      },
    });
    if (commit.outcome !== "applied") return issue;
    return commit.issue;
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
      return `Requested-changes budget exhausted (${reviewFixBudget} attempts)`;
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
