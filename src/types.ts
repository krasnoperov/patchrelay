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

export type WorkflowStage = "development" | "review" | "deploy" | "cleanup";
export type IssueLifecycleStatus = "idle" | "queued" | "running" | "paused" | "completed" | "failed";
export type WorkspaceStatus = "active" | "paused" | "closing" | "closed";
export type PipelineStatus = "active" | "completed" | "failed" | "paused";
export type StageRunStatus = "running" | "completed" | "failed" | "waiting";

export interface WorkflowStatusConfig {
  development: string;
  review: string;
  deploy: string;
  developmentActive: string;
  reviewActive: string;
  deployActive: string;
  cleanup?: string;
  cleanupActive?: string;
  humanNeeded?: string;
  done?: string;
}

export interface ProjectWorkflowFiles {
  development: string;
  review: string;
  deploy: string;
  cleanup: string;
}

export interface ProjectConfig {
  id: string;
  repoPath: string;
  worktreeRoot: string;
  workflowFiles: ProjectWorkflowFiles;
  workflowStatuses: WorkflowStatusConfig;
  workflowLabels?: {
    working?: string;
    awaitingHandoff?: string;
  };
  issueKeyPrefixes: string[];
  linearTeamIds: string[];
  allowLabels: string[];
  triggerEvents: TriggerEvent[];
  branchPrefix: string;
}

export interface CodexAppServerConfig {
  bin: string;
  args: string[];
  shellBin?: string;
  sourceBashrc?: boolean;
  model?: string;
  modelProvider?: string;
  serviceName?: string;
  baseInstructions?: string;
  developerInstructions?: string;
  approvalPolicy: "never" | "on-request" | "on-failure" | "untrusted";
  sandboxMode: "danger-full-access" | "workspace-write" | "read-only";
  persistExtendedHistory: boolean;
}

export interface AppConfig {
  server: {
    bind: string;
    port: number;
    healthPath: string;
    readinessPath: string;
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
    apiToken?: string;
    graphqlUrl: string;
  };
  operatorApi: {
    enabled: boolean;
    bearerToken?: string;
  };
  runner: {
    gitBin: string;
    codex: CodexAppServerConfig;
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

export interface CommentMetadata {
  id: string;
  body?: string;
  userName?: string;
}

export interface NormalizedEvent {
  webhookId: string;
  entityType: LinearEntityType;
  action: LinearAction;
  triggerEvent: TriggerEvent;
  eventType: string;
  issue: IssueMetadata;
  comment?: CommentMetadata;
  payload: LinearWebhookPayload;
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

export interface StageLaunchPlan {
  branchName: string;
  worktreePath: string;
  workflowFile: string;
  prompt: string;
  stage: WorkflowStage;
}

export interface CodexThreadSummary {
  id: string;
  preview: string;
  cwd: string;
  status: string;
  path?: string | null;
  turns: CodexTurnSummary[];
}

export interface CodexTurnSummary {
  id: string;
  status: string;
  error?: {
    message: string;
  } | null;
  items: CodexThreadItem[];
}

export type CodexThreadItem =
  | { type: "userMessage"; id: string; content: unknown[] }
  | { type: "agentMessage"; id: string; text: string; phase?: string | null }
  | { type: "plan"; id: string; text: string }
  | { type: "reasoning"; id: string; summary: string[]; content: string[] }
  | {
      type: "commandExecution";
      id: string;
      command: string;
      cwd: string;
      status: string;
      aggregatedOutput?: string | null;
      exitCode?: number | null;
      durationMs?: number | null;
    }
  | { type: "fileChange"; id: string; status: string; changes: Array<Record<string, unknown>> }
  | { type: "mcpToolCall"; id: string; server: string; tool: string; status: string; durationMs?: number | null }
  | { type: "dynamicToolCall"; id: string; tool: string; status: string; durationMs?: number | null }
  | { type: string; id: string; [key: string]: unknown };

export interface StageReport {
  issueKey?: string;
  stage: WorkflowStage;
  status: StageRunStatus;
  threadId?: string;
  parentThreadId?: string;
  turnId?: string;
  prompt: string;
  workflowFile: string;
  assistantMessages: string[];
  plans: string[];
  reasoning: string[];
  commands: Array<{
    command: string;
    cwd: string;
    status: string;
    exitCode?: number | null;
    durationMs?: number | null;
  }>;
  fileChanges: Array<Record<string, unknown>>;
  toolCalls: Array<{
    type: string;
    name: string;
    status: string;
    durationMs?: number | null;
  }>;
  eventCounts: Record<string, number>;
}

export interface LinearIssueSnapshot {
  id: string;
  identifier?: string;
  title?: string;
  url?: string;
  stateId?: string;
  stateName?: string;
  teamId?: string;
  teamKey?: string;
  workflowStates: Array<{
    id: string;
    name: string;
    type?: string;
  }>;
  labelIds: string[];
  labels: Array<{
    id: string;
    name: string;
  }>;
  teamLabels: Array<{
    id: string;
    name: string;
  }>;
}

export interface LinearCommentUpsertResult {
  id: string;
  body: string;
}

export interface LinearClient {
  getIssue(issueId: string): Promise<LinearIssueSnapshot>;
  setIssueState(issueId: string, stateName: string): Promise<LinearIssueSnapshot>;
  upsertIssueComment(params: { issueId: string; commentId?: string; body: string }): Promise<LinearCommentUpsertResult>;
  updateIssueLabels(params: { issueId: string; addNames?: string[]; removeNames?: string[] }): Promise<LinearIssueSnapshot>;
}
