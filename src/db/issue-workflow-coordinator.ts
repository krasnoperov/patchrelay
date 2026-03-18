import type {
  IssueLifecycleStatus,
  PipelineRunRecord,
  StageRunRecord,
  TrackedIssueRecord,
  WorkflowStage,
  WorkspaceRecord,
} from "../types.ts";
import type { AuthoritativeLedgerStore } from "./authoritative-ledger-store.ts";
import type { IssueProjectionStore } from "./issue-projection-store.ts";
import type { IssueWorkflowStore } from "./issue-workflow-store.ts";
import type { RunReportStore } from "./run-report-store.ts";
import { isoNow, type DatabaseConnection } from "./shared.ts";

interface IssueWorkflowCoordinatorDependencies {
  connection: DatabaseConnection;
  authoritativeLedger: AuthoritativeLedgerStore;
  issueProjections: IssueProjectionStore;
  issueWorkflows: IssueWorkflowStore;
  runReports: RunReportStore;
}

export class IssueWorkflowCoordinator {
  private readonly connection: DatabaseConnection;
  private readonly authoritativeLedger: AuthoritativeLedgerStore;
  private readonly issueProjections: IssueProjectionStore;
  private readonly issueWorkflows: IssueWorkflowStore;
  private readonly runReports: RunReportStore;

  constructor(dependencies: IssueWorkflowCoordinatorDependencies) {
    this.connection = dependencies.connection;
    this.authoritativeLedger = dependencies.authoritativeLedger;
    this.issueProjections = dependencies.issueProjections;
    this.issueWorkflows = dependencies.issueWorkflows;
    this.runReports = dependencies.runReports;
  }

  upsertTrackedIssue(params: {
    projectId: string;
    linearIssueId: string;
    selectedWorkflowId?: string | null;
    issueKey?: string;
    title?: string;
    issueUrl?: string;
    currentLinearState?: string;
    desiredStage?: WorkflowStage | null;
    desiredWebhookId?: string | null;
    desiredReceiptId?: number | null;
    activeWorkspaceId?: number | null;
    activePipelineRunId?: number | null;
    activeStageRunId?: number | null;
    latestThreadId?: string | null;
    statusCommentId?: string | null;
    activeAgentSessionId?: string | null;
    lifecycleStatus: IssueLifecycleStatus;
    lastWebhookAt?: string;
  }): TrackedIssueRecord {
    this.issueProjections.upsertIssueProjection({
      projectId: params.projectId,
      linearIssueId: params.linearIssueId,
      ...(params.issueKey ? { issueKey: params.issueKey } : {}),
      ...(params.title ? { title: params.title } : {}),
      ...(params.issueUrl ? { issueUrl: params.issueUrl } : {}),
      ...(params.currentLinearState ? { currentLinearState: params.currentLinearState } : {}),
      ...(params.lastWebhookAt ? { lastWebhookAt: params.lastWebhookAt } : {}),
    });

    const desiredReceiptId = this.resolveDesiredReceiptId({
      projectId: params.projectId,
      linearIssueId: params.linearIssueId,
      ...(params.desiredWebhookId !== undefined ? { desiredWebhookId: params.desiredWebhookId } : {}),
      ...(params.desiredReceiptId !== undefined ? { desiredReceiptId: params.desiredReceiptId } : {}),
    });
    this.authoritativeLedger.upsertIssueControl({
      projectId: params.projectId,
      linearIssueId: params.linearIssueId,
      ...(params.selectedWorkflowId !== undefined ? { selectedWorkflowId: params.selectedWorkflowId } : {}),
      ...(params.desiredStage !== undefined ? { desiredStage: params.desiredStage } : {}),
      ...(desiredReceiptId !== undefined ? { desiredReceiptId } : {}),
      ...(params.activeWorkspaceId !== undefined ? { activeWorkspaceOwnershipId: params.activeWorkspaceId } : {}),
      ...(params.activeStageRunId !== undefined ? { activeRunLeaseId: params.activeStageRunId } : {}),
      ...(params.statusCommentId !== undefined ? { serviceOwnedCommentId: params.statusCommentId } : {}),
      ...(params.activeAgentSessionId !== undefined ? { activeAgentSessionId: params.activeAgentSessionId } : {}),
      lifecycleStatus: params.lifecycleStatus,
    });

    return this.issueWorkflows.getTrackedIssue(params.projectId, params.linearIssueId)!;
  }

