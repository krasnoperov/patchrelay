import type {
  IssueControlRecord,
  IssueLifecycleStatus,
  IssueProjectionRecord,
  PipelineRunRecord,
  RunLeaseRecord,
  StageRunRecord,
  TrackedIssueRecord,
  WorkspaceOwnershipRecord,
  WorkspaceRecord,
} from "../types.ts";
import type { AuthoritativeLedgerStore } from "./authoritative-ledger-store.ts";
import type { IssueProjectionStore } from "./issue-projection-store.ts";
import type { RunReportStore } from "./run-report-store.ts";
import { isoNow } from "./shared.ts";

interface IssueWorkflowStoreDependencies {
  authoritativeLedger: AuthoritativeLedgerStore;
  issueProjections: IssueProjectionStore;
  runReports: RunReportStore;
}

export class IssueWorkflowStore {
  private readonly authoritativeLedger: AuthoritativeLedgerStore;
  private readonly issueProjections: IssueProjectionStore;
  private readonly runReports: RunReportStore;

  constructor(dependencies: IssueWorkflowStoreDependencies) {
    this.authoritativeLedger = dependencies.authoritativeLedger;
    this.issueProjections = dependencies.issueProjections;
    this.runReports = dependencies.runReports;
  }

  getTrackedIssue(projectId: string, linearIssueId: string): TrackedIssueRecord | undefined {
    const issueControl = this.authoritativeLedger.getIssueControl(projectId, linearIssueId);
    const projection = this.issueProjections.getIssueProjection(projectId, linearIssueId);
    if (!issueControl && !projection) {
      return undefined;
    }

    return this.buildTrackedIssue(issueControl, projection);
  }

  getTrackedIssueByKey(issueKey: string): TrackedIssueRecord | undefined {
    const projection = this.issueProjections.getIssueProjectionByKey(issueKey);
    if (!projection) {
      return undefined;
    }
    return this.getTrackedIssue(projection.projectId, projection.linearIssueId);
  }

  getTrackedIssueByLinearIssueId(linearIssueId: string): TrackedIssueRecord | undefined {
    const projection = this.issueProjections.getIssueProjectionByLinearIssueId(linearIssueId);
    if (!projection) {
      return undefined;
    }
    return this.getTrackedIssue(projection.projectId, linearIssueId);
  }

  listActiveStageRuns(): StageRunRecord[] {
    return this.authoritativeLedger
      .listActiveRunLeases()
      .filter((runLease) => runLease.status === "running")
      .map((runLease) => this.buildStageRun(runLease));
  }

  getWorkspace(id: number): WorkspaceRecord | undefined {
    const workspaceOwnership = this.authoritativeLedger.getWorkspaceOwnership(id);
    return workspaceOwnership ? this.buildWorkspace(workspaceOwnership) : undefined;
  }

  getActiveWorkspaceForIssue(projectId: string, linearIssueId: string): WorkspaceRecord | undefined {
    const workspaceOwnership = this.authoritativeLedger.getWorkspaceOwnershipForIssue(projectId, linearIssueId);
    return workspaceOwnership ? this.buildWorkspace(workspaceOwnership) : undefined;
  }

  getPipelineRun(id: number): PipelineRunRecord | undefined {
    const runLease = this.authoritativeLedger.getRunLease(id);
    if (!runLease) {
      return undefined;
    }
    const issueControl = this.authoritativeLedger.getIssueControl(runLease.projectId, runLease.linearIssueId);
    const status = resolvePipelineStatus(runLease.status, issueControl?.lifecycleStatus);
    return {
      id: runLease.id,
      projectId: runLease.projectId,
      linearIssueId: runLease.linearIssueId,
      workspaceId: runLease.workspaceOwnershipId,
      status,
      currentStage: runLease.stage,
      startedAt: runLease.startedAt,
      ...(runLease.endedAt ? { endedAt: runLease.endedAt } : {}),
    };
  }

  getStageRun(id: number): StageRunRecord | undefined {
    const runLease = this.authoritativeLedger.getRunLease(id);
    return runLease ? this.buildStageRun(runLease) : undefined;
  }

