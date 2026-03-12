import type { IssueLifecycleStatus, PipelineStatus, StageRunStatus, WorkflowStage, WorkspaceStatus } from "./workflow-types.ts";

export type EventReceiptAcceptanceStatus = "accepted" | "duplicate" | "rejected";
export type EventReceiptProcessingStatus = "pending" | "processed" | "failed";
export type RunLeaseStatus = "queued" | "running" | "paused" | "completed" | "failed" | "released";
export type ObligationStatus = "pending" | "in_progress" | "completed" | "failed" | "cancelled";

export interface EventReceiptRecord {
  id: number;
  source: string;
  externalId: string;
  eventType: string;
  receivedAt: string;
  acceptanceStatus: EventReceiptAcceptanceStatus;
  processingStatus: EventReceiptProcessingStatus;
  projectId?: string;
  linearIssueId?: string;
  headersJson?: string;
  payloadJson?: string;
}

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

export interface IssueControlRecord {
  id: number;
  projectId: string;
  linearIssueId: string;
  desiredStage?: WorkflowStage;
  desiredReceiptId?: number;
  activeRunLeaseId?: number;
  activeWorkspaceOwnershipId?: number;
  serviceOwnedCommentId?: string;
  activeAgentSessionId?: string;
  lifecycleStatus: IssueLifecycleStatus;
  updatedAt: string;
}

export interface IssueProjectionRecord {
  id: number;
  projectId: string;
  linearIssueId: string;
  issueKey?: string;
  title?: string;
  issueUrl?: string;
  currentLinearState?: string;
  lastWebhookAt?: string;
  updatedAt: string;
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
  lifecycleStatus: IssueLifecycleStatus;
  lastWebhookAt?: string;
  updatedAt: string;
}

export interface WorkspaceOwnershipRecord {
  id: number;
  projectId: string;
  linearIssueId: string;
  branchName: string;
  worktreePath: string;
  status: "active" | "paused" | "released";
  currentRunLeaseId?: number;
  createdAt: string;
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

export interface RunLeaseRecord {
  id: number;
  issueControlId: number;
  projectId: string;
  linearIssueId: string;
  workspaceOwnershipId: number;
  stage: WorkflowStage;
  status: RunLeaseStatus;
  triggerReceiptId?: number;
  workflowFile: string;
  promptText: string;
  threadId?: string;
  parentThreadId?: string;
  turnId?: string;
  startedAt: string;
  endedAt?: string;
  failureReason?: string;
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

export interface ObligationRecord {
  id: number;
  projectId: string;
  linearIssueId: string;
  kind: string;
  status: ObligationStatus;
  source: string;
  payloadJson: string;
  runLeaseId?: number;
  threadId?: string;
  turnId?: string;
  dedupeKey?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface RunReportRecord {
  runLeaseId: number;
  summaryJson?: string;
  reportJson?: string;
  createdAt: string;
  updatedAt: string;
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
