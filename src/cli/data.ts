import { existsSync } from "node:fs";
import { PatchRelayDatabase } from "../db.ts";
import type { OperatorClosedEventPayload } from "../issue-session-events.ts";
import { buildManualRetryAttemptReset, resolveRetryTarget } from "../manual-issue-actions.ts";
import { buildOperatorRetryEvent } from "../operator-retry-event.ts";
import { buildWorkflowSnapshotForIssue } from "../workflow-task-reconciler.ts";
import { peekRunnableWorkflowTaskRunType } from "../pending-workflow-task.ts";
import type { WorkflowSnapshot } from "../workflow-model.ts";
import {
  deriveIssueExecutionStateFromRecords,
  type IssueExecutionState,
} from "../issue-execution-state.ts";
import { WorktreeManager } from "../worktree-manager.ts";
import { CliOperatorApiClient } from "./operator-client.ts";
import type { RunType } from "../run-type.ts";
import type {
  AppConfig,
  IssueRecord,
  RunRecord,
  TrackedIssueRecord,
  WorkflowObservationRecord,
  WorkflowTaskRecord,
} from "../types.ts";
export type {
  CliOperatorDataAccess,
  ConnectResult,
  ConnectStateResult,
  InstallationListResult,
} from "./operator-client.ts";

export interface WorktreeResult {
  issue: TrackedIssueRecord;
  branchName: string;
  worktreePath: string;
  repoId: string;
}

export interface OpenResult extends WorktreeResult {
  resumeThreadId?: string;
  needsNewSession?: boolean;
}

export interface RetryResult {
  issue: TrackedIssueRecord;
  runType: string;
  reason?: string;
}

export interface PromptResult {
  issueKey: string;
  delivered: boolean;
  queued?: boolean;
}

export interface IssueTraceObservation extends Omit<WorkflowObservationRecord, "payloadJson"> {
  payload?: Record<string, unknown> | undefined;
}

export interface IssueTraceTask extends Omit<WorkflowTaskRecord, "requirementsJson"> {
  requirements?: Record<string, unknown> | undefined;
}

export interface IssueTraceResult {
  issue: TrackedIssueRecord;
  snapshot: WorkflowSnapshot;
  executionState: IssueExecutionState;
  activeRun: RunRecord | null;
  tasks: IssueTraceTask[];
  observations: IssueTraceObservation[];
}

export interface CloseResult {
  issue: TrackedIssueRecord;
  phase: "done" | "failed";
  reason?: string;
  releasedRunId?: number;
}

function safeJsonParse(value: string | undefined): Record<string, unknown> | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

// Display phase is derived at the presentation boundary.

export class CliDataAccess extends CliOperatorApiClient {
  readonly db: PatchRelayDatabase;

  constructor(
    readonly config: AppConfig,
    options?: { db?: PatchRelayDatabase },
  ) {
    super(config);
    this.db = options?.db ?? new PatchRelayDatabase(config.database.path, config.database.wal);
    if (!options?.db) {
      this.db.assertSchemaReady();
    }
  }

  close(): void {}

  worktree(issueKey: string): WorktreeResult | undefined {
    const issue = this.db.getTrackedIssueByKey(issueKey);
    if (!issue) return undefined;

    const dbIssue = this.db.issues.getIssueByKey(issueKey)!;
    if (!dbIssue.branchName || !dbIssue.worktreePath) return undefined;

    return { issue, branchName: dbIssue.branchName, worktreePath: dbIssue.worktreePath, repoId: issue.projectId };
  }

  open(issueKey: string): OpenResult | undefined {
    const worktree = this.worktree(issueKey);
    if (!worktree) return undefined;

    const dbIssue = this.db.issues.getIssueByKey(issueKey)!;
    const resumeThreadId = dbIssue.threadId ?? undefined;
    return {
      ...worktree,
      ...(resumeThreadId ? { resumeThreadId } : {}),
    };
  }

