import type { PipelineRunRecord, StageRunRecord, TrackedIssueRecord, WorkspaceRecord, WorkflowStage } from "./types.ts";

export interface IssueOverviewRecord {
  issue: TrackedIssueRecord;
  workspace?: WorkspaceRecord;
  pipeline?: PipelineRunRecord;
  activeStageRun?: StageRunRecord;
}

export interface IssueWorkflowCoordinator {
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
    lifecycleStatus: TrackedIssueRecord["lifecycleStatus"];
    lastWebhookAt?: string;
  }): TrackedIssueRecord;
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
  }): TrackedIssueRecord;
  claimStageRun(params: {
    projectId: string;
    linearIssueId: string;
    stage: WorkflowStage;
    triggerWebhookId: string;
    branchName: string;
    worktreePath: string;
    workflowFile: string;
    promptText: string;
  }): { issue: TrackedIssueRecord; workspace: WorkspaceRecord; pipeline: PipelineRunRecord; stageRun: StageRunRecord } | undefined;
  updateStageRunThread(params: { stageRunId: number; threadId: string; parentThreadId?: string; turnId?: string }): void;
  finishStageRun(params: {
    stageRunId: number;
    status: StageRunRecord["status"];
    threadId: string;
    turnId?: string;
    summaryJson?: string;
    reportJson?: string;
  }): void;
  setIssueDesiredStage(
    projectId: string,
    linearIssueId: string,
    desiredStage?: WorkflowStage,
    options?: { desiredWebhookId?: string; desiredReceiptId?: number; lifecycleStatus?: TrackedIssueRecord["lifecycleStatus"] },
  ): void;
  setIssueLifecycleStatus(projectId: string, linearIssueId: string, status: TrackedIssueRecord["lifecycleStatus"]): void;
  setIssueStatusComment(projectId: string, linearIssueId: string, commentId?: string): void;
  setIssueActiveAgentSession(projectId: string, linearIssueId: string, agentSessionId?: string): void;
}

export interface IssueWorkflowCoordinatorProvider {
  workflowCoordinator: IssueWorkflowCoordinator;
}

export interface IssueWorkflowQueryStore {
  getIssueOverview(issueKey: string): IssueOverviewRecord | undefined;
  getLatestStageRunForIssue(projectId: string, linearIssueId: string): StageRunRecord | undefined;
  getTrackedIssueByKey(issueKey: string): TrackedIssueRecord | undefined;
  getTrackedIssue(projectId: string, linearIssueId: string): TrackedIssueRecord | undefined;
  listStageRunsForIssue(projectId: string, linearIssueId: string): StageRunRecord[];
  getStageRun(stageRunId: number): StageRunRecord | undefined;
  getStageRunByThreadId(threadId: string): StageRunRecord | undefined;
  listActiveStageRuns(): StageRunRecord[];
  getWorkspace(workspaceId: number): WorkspaceRecord | undefined;
  getPipelineRun(pipelineRunId: number): PipelineRunRecord | undefined;
}

export interface IssueWorkflowQueryStoreProvider {
  issueWorkflows: IssueWorkflowQueryStore;
}

// Ready issues are authoritative coordination output: this is the set of issues
// the harness currently believes are eligible to launch.
export interface ReadyIssueSource {
  listIssuesReadyForExecution(): Array<{ projectId: string; linearIssueId: string }>;
}

export interface ReadyIssueSourceProvider {
  issueWorkflows: ReadyIssueSource;
}

export interface ActiveStageRunReconciler {
  reconcileActiveStageRuns(): Promise<void>;
}
