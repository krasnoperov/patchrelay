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
  | "delegateChanged"
  | "agentSessionCreated"
  | "agentPrompted"
  | "installationPermissionsChanged"
  | "installationRevoked"
  | "appUserNotification";

export type WorkflowStage = string;
export type IssueLifecycleStatus = "idle" | "queued" | "running" | "paused" | "completed" | "failed";
export type WorkspaceStatus = "active" | "paused" | "closing" | "closed";
export type PipelineStatus = "active" | "completed" | "failed" | "paused";
export type StageRunStatus = "running" | "completed" | "failed" | "waiting";

export interface ProjectWorkflowConfig {
  id: string;
  whenState: string;
  activeState: string;
  workflowFile: string;
  fallbackState?: string;
}

export interface ProjectConfig {
  id: string;
  repoPath: string;
  worktreeRoot: string;
  workflows: ProjectWorkflowConfig[];
  workflowLabels?: {
    working?: string;
    awaitingHandoff?: string;
  };
  issueKeyPrefixes: string[];
  linearTeamIds: string[];
  allowLabels: string[];
  trustedActors?: {
    ids: string[];
    names: string[];
    emails: string[];
    emailDomains: string[];
  };
  triggerEvents: TriggerEvent[];
  branchPrefix: string;
}
