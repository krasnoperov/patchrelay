export type LinearAction = "create" | "update" | "remove";
export type LinearEntityType = "Issue" | "Comment" | string;

export type TriggerEvent =
  | "issueCreated"
  | "issueUpdated"
  | "issueRemoved"
  | "commentCreated"
  | "commentUpdated"
  | "commentRemoved"
  | "labelChanged"
  | "statusChanged"
  | "assignmentChanged"
  | "delegateChanged";

export type IssueState = "received" | "ignored" | "launching" | "running" | "completed" | "failed";
export type RunStage = "implementation" | "review" | "deploy";
export type RunStatus = "running" | "completed" | "failed";

export type WorkflowKind = "implementation" | "review" | "deploy";

export interface WorkflowStatusConfig {
  implementation: string;
  review: string;
  deploy: string;
  humanNeeded?: string;
}

export interface ProjectWorkflowFiles {
  implementation: string;
  review: string;
  deploy: string;
}

export interface ProjectConfig {
  id: string;
  repoPath: string;
  worktreeRoot: string;
  workflowFiles: ProjectWorkflowFiles;
  workflowStatuses: WorkflowStatusConfig;
  linearTeamIds: string[];
  allowLabels: string[];
  triggerEvents: TriggerEvent[];
  branchPrefix: string;
}

export interface LaunchCommandConfig {
  shell: string;
  args: string[];
}

export interface AppConfig {
  server: {
    bind: string;
    port: number;
    healthPath: string;
  };
  ingress: {
    linearWebhookPath: string;
    maxBodyBytes: number;
    maxTimestampSkewSeconds: number;
  };
  logging: {
    level: "debug" | "info" | "warn" | "error";
    format: "logfmt";
    filePath: string;
    webhookArchiveDir?: string;
  };
  database: {
    path: string;
    wal: boolean;
  };
  linear: {
    webhookSecret: string;
  };
  runner: {
    zmxBin: string;
    zmxSessionPrefix?: string;
    gitBin: string;
    launch: LaunchCommandConfig;
  };
  projects: ProjectConfig[];
}

export interface LinearWebhookPayload {
  action: LinearAction;
  type: LinearEntityType;
  createdAt: string;
  webhookTimestamp: number;
  data: Record<string, unknown>;
  updatedFrom?: Record<string, unknown>;
  url?: string;
}

export interface IssueMetadata {
  id: string;
  identifier?: string;
  title?: string;
  url?: string;
  teamId?: string;
  teamKey?: string;
  stateId?: string;
  stateName?: string;
  stateType?: string;
  labelNames: string[];
}

export interface NormalizedEvent {
  webhookId: string;
  entityType: LinearEntityType;
  action: LinearAction;
  triggerEvent: TriggerEvent;
  eventType: string;
  issue: IssueMetadata;
  payload: LinearWebhookPayload;
}

export interface PersistedIssueRecord {
  id: number;
  projectId: string;
  linearIssueId: string;
  linearIssueKey?: string;
  title?: string;
  issueUrl?: string;
  currentState: IssueState;
  activeStage?: RunStage;
  desiredStage?: RunStage;
  desiredStateName?: string;
  desiredWebhookId?: string;
  desiredWebhookTimestamp?: number;
  branchName?: string;
  worktreePath?: string;
  activeRunId?: number;
  leaseOwner?: string;
  leaseExpiresAt?: string;
  lastHeartbeatAt?: string;
  lastWebhookAt?: string;
  updatedAt: string;
}

export interface WebhookEventRecord {
  id: number;
  webhookId: string;
  receivedAt: string;
  eventType: string;
  issueId?: string;
  projectId?: string;
  headersJson: string;
  payloadJson: string;
  signatureValid: boolean;
  dedupeStatus: "accepted" | "duplicate" | "rejected";
  processingStatus: "pending" | "processed" | "failed";
}

export interface IssueRunRecord {
  id: number;
  projectId: string;
  linearIssueId: string;
  stage: RunStage;
  status: RunStatus;
  startedAt: string;
  finishedAt?: string;
  triggerWebhookId: string;
  sessionId?: number;
  resultJson?: string;
  errorJson?: string;
}

export interface SessionRecord {
  id: number;
  projectId: string;
  linearIssueId: string;
  runId: number;
  stage: RunStage;
  zmxSessionName: string;
  processId?: number;
  branchName: string;
  worktreePath: string;
  startedAt: string;
  endedAt?: string;
  exitCode?: number;
}

export interface LaunchPlan {
  branchName: string;
  worktreePath: string;
  sessionName: string;
  prompt: string;
  workflowKind: WorkflowKind;
  workflowFile: string;
  stage: RunStage;
}
