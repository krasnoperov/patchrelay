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
    // Plan §2.4 — bus-contract artifact names. Defaults preserve current
    // behavior; overriding lets a project replace the default Lander or
    // Reviewer with an alternative (Mergify, GitHub native merge queue,
    // Copilot Code Review, …) without touching code.

    /** Check run name written by the Lander when a spec branch is ready
     * (default: "merge-steward/spec-ready"). Read by the Reviewer in
     * integration_tree mode (plan §3.5). */
    specReadyCheckName?: string;
    /** Glob pattern that matches the Lander's spec branch refs (default:
     * "mq-spec-*"). Used by the Reviewer to subscribe to spec ref
     * pushes and by operator dashboards to identify integration trees. */
    specBranchPattern?: string;
    /** PR label that opts a PR out of review-quill carry-forward
     * (default: "review:no-cache"). Release / changelog PRs typically
     * want a fresh review even when the patch is unchanged. */
    noCacheLabel?: string;
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