  recordDesiredStage(params: {
    projectId: string;
    linearIssueId: string;
    selectedWorkflowId?: string | null;
    issueKey?: string;
    title?: string;
    issueUrl?: string;
    currentLinearState?: string;
    desiredStage?: WorkflowStage;
    desiredWebhookId?: string;
    desiredReceiptId?: number;
    activeAgentSessionId?: string | null;
    lastWebhookAt: string;
  }): TrackedIssueRecord {
    const existing = this.issueWorkflows.getTrackedIssue(params.projectId, params.linearIssueId);
    this.issueProjections.upsertIssueProjection({
      projectId: params.projectId,
      linearIssueId: params.linearIssueId,
      ...(params.issueKey ? { issueKey: params.issueKey } : existing?.issueKey ? { issueKey: existing.issueKey } : {}),
      ...(params.title ? { title: params.title } : existing?.title ? { title: existing.title } : {}),
      ...(params.issueUrl ? { issueUrl: params.issueUrl } : existing?.issueUrl ? { issueUrl: existing.issueUrl } : {}),
      ...(params.currentLinearState
        ? { currentLinearState: params.currentLinearState }
        : existing?.currentLinearState
          ? { currentLinearState: existing.currentLinearState }
          : {}),
      lastWebhookAt: params.lastWebhookAt,
    });

    const existingIssueControl = this.authoritativeLedger.getIssueControl(params.projectId, params.linearIssueId);
    const lifecycleStatus =
      existingIssueControl?.activeRunLeaseId || params.desiredStage
        ? existing?.lifecycleStatus ?? "queued"
        : existing?.lifecycleStatus ?? "idle";
    const desiredReceiptId = this.resolveDesiredReceiptId({
      projectId: params.projectId,
      linearIssueId: params.linearIssueId,
      ...(params.desiredWebhookId !== undefined ? { desiredWebhookId: params.desiredWebhookId } : {}),
      ...(params.desiredReceiptId !== undefined ? { desiredReceiptId: params.desiredReceiptId } : {}),
    });
    this.authoritativeLedger.upsertIssueControl({
      projectId: params.projectId,
      linearIssueId: params.linearIssueId,
      ...(params.selectedWorkflowId !== undefined
        ? { selectedWorkflowId: params.selectedWorkflowId }
        : existing?.selectedWorkflowId
          ? { selectedWorkflowId: existing.selectedWorkflowId }
          : {}),
      ...(params.desiredStage !== undefined ? { desiredStage: params.desiredStage } : {}),
      ...(desiredReceiptId !== undefined ? { desiredReceiptId } : {}),
      lifecycleStatus,
      ...(existing?.statusCommentId ? { serviceOwnedCommentId: existing.statusCommentId } : {}),
      ...(params.activeAgentSessionId !== undefined
        ? { activeAgentSessionId: params.activeAgentSessionId }
        : existing?.activeAgentSessionId
          ? { activeAgentSessionId: existing.activeAgentSessionId }
          : {}),
      ...(existing?.activeWorkspaceId !== undefined ? { activeWorkspaceOwnershipId: existing.activeWorkspaceId } : {}),
      ...(existingIssueControl?.activeRunLeaseId !== undefined ? { activeRunLeaseId: existingIssueControl.activeRunLeaseId } : {}),
    });

    return this.issueWorkflows.getTrackedIssue(params.projectId, params.linearIssueId)!;
  }