  getStageRunByThreadId(threadId: string): StageRunRecord | undefined {
    const runLease = this.authoritativeLedger.getRunLeaseByThreadId(threadId);
    return runLease ? this.buildStageRun(runLease) : undefined;
  }

  listStageRunsForIssue(projectId: string, linearIssueId: string): StageRunRecord[] {
    return this.authoritativeLedger.listRunLeasesForIssue(projectId, linearIssueId).map((runLease) => this.buildStageRun(runLease));
  }

  getLatestStageRunForIssue(projectId: string, linearIssueId: string): StageRunRecord | undefined {
    const latestRunLease = this.getLatestRunLeaseForIssue(projectId, linearIssueId);
    return latestRunLease ? this.buildStageRun(latestRunLease) : undefined;
  }

  getIssueOverview(issueKey: string): {
    issue: TrackedIssueRecord;
    workspace?: WorkspaceRecord;
    pipeline?: PipelineRunRecord;
    activeStageRun?: StageRunRecord;
  } | undefined {
    const issue = this.getTrackedIssueByKey(issueKey);
    if (!issue) {
      return undefined;
    }

    const issueControl = this.authoritativeLedger.getIssueControl(issue.projectId, issue.linearIssueId);
    const activeWorkspaceOwnershipId = issueControl?.activeWorkspaceOwnershipId;
    const activeRunLeaseId = issueControl?.activeRunLeaseId;
    const workspace = activeWorkspaceOwnershipId ? this.getWorkspace(activeWorkspaceOwnershipId) : this.getActiveWorkspaceForIssue(issue.projectId, issue.linearIssueId);
    const pipeline = activeRunLeaseId ? this.getPipelineRun(activeRunLeaseId) : issue.activePipelineRunId ? this.getPipelineRun(issue.activePipelineRunId) : undefined;
    const activeStageRun = activeRunLeaseId === undefined ? undefined : this.getStageRun(activeRunLeaseId);

    return {
      issue,
      ...(workspace ? { workspace } : {}),
      ...(pipeline ? { pipeline } : {}),
      ...(activeStageRun ? { activeStageRun } : {}),
    };
  }

  private buildTrackedIssue(
    issueControl: IssueControlRecord | undefined,
    projection: IssueProjectionRecord | undefined,
  ): TrackedIssueRecord {
    const projectId = issueControl?.projectId ?? projection?.projectId;
    const linearIssueId = issueControl?.linearIssueId ?? projection?.linearIssueId;
    if (!projectId || !linearIssueId) {
      throw new Error("Cannot synthesize tracked issue without an issue identity");
    }
    const latestRun = this.getLatestRunLeaseForIssue(projectId, linearIssueId);
    const activeRun = issueControl?.activeRunLeaseId ? this.getStageRun(issueControl.activeRunLeaseId) : undefined;

    return {
      id: issueControl?.id ?? projection?.id ?? 0,
      projectId,
      linearIssueId,
      ...(projection?.issueKey ? { issueKey: projection.issueKey } : {}),
      ...(projection?.title ? { title: projection.title } : {}),
      ...(projection?.issueUrl ? { issueUrl: projection.issueUrl } : {}),
      ...(projection?.currentLinearState ? { currentLinearState: projection.currentLinearState } : {}),
      ...(issueControl?.desiredStage ? { desiredStage: issueControl.desiredStage } : {}),
      ...(() => {
        if (!issueControl?.desiredReceiptId) {
          return {};
        }
        const receipt = this.authoritativeLedger.getEventReceipt(issueControl.desiredReceiptId);
        return receipt?.externalId ? { desiredWebhookId: receipt.externalId } : {};
      })(),
      ...(issueControl?.activeWorkspaceOwnershipId !== undefined ? { activeWorkspaceId: issueControl.activeWorkspaceOwnershipId } : {}),
      ...(latestRun ? { activePipelineRunId: latestRun.id } : {}),
      ...(issueControl?.activeRunLeaseId !== undefined ? { activeStageRunId: issueControl.activeRunLeaseId } : {}),
      ...(activeRun?.threadId ? { latestThreadId: activeRun.threadId } : latestRun?.threadId ? { latestThreadId: latestRun.threadId } : {}),
      ...(issueControl?.serviceOwnedCommentId ? { statusCommentId: issueControl.serviceOwnedCommentId } : {}),
      ...(issueControl?.activeAgentSessionId ? { activeAgentSessionId: issueControl.activeAgentSessionId } : {}),
      lifecycleStatus: issueControl?.lifecycleStatus ?? "idle",
      ...(projection?.lastWebhookAt ? { lastWebhookAt: projection.lastWebhookAt } : {}),
      updatedAt: issueControl?.updatedAt ?? projection?.updatedAt ?? isoNow(),
    };
  }

