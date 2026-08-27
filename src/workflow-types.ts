export type { RunType } from "./run-type.ts";

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
  linearProjectIds: string[];
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
  repairBudgets: {
    ciRepair: number;
    queueRepair: number;
    reviewFix: number;
  };
  repoSettingsPath?: string;
  github?: {
    webhookSecret?: string;
    repoFullName?: string;
    baseBranch?: string;
    /** GitHub label to add when entering awaiting_queue (default: "queue"). */
    mergeQueueLabel?: string;
    /** Check run name that signals queue eviction (default: "merge-steward/queue"). */
    mergeQueueCheckName?: string;
    /** GitHub label that puts a PR into the priority queue lane (default: "queue:priority"). */
    priorityQueueLabel?: string;
    /** Linear sub-label applied while a project's workflow lacks an
     * In Deploy state and the issue is queued for landing (default:
     * "queued-for-deploy"). See plan §4.6. */
    queuedForDeployLabel?: string;
    /** Name of the GitHub Actions workflow that deploys `main` after a
     * merge. When set, a merged issue enters the `deploying` factory
     * state and patchrelay watches this workflow's runs on the base
     * branch: success → done, failure → escalate. When UNSET (default),
     * a merge advances straight to done — no post-merge tracking. */
    deployWorkflowName?: string;
  };
}