  claimStageRun(params: {
    projectId: string;
    linearIssueId: string;
    stage: WorkflowStage;
    triggerWebhookId: string;
    branchName: string;
    worktreePath: string;
    workflowFile: string;
    promptText: string;
  }): { issue: TrackedIssueRecord; workspace: WorkspaceRecord; pipeline: PipelineRunRecord; stageRun: StageRunRecord } | undefined {
    const transaction = this.connection.transaction(() => {
      const issue = this.issueWorkflows.getTrackedIssue(params.projectId, params.linearIssueId);
      const issueControl = this.authoritativeLedger.getIssueControl(params.projectId, params.linearIssueId);
      if (
        !issue ||
        !issueControl ||
        issueControl.activeRunLeaseId !== undefined ||
        issue.desiredStage !== params.stage ||
        issue.desiredWebhookId !== params.triggerWebhookId
      ) {
        return undefined;
      }

      const workspaceOwnership = this.authoritativeLedger.upsertWorkspaceOwnership({
        projectId: params.projectId,
        linearIssueId: params.linearIssueId,
        branchName: params.branchName,
        worktreePath: params.worktreePath,
        status: "active",
      });

      const runLease = this.authoritativeLedger.createRunLease({
        issueControlId: issueControl.id,
        projectId: params.projectId,
        linearIssueId: params.linearIssueId,
        workspaceOwnershipId: workspaceOwnership.id,
        stage: params.stage,
        status: "running",
        workflowFile: params.workflowFile,
        promptText: params.promptText,
        triggerReceiptId: issueControl.desiredReceiptId ?? null,
      });

      this.authoritativeLedger.upsertWorkspaceOwnership({
        projectId: params.projectId,
        linearIssueId: params.linearIssueId,
        branchName: params.branchName,
        worktreePath: params.worktreePath,
        status: "active",
        currentRunLeaseId: runLease.id,
      });
      this.authoritativeLedger.upsertIssueControl({
        projectId: params.projectId,
        linearIssueId: params.linearIssueId,
        ...(issue.selectedWorkflowId ? { selectedWorkflowId: issue.selectedWorkflowId } : {}),
        desiredStage: null,
        desiredReceiptId: null,
        activeWorkspaceOwnershipId: workspaceOwnership.id,
        activeRunLeaseId: runLease.id,
        lifecycleStatus: "running",
        ...(issue.statusCommentId ? { serviceOwnedCommentId: issue.statusCommentId } : {}),
        ...(issue.activeAgentSessionId ? { activeAgentSessionId: issue.activeAgentSessionId } : {}),
      });

      const refreshedIssue = this.issueWorkflows.getTrackedIssue(params.projectId, params.linearIssueId)!;
      const workspace = this.issueWorkflows.getWorkspace(workspaceOwnership.id)!;
      const stageRun = this.issueWorkflows.getStageRun(runLease.id)!;
      const pipeline = this.issueWorkflows.getPipelineRun(runLease.id)!;
      return { issue: refreshedIssue, workspace, pipeline, stageRun };
    });

    return transaction();
  }

  updateStageRunThread(params: { stageRunId: number; threadId: string; parentThreadId?: string; turnId?: string }): void {
    this.authoritativeLedger.updateRunLeaseThread({
      runLeaseId: params.stageRunId,
      threadId: params.threadId,
      ...(params.parentThreadId !== undefined ? { parentThreadId: params.parentThreadId } : {}),
      ...(params.turnId !== undefined ? { turnId: params.turnId } : {}),
    });

    const stageRun = this.issueWorkflows.getStageRun(params.stageRunId);
    if (!stageRun) {
      return;
    }

    const issue = this.issueWorkflows.getTrackedIssue(stageRun.projectId, stageRun.linearIssueId);
    this.authoritativeLedger.upsertIssueSession({
      projectId: stageRun.projectId,
      linearIssueId: stageRun.linearIssueId,
      workspaceOwnershipId: stageRun.workspaceId,
      runLeaseId: stageRun.id,
      threadId: params.threadId,
      ...(params.parentThreadId !== undefined ? { parentThreadId: params.parentThreadId } : {}),
      ...(issue?.activeAgentSessionId ? { linkedAgentSessionId: issue.activeAgentSessionId } : {}),
      source: "stage_run",
    });
  }

