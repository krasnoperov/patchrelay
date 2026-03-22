export type { FactoryState, RunType } from "./factory-state.ts";

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

// Legacy aliases — kept temporarily so imports don't all break at once.
// These will be removed once all consumers are updated.
export type WorkflowStage = string;
export type IssueLifecycleStatus = string;
export type StageRunStatus = "running" | "completed" | "failed" | "waiting";

export interface ProjectConfig {
  id: string;
  repoPath: string;
  worktreeRoot: string;
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
  repoSettingsPath?: string;
  github?: {
    webhookSecret?: string;
    repoFullName?: string;
  };
}