  async resolveOpen(
    issueKey: string,
    options?: { ensureWorktree?: boolean },
  ): Promise<OpenResult | undefined> {
    const worktree = this.worktree(issueKey);
    if (!worktree) return undefined;

    if (options?.ensureWorktree) {
      await this.ensureOpenWorktree(worktree);
    }

    const dbIssue = this.db.issues.getIssueByKey(issueKey)!;
    const existingThreadId = dbIssue.threadId;
    if (existingThreadId) {
      return { ...worktree, resumeThreadId: existingThreadId };
    }
    return { ...worktree, needsNewSession: true };
  }

  async prepareOpen(issueKey: string): Promise<OpenResult | undefined> {
    return await this.resolveOpen(issueKey, { ensureWorktree: true });
  }

  retry(issueKey: string, options?: { runType?: string; reason?: string }): RetryResult | undefined {
    const issue = this.db.getTrackedIssueByKey(issueKey);
    if (!issue) return undefined;

    const dbIssue = this.db.issues.getIssueByKey(issueKey)!;
    const issueSession = this.db.issueSessions.getIssueSession(issue.projectId, issue.linearIssueId);
    if (dbIssue.activeRunId !== undefined) {
      throw new Error(`Issue ${issueKey} already has an active run.`);
    }

    const runType = (options?.runType
      ?? resolveRetryTarget({
        prNumber: dbIssue.prNumber,
        prState: dbIssue.prState,
        prReviewState: dbIssue.prReviewState,
        prCheckStatus: dbIssue.prCheckStatus,
        runnableTaskRunType: peekRunnableWorkflowTaskRunType(this.db, dbIssue.projectId, dbIssue.linearIssueId),
        lastRunType: issueSession?.lastRunType,
        lastGitHubFailureSource: issue.latestFailureSource,
      }).runType) as RunType;

    this.appendRetryWorkflowEvent(dbIssue, runType);
    this.db.issues.upsertIssue({
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      workflowOutcome: null,
      workflowOutcomeReason: null,
      inputRequestKind: null,
      ...buildManualRetryAttemptReset(runType),
    });
    const updated = this.db.getTrackedIssue(issue.projectId, issue.linearIssueId)!;
    return { issue: updated, runType, ...(options?.reason ? { reason: options.reason } : {}) };
  }

  closeIssue(issueKey: string, options?: { failed?: boolean; reason?: string }): CloseResult | undefined {
    const issue = this.db.getTrackedIssueByKey(issueKey);
    if (!issue) return undefined;

    const dbIssue = this.db.issues.getIssueByKey(issueKey)!;
    const terminalState = options?.failed ? "failed" : "done";
    const run = dbIssue.activeRunId ? this.db.runs.getRunById(dbIssue.activeRunId) : undefined;

    this.db.issueSessions.appendIssueSessionEventRespectingActiveLease(issue.projectId, issue.linearIssueId, {
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      eventType: "operator_closed",
      eventJson: JSON.stringify({
        terminalState,
        ...(options?.reason ? { reason: options.reason } : {}),
      } satisfies OperatorClosedEventPayload),
      dedupeKey: `operator_closed:${issue.linearIssueId}:${terminalState}:${dbIssue.activeRunId ?? "no-run"}`,
    });
    this.db.issueSessions.clearPendingIssueSessionEventsRespectingActiveLease(issue.projectId, issue.linearIssueId);
    if (run) {
      this.db.issueSessions.finishRunRespectingActiveLease(issue.projectId, issue.linearIssueId, run.id, {
        status: "released",
        failureReason: options?.reason
          ? `Operator closed issue as ${terminalState}: ${options.reason}`
          : `Operator closed issue as ${terminalState}`,
      });
    }
    // Operator CLI manual close — interactive, single-writer by construction
    // (see the issue-write-door guard allowlist), so a raw upsert is fine.
    this.db.upsertIssue({
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      delegatedToPatchRelay: false,
      workflowOutcome: terminalState === "done" ? "completed" : "failed",
      workflowOutcomeReason: options?.reason ?? "operator_closed",
      inputRequestKind: null,
      activeRunId: null,
    });
    this.db.issueSessions.releaseIssueSessionLeaseRespectingActiveLease(issue.projectId, issue.linearIssueId);

    const updated = this.db.getTrackedIssue(issue.projectId, issue.linearIssueId)!;
    return {
      issue: updated,
      phase: terminalState,
      ...(options?.reason ? { reason: options.reason } : {}),
      ...(run ? { releasedRunId: run.id } : {}),
    };
  }