  finishStageRun(params: {
    stageRunId: number;
    status: StageRunRecord["status"];
    threadId: string;
    turnId?: string;
    summaryJson?: string;
    reportJson?: string;
  }): void {
    const stageRun = this.issueWorkflows.getStageRun(params.stageRunId);
    if (!stageRun) {
      return;
    }

    this.runReports.saveRunReport({
      runLeaseId: params.stageRunId,
      ...(params.summaryJson !== undefined ? { summaryJson: params.summaryJson } : {}),
      ...(params.reportJson !== undefined ? { reportJson: params.reportJson } : {}),
    });

    this.authoritativeLedger.finishRunLease({
      runLeaseId: params.stageRunId,
      status: params.status === "failed" ? "failed" : "completed",
      threadId: params.threadId,
      ...(params.turnId !== undefined ? { turnId: params.turnId } : {}),
    });

    const runLease = this.authoritativeLedger.getRunLease(params.stageRunId);
    if (runLease?.workspaceOwnershipId !== undefined) {
      const issue = this.issueWorkflows.getTrackedIssue(stageRun.projectId, stageRun.linearIssueId);
      this.authoritativeLedger.upsertIssueSession({
        projectId: stageRun.projectId,
        linearIssueId: stageRun.linearIssueId,
        workspaceOwnershipId: runLease.workspaceOwnershipId,
        runLeaseId: params.stageRunId,
        threadId: params.threadId,
        ...(runLease.parentThreadId ? { parentThreadId: runLease.parentThreadId } : {}),
        ...(issue?.activeAgentSessionId ? { linkedAgentSessionId: issue.activeAgentSessionId } : {}),
        source: "stage_run",
      });
    }

    const workspace = this.authoritativeLedger.getWorkspaceOwnership(stageRun.workspaceId);
    if (workspace) {
      this.authoritativeLedger.upsertWorkspaceOwnership({
        projectId: stageRun.projectId,
        linearIssueId: stageRun.linearIssueId,
        branchName: workspace.branchName,
        worktreePath: workspace.worktreePath,
        status: params.status === "completed" ? "active" : "paused",
        currentRunLeaseId: null,
      });
    }
  }

  setIssueDesiredStage(
    projectId: string,
    linearIssueId: string,
    desiredStage?: WorkflowStage,
    options?: { desiredWebhookId?: string; desiredReceiptId?: number; lifecycleStatus?: IssueLifecycleStatus },
  ): void {
    const existing = this.issueWorkflows.getTrackedIssue(projectId, linearIssueId);
    const existingIssueControl = this.authoritativeLedger.getIssueControl(projectId, linearIssueId);
    const desiredReceiptId = this.resolveDesiredReceiptId({
      projectId,
      linearIssueId,
      ...(options?.desiredWebhookId !== undefined ? { desiredWebhookId: options.desiredWebhookId } : {}),
      ...(options?.desiredReceiptId !== undefined ? { desiredReceiptId: options.desiredReceiptId } : {}),
    });
    this.authoritativeLedger.upsertIssueControl({
      projectId,
      linearIssueId,
      ...(existing?.selectedWorkflowId ? { selectedWorkflowId: existing.selectedWorkflowId } : {}),
      ...(desiredStage !== undefined ? { desiredStage } : { desiredStage: null }),
      ...(desiredReceiptId !== undefined
        ? { desiredReceiptId }
        : desiredStage === undefined
          ? { desiredReceiptId: null }
          : {}),
      lifecycleStatus:
        options?.lifecycleStatus ??
        (desiredStage ? "queued" : existingIssueControl?.activeRunLeaseId ? (existing?.lifecycleStatus ?? "idle") : "idle"),
      ...(existing?.statusCommentId ? { serviceOwnedCommentId: existing.statusCommentId } : {}),
      ...(existing?.activeAgentSessionId ? { activeAgentSessionId: existing.activeAgentSessionId } : {}),
      ...(existing?.activeWorkspaceId !== undefined ? { activeWorkspaceOwnershipId: existing.activeWorkspaceId } : {}),
      ...(existingIssueControl?.activeRunLeaseId !== undefined ? { activeRunLeaseId: existingIssueControl.activeRunLeaseId } : {}),
    });
  }

  setIssueLifecycleStatus(projectId: string, linearIssueId: string, lifecycleStatus: IssueLifecycleStatus): void {
    const existing = this.issueWorkflows.getTrackedIssue(projectId, linearIssueId);
    const existingIssueControl = this.authoritativeLedger.getIssueControl(projectId, linearIssueId);
    this.authoritativeLedger.upsertIssueControl({
      projectId,
      linearIssueId,
      ...(existing?.selectedWorkflowId ? { selectedWorkflowId: existing.selectedWorkflowId } : {}),
      lifecycleStatus,
      ...(existing?.desiredStage ? { desiredStage: existing.desiredStage } : {}),
      ...(existingIssueControl?.desiredReceiptId !== undefined ? { desiredReceiptId: existingIssueControl.desiredReceiptId } : {}),
      ...(existing?.activeWorkspaceId !== undefined ? { activeWorkspaceOwnershipId: existing.activeWorkspaceId } : {}),
      ...(existingIssueControl?.activeRunLeaseId !== undefined ? { activeRunLeaseId: existingIssueControl.activeRunLeaseId } : {}),
      ...(existing?.statusCommentId ? { serviceOwnedCommentId: existing.statusCommentId } : {}),
      ...(existing?.activeAgentSessionId ? { activeAgentSessionId: existing.activeAgentSessionId } : {}),
    });
  }

