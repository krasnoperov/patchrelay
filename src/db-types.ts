import type { IssueLifecycleStatus, PipelineStatus, StageRunStatus, WorkflowStage, WorkspaceStatus } from "./workflow-types.ts";

export interface WebhookEventRecord {
  id: number;
  webhookId: string;
  receivedAt: string;
  eventType: string;
  issueId?: string;
  projectId?: string;
  installationId?: number;
  headersJson: string;
  payloadJson: string;
  signatureValid: boolean;
  dedupeStatus: "accepted" | "duplicate" | "rejected";
  processingStatus: "pending" | "processed" | "failed";
}

export interface TrackedIssueRecord {
  id: number;
  projectId: string;
  linearIssueId: string;
  issueKey?: string;
  title?: string;
  issueUrl?: string;
  currentLinearState?: string;
  desiredStage?: WorkflowStage;
  desiredWebhookId?: string;
  activeWorkspaceId?: number;
  activePipelineRunId?: number;
  activeStageRunId?: number;
  latestThreadId?: string;
  statusCommentId?: string;
  activeAgentSessionId?: string;
  pendingLaunchInput?: string;
  lifecycleStatus: IssueLifecycleStatus;
  lastWebhookAt?: string;
  updatedAt: string;
}

export interface WorkspaceRecord {
  id: number;
  projectId: string;
  linearIssueId: string;
  branchName: string;
  worktreePath: string;
  status: WorkspaceStatus;
  lastStage?: WorkflowStage;
  lastThreadId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PipelineRunRecord {
  id: number;
  projectId: string;
  linearIssueId: string;
  workspaceId: number;
  status: PipelineStatus;
  currentStage?: WorkflowStage;
  startedAt: string;
  endedAt?: string;
}

export interface StageRunRecord {
  id: number;
  pipelineRunId: number;
  projectId: string;
  linearIssueId: string;
  workspaceId: number;
  stage: WorkflowStage;
  status: StageRunStatus;
  triggerWebhookId: string;
  workflowFile: string;
  promptText: string;
  threadId?: string;
  parentThreadId?: string;
  turnId?: string;
  summaryJson?: string;
  reportJson?: string;
  startedAt: string;
  endedAt?: string;
}

export interface ThreadEventRecord {
  id: number;
  stageRunId: number;
  threadId: string;
  turnId?: string;
  method: string;
  eventJson: string;
  createdAt: string;
}

export interface QueuedTurnInputRecord {
  id: number;
  stageRunId: number;
  threadId?: string;
  turnId?: string;
  source: string;
  body: string;
  deliveredAt?: string;
  createdAt: string;
}