  trace(issueKey: string): IssueTraceResult | undefined {
    const issue = this.db.getTrackedIssueByKey(issueKey);
    if (!issue) return undefined;

    const dbIssue = this.db.issues.getIssueByKey(issueKey)!;
    const snapshot = buildWorkflowSnapshotForIssue(this.db, dbIssue);
    const runs = this.db.runs.listRunsForIssue(issue.projectId, issue.linearIssueId);
    const activeRun = dbIssue.activeRunId !== undefined ? this.db.runs.getRunById(dbIssue.activeRunId) : undefined;
    const latestRun = runs.at(-1);
    const runnableTaskRunType = snapshot.openTasks.find((task) => task.type === "run" && task.runType)?.runType;
    const blockedByKeys = this.db.issues.listIssueDependencies(issue.projectId, issue.linearIssueId)
      .filter((entry) => entry.blockerCurrentLinearStateType !== "completed"
        && entry.blockerCurrentLinearState?.trim().toLowerCase() !== "done")
      .map((entry) => entry.blockerIssueKey ?? entry.blockerLinearIssueId);
    const executionState = deriveIssueExecutionStateFromRecords(dbIssue, {
      activeRun,
      latestRun,
      blockedByKeys,
      ...(runnableTaskRunType ? { runnableTaskRunType } : {}),
    });
    const observations = this.db.workflowObservations
      .listObservations(issue.projectId, issue.linearIssueId)
      .map((observation): IssueTraceObservation => {
        const payload = safeJsonParse(observation.payloadJson);
        return {
          id: observation.id,
          projectId: observation.projectId,
          subjectId: observation.subjectId,
          source: observation.source,
          type: observation.type,
          ...(observation.dedupeKey ? { dedupeKey: observation.dedupeKey } : {}),
          observedAt: observation.observedAt,
          ...(payload ? { payload } : {}),
        };
      });
    const tasks = this.db.workflowTasks
      .listTasks(issue.projectId, issue.linearIssueId)
      .map((task): IssueTraceTask => {
        const requirements = safeJsonParse(task.requirementsJson);
        return {
          id: task.id,
          projectId: task.projectId,
          subjectId: task.subjectId,
          taskId: task.taskId,
          taskType: task.taskType,
          ...(task.runType ? { runType: task.runType } : {}),
          status: task.status,
          reason: task.reason,
          authorityEpoch: task.authorityEpoch,
          gateAction: task.gateAction,
          ...(task.gateReason ? { gateReason: task.gateReason } : {}),
          createdAt: task.createdAt,
          updatedAt: task.updatedAt,
          ...(task.closedAt ? { closedAt: task.closedAt } : {}),
          ...(requirements ? { requirements } : {}),
        };
      });

    return { issue, snapshot, executionState, activeRun: activeRun ?? null, tasks, observations };
  }

  private appendRetryWorkflowEvent(issue: IssueRecord, runType: RunType): void {
    this.db.issueSessions.appendIssueSessionEventRespectingActiveLease(issue.projectId, issue.linearIssueId, {
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      ...buildOperatorRetryEvent(issue, runType),
    });
  }

  private async ensureOpenWorktree(worktree: WorktreeResult): Promise<void> {
    if (existsSync(worktree.worktreePath)) return;
    const project = this.config.projects.find((entry) => entry.id === worktree.repoId);
    if (!project) throw new Error(`Project not found for ${worktree.repoId}`);
    const worktreeManager = new WorktreeManager(this.config);
    await worktreeManager.ensureIssueWorktree(
      project.repoPath,
      project.worktreeRoot,
      worktree.worktreePath,
      worktree.branchName,
    );
  }

}