  setIssueStatusComment(projectId: string, linearIssueId: string, statusCommentId?: string): void {
    const existing = this.issueWorkflows.getTrackedIssue(projectId, linearIssueId);
    const existingIssueControl = this.authoritativeLedger.getIssueControl(projectId, linearIssueId);
    this.authoritativeLedger.upsertIssueControl({
      projectId,
      linearIssueId,
      ...(existing?.selectedWorkflowId ? { selectedWorkflowId: existing.selectedWorkflowId } : {}),
      lifecycleStatus: existing?.lifecycleStatus ?? "idle",
      ...(existing?.desiredStage ? { desiredStage: existing.desiredStage } : {}),
      ...(existingIssueControl?.desiredReceiptId !== undefined ? { desiredReceiptId: existingIssueControl.desiredReceiptId } : {}),
      ...(existing?.activeWorkspaceId !== undefined ? { activeWorkspaceOwnershipId: existing.activeWorkspaceId } : {}),
      ...(existingIssueControl?.activeRunLeaseId !== undefined ? { activeRunLeaseId: existingIssueControl.activeRunLeaseId } : {}),
      serviceOwnedCommentId: statusCommentId ?? null,
      ...(existing?.activeAgentSessionId ? { activeAgentSessionId: existing.activeAgentSessionId } : {}),
    });
  }

  setIssueActiveAgentSession(projectId: string, linearIssueId: string, agentSessionId?: string): void {
    const existing = this.issueWorkflows.getTrackedIssue(projectId, linearIssueId);
    const existingIssueControl = this.authoritativeLedger.getIssueControl(projectId, linearIssueId);
    this.authoritativeLedger.upsertIssueControl({
      projectId,
      linearIssueId,
      ...(existing?.selectedWorkflowId ? { selectedWorkflowId: existing.selectedWorkflowId } : {}),
      lifecycleStatus: existing?.lifecycleStatus ?? "idle",
      ...(existing?.desiredStage ? { desiredStage: existing.desiredStage } : {}),
      ...(existingIssueControl?.desiredReceiptId !== undefined ? { desiredReceiptId: existingIssueControl.desiredReceiptId } : {}),
      ...(existing?.activeWorkspaceId !== undefined ? { activeWorkspaceOwnershipId: existing.activeWorkspaceId } : {}),
      ...(existingIssueControl?.activeRunLeaseId !== undefined ? { activeRunLeaseId: existingIssueControl.activeRunLeaseId } : {}),
      ...(existing?.statusCommentId ? { serviceOwnedCommentId: existing.statusCommentId } : {}),
      activeAgentSessionId: agentSessionId ?? null,
    });
  }

  private resolveDesiredReceiptId(params: {
    projectId: string;
    linearIssueId: string;
    desiredWebhookId?: string | null;
    desiredReceiptId?: number | null;
  }): number | null | undefined {
    if (params.desiredReceiptId !== undefined) {
      return params.desiredReceiptId;
    }
    if (params.desiredWebhookId === undefined) {
      return undefined;
    }
    if (params.desiredWebhookId === null) {
      return null;
    }
    return this.ensureDesiredReceipt(params.projectId, params.linearIssueId, params.desiredWebhookId);
  }

  private ensureDesiredReceipt(projectId: string, linearIssueId: string, webhookId: string): number {
    const existing = this.connection
      .prepare("SELECT id FROM event_receipts WHERE external_id = ? ORDER BY id DESC LIMIT 1")
      .get(webhookId) as { id: number } | undefined;
    if (existing) {
      return Number(existing.id);
    }

    const receipt = this.authoritativeLedger.insertEventReceipt({
      source: "patchrelay-desired-stage",
      externalId: webhookId,
      eventType: "desired_stage",
      receivedAt: isoNow(),
      acceptanceStatus: "accepted",
      projectId,
      linearIssueId,
    });
    this.authoritativeLedger.markEventReceiptProcessed(receipt.id, "processed");
    return receipt.id;
  }
}
