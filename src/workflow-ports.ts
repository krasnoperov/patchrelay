import type { PipelineRunRecord, StageRunRecord, TrackedIssueRecord, WorkspaceRecord, WorkflowStage } from "./types.ts";

export interface IssueOverviewRecord {
  issue: TrackedIssueRecord;
  workspace?: WorkspaceRecord;
  pipeline?: PipelineRunRecord;
  activeStageRun?: StageRunRecord;
}

export interface IssueWorkflowLifecycleStore {
  upsertTrackedIssue(params: {
    projectId: string;
    linearIssueId: string;
    currentLinearState?: string;
    statusCommentId?: string | null;
    lifecycleStatus: TrackedIssueRecord["lifecycleStatus"];
  }): TrackedIssueRecord;
  getTrackedIssue(projectId: string, linearIssueId: string): TrackedIssueRecord | undefined;
  getStageRun(stageRunId: number): StageRunRecord | undefined;
  getWorkspace(workspaceId: number): WorkspaceRecord | undefined;
  setIssueStatusComment(projectId: string, linearIssueId: string, commentId?: string): void;
  getPipelineRun(pipelineRunId: number): PipelineRunRecord | undefined;
  setIssueLifecycleStatus(projectId: string, linearIssueId: string, status: TrackedIssueRecord["lifecycleStatus"]): void;
  setPipelineStatus(pipelineRunId: number, status: PipelineRunRecord["status"]): void;
  markPipelineCompleted(pipelineRunId: number): void;
}

export interface IssueWorkflowLifecycleStoreProvider {
  issueWorkflows: IssueWorkflowLifecycleStore;
}

export interface IssueWorkflowExecutionStore extends IssueWorkflowLifecycleStore {
  listIssuesReadyForExecution(): Array<{ projectId: string; linearIssueId: string }>;
  listActiveStageRuns(): StageRunRecord[];
  getStageRunByThreadId(threadId: string): StageRunRecord | undefined;
  listStageRunsForIssue(projectId: string, linearIssueId: string): StageRunRecord[];
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
  consumeIssuePendingLaunchInput(projectId: string, linearIssueId: string): string | undefined;
  finishStageRun(params: {
    stageRunId: number;
    status: StageRunRecord["status"];
    threadId: string;
    turnId?: string;
    summaryJson?: string;
    reportJson?: string;
  }): void;
}

export interface IssueWorkflowExecutionStoreProvider {
  issueWorkflows: IssueWorkflowExecutionStore;
}

export interface IssueWorkflowWebhookStore {
  getTrackedIssue(projectId: string, linearIssueId: string): TrackedIssueRecord | undefined;
  getStageRun(stageRunId: number): StageRunRecord | undefined;
  recordDesiredStage(params: {
    projectId: string;
    linearIssueId: string;
    issueKey?: string;
    title?: string;
    issueUrl?: string;
    currentLinearState?: string;
    desiredStage?: WorkflowStage;
    desiredWebhookId?: string;
    lastWebhookAt: string;
  }): TrackedIssueRecord;
  setIssueActiveAgentSession(projectId: string, linearIssueId: string, agentSessionId?: string): void;
  setIssuePendingLaunchInput(projectId: string, linearIssueId: string, body?: string): void;
}

export interface IssueWorkflowWebhookStoreProvider {
  issueWorkflows: IssueWorkflowWebhookStore;
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