  private buildWorkspace(workspaceOwnership: WorkspaceOwnershipRecord): WorkspaceRecord {
    const stageRuns = this.listStageRunsForIssue(workspaceOwnership.projectId, workspaceOwnership.linearIssueId);
    const latestStageRun = stageRuns.findLast((stageRun) => stageRun.status !== "running") ?? stageRuns.at(-1);
    return {
      id: workspaceOwnership.id,
      projectId: workspaceOwnership.projectId,
      linearIssueId: workspaceOwnership.linearIssueId,
      branchName: workspaceOwnership.branchName,
      worktreePath: workspaceOwnership.worktreePath,
      status: workspaceOwnership.status === "released" ? "closed" : workspaceOwnership.status,
      ...(latestStageRun ? { lastStage: latestStageRun.stage } : {}),
      ...(latestStageRun?.threadId ? { lastThreadId: latestStageRun.threadId } : {}),
      createdAt: workspaceOwnership.createdAt,
      updatedAt: workspaceOwnership.updatedAt,
    };
  }

  private buildStageRun(runLease: RunLeaseRecord): StageRunRecord {
    const report = this.runReports.getRunReport(runLease.id);
    const triggerWebhookId = runLease.triggerReceiptId
      ? this.authoritativeLedger.getEventReceipt(runLease.triggerReceiptId)?.externalId ?? `run-lease:${runLease.id}`
      : `run-lease:${runLease.id}`;
    return {
      id: runLease.id,
      pipelineRunId: runLease.id,
      projectId: runLease.projectId,
      linearIssueId: runLease.linearIssueId,
      workspaceId: runLease.workspaceOwnershipId,
      stage: runLease.stage,
      status:
        runLease.status === "failed"
          ? "failed"
          : runLease.status === "completed" || runLease.status === "released" || runLease.status === "paused"
            ? "completed"
            : "running",
      triggerWebhookId,
      workflowFile: runLease.workflowFile,
      promptText: runLease.promptText,
      ...(runLease.threadId ? { threadId: runLease.threadId } : {}),
      ...(runLease.parentThreadId ? { parentThreadId: runLease.parentThreadId } : {}),
      ...(runLease.turnId ? { turnId: runLease.turnId } : {}),
      ...(report?.summaryJson ? { summaryJson: report.summaryJson } : {}),
      ...(report?.reportJson ? { reportJson: report.reportJson } : {}),
      startedAt: runLease.startedAt,
      ...(runLease.endedAt ? { endedAt: runLease.endedAt } : {}),
    };
  }

  private getLatestRunLeaseForIssue(projectId: string, linearIssueId: string): RunLeaseRecord | undefined {
    return this.authoritativeLedger.listRunLeasesForIssue(projectId, linearIssueId).at(-1);
  }
}

function resolvePipelineStatus(runStatus: RunLeaseRecord["status"], lifecycleStatus: IssueLifecycleStatus | undefined): PipelineRunRecord["status"] {
  if (lifecycleStatus === "paused") {
    return "paused";
  }
  if (runStatus === "failed" || lifecycleStatus === "failed") {
    return "failed";
  }
  if (runStatus === "completed" || runStatus === "released" || lifecycleStatus === "completed") {
    return "completed";
  }
  return "active";
}
