import type {
  LinearInstallationRecord,
  OAuthStateRecord,
  PipelineRunRecord,
  ProjectInstallationRecord,
  QueuedTurnInputRecord,
  StageRunRecord,
  ThreadEventRecord,
  TrackedIssueRecord,
  WebhookEventRecord,
  WorkspaceRecord,
  WorkflowStage,
} from "./types.ts";

export interface WebhookEventStore {
  insertWebhookEvent(params: {
    webhookId: string;
    receivedAt: string;
    eventType: string;
    issueId?: string;
    projectId?: string;
    headersJson: string;
    payloadJson: string;
    signatureValid: boolean;
    dedupeStatus: WebhookEventRecord["dedupeStatus"];
  }): { id: number; inserted: boolean };
  markWebhookProcessed(id: number, status: WebhookEventRecord["processingStatus"]): void;
  assignWebhookProject(id: number, projectId: string): void;
  getWebhookEvent(id: number): WebhookEventRecord | undefined;
}

export interface WebhookEventStoreProvider {
  webhookEvents: WebhookEventStore;
}

export interface LinearInstallationStore {
  upsertLinearInstallation(params: {
    workspaceId?: string;
    workspaceName?: string;
    workspaceKey?: string;
    actorId?: string;
    actorName?: string;
    accessTokenCiphertext: string;
    refreshTokenCiphertext?: string | null;
    scopesJson: string;
    tokenType?: string;
    expiresAt?: string | null;
  }): LinearInstallationRecord;
  getLinearInstallationForProject(projectId: string): LinearInstallationRecord | undefined;
  listLinearInstallations(): LinearInstallationRecord[];
  listProjectInstallations(): ProjectInstallationRecord[];
  getProjectInstallation(projectId: string): ProjectInstallationRecord | undefined;
  getLinearInstallation(id: number): LinearInstallationRecord | undefined;
  linkProjectInstallation(projectId: string, installationId: number): ProjectInstallationRecord;
  createOAuthState(params: {
    provider: "linear";
    state: string;
    projectId?: string;
    redirectUri: string;
    actor: "user" | "app";
  }): OAuthStateRecord;
  getOAuthState(state: string): OAuthStateRecord | undefined;
  finalizeOAuthState(params: {
    state: string;
    status: "completed" | "failed";
    installationId?: number;
    errorMessage?: string;
  }): OAuthStateRecord | undefined;
}

export interface LinearInstallationStoreProvider {
  linearInstallations: LinearInstallationStore;
}

export interface StageTurnInputStore {
  listPendingTurnInputs(stageRunId: number): QueuedTurnInputRecord[];
  setPendingTurnInputRouting(id: number, threadId: string, turnId: string): void;
  markTurnInputDelivered(id: number): void;
}

export interface StageTurnInputStoreProvider {
  stageEvents: StageTurnInputStore;
}

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
  getTrackedIssue(projectId: string, linearIssueId: string): TrackedIssueRecord | undefined;
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

export interface StageEventQueryStore extends StageTurnInputStore {
  listThreadEvents(stageRunId: number): ThreadEventRecord[];
  saveThreadEvent(params: { stageRunId: number; threadId: string; turnId?: string; method: string; eventJson: string }): number;
  enqueueTurnInput(params: { stageRunId: number; threadId?: string; turnId?: string; source: string; body: string }): number;
}

export interface StageEventQueryStoreProvider {
  stageEvents: StageEventQueryStore;
}

export interface ReadyIssueSource {
  listIssuesReadyForExecution(): Array<{ projectId: string; linearIssueId: string }>;
}

export interface ActiveStageRunReconciler {
  reconcileActiveStageRuns(): Promise<void>;
}

export interface ReadyIssueSourceProvider {
  issueWorkflows: ReadyIssueSource;
}
