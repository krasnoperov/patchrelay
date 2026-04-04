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
  | "agentSignal"
  | "installationPermissionsChanged"
  | "installationRevoked"
  | "appUserNotification";

export interface ProjectConfig {
  id: string;
  repoPath: string;
  worktreeRoot: string;
  issueKeyPrefixes: string[];
  linearTeamIds: string[];
  allowLabels: string[];
  reviewChecks: string[];
  gateChecks: string[];
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
    baseBranch?: string;
    /** GitHub label that requests AI review once CI has settled green (default: "needs-review"). */
    reviewLabel?: string;
    /** GitHub label to add when entering awaiting_queue (default: "queue"). */
    mergeQueueLabel?: string;
    /** Check run name that signals queue eviction (default: "merge-steward/queue"). */
    mergeQueueCheckName?: string;
  };
}
