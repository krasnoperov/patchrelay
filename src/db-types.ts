import type { IssueLifecycleStatus, WorkflowStage } from "./workflow-types.ts";

export type RunStatus = "queued" | "running" | "completed" | "failed" | "released";
export type RunType = "stage" | "ci_repair" | "review_fix" | "queue_repair";

export interface IssueRecord {
  id: number;
  projectId: string;
  linearIssueId: string;
  issueKey?: string;
  title?: string;
  url?: string;
  selectedWorkflowId?: string;
  currentLinearState?: string;
  desiredStage?: WorkflowStage;
  branchName?: string;
  worktreePath?: string;
  threadId?: string;
  activeRunId?: number;
  statusCommentId?: string;
  agentSessionId?: string;
  continuationBarrierAt?: string;
  lifecycleStatus: IssueLifecycleStatus;
  updatedAt: string;
  // PR tracking (Phase 1: factory control plane)
  prNumber?: number;
  prUrl?: string;
  prState?: string;
  prReviewState?: string;
  prCheckStatus?: string;
  ciRepairAttempts: number;
  queueRepairAttempts: number;
  pendingRunType?: RunType | undefined;
  pendingRunContextJson?: string | undefined;
}

export interface RunRecord {
  id: number;
  issueId: number;
  projectId: string;
  linearIssueId: string;
  stage: WorkflowStage;
  status: RunStatus;
  runType: RunType;
  workflowFile?: string;
  promptText?: string;
  threadId?: string;
  turnId?: string;
  parentThreadId?: string;
  summaryJson?: string;
  reportJson?: string;
  failureReason?: string;
  startedAt: string;
  endedAt?: string;
}

export interface WebhookEventRecord {
  id: number;
  webhookId: string;
  receivedAt: string;
}

// Re-export auth types that are kept as-is from linear-types.ts
export type { LinearInstallationRecord, ProjectInstallationRecord, OAuthStateRecord } from "./linear-types.ts";

// Composite types for CLI/query compatibility
export interface TrackedIssueRecord {
  id: number;
  projectId: string;
  linearIssueId: string;
  selectedWorkflowId?: string;
  issueKey?: string;
  title?: string;
  issueUrl?: string;
  currentLinearState?: string;
  desiredStage?: WorkflowStage;
  desiredStageSourceRunId?: number;
  continuationBarrierAt?: string;
  activeWorkspaceId?: number;
  activeStageRunId?: number;
  statusCommentId?: string;
  activeAgentSessionId?: string;
  lifecycleStatus: IssueLifecycleStatus;
  lastWebhookAt?: string;
  updatedAt: string;
}

export interface StageRunRecord {
  id: number;
  pipelineRunId: number;
  projectId: string;
  linearIssueId: string;
  workspaceId: number;
  stage: WorkflowStage;
  status: "running" | "completed" | "failed" | "waiting";
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

export interface WorkspaceRecord {
  id: number;
  projectId: string;
  linearIssueId: string;
  branchName: string;
  worktreePath: string;
  status: "active" | "paused" | "closing" | "closed";
  lastStage?: WorkflowStage;
  lastThreadId?: string;
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
