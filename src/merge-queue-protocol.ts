import type { ProjectConfig } from "./workflow-types.ts";

export const DEFAULT_MERGE_QUEUE_LABEL = "queue";
export const DEFAULT_MERGE_QUEUE_CHECK_NAME = "merge-steward/queue";
export const DEFAULT_PRIORITY_QUEUE_LABEL = "queue:priority";
// Plan §2.4 defaults. Wired here so the resolver is the single source
// of truth for bus-contract values; consumers (review-quill subscribe,
// Linear-status sync, etc.) never read `project.github.*` directly.
export const DEFAULT_SPEC_READY_CHECK_NAME = "merge-steward/spec-ready";
export const DEFAULT_SPEC_BRANCH_PATTERN = "mq-spec-*";
export const DEFAULT_NO_CACHE_LABEL = "review:no-cache";
export const DEFAULT_QUEUED_FOR_DEPLOY_LABEL = "queued-for-deploy";

export interface MergeQueueProtocolConfig {
  repoFullName?: string | undefined;
  baseBranch?: string | undefined;
  admissionLabel: string;
  evictionCheckName: string;
  priorityLabel: string;
  // Plan §2.4 bus-contract resolved values.
  specReadyCheckName: string;
  specBranchPattern: string;
  noCacheLabel: string;
  queuedForDeployLabel: string;
  /** Deploy workflow to watch post-merge; undefined disables tracking. */
  deployWorkflowName?: string | undefined;
}

export function resolveMergeQueueProtocol(project?: ProjectConfig): MergeQueueProtocolConfig {
  return {
    repoFullName: project?.github?.repoFullName,
    baseBranch: project?.github?.baseBranch,
    admissionLabel: project?.github?.mergeQueueLabel ?? DEFAULT_MERGE_QUEUE_LABEL,
    evictionCheckName: project?.github?.mergeQueueCheckName ?? DEFAULT_MERGE_QUEUE_CHECK_NAME,
    priorityLabel: project?.github?.priorityQueueLabel ?? DEFAULT_PRIORITY_QUEUE_LABEL,
    specReadyCheckName: project?.github?.specReadyCheckName ?? DEFAULT_SPEC_READY_CHECK_NAME,
    specBranchPattern: project?.github?.specBranchPattern ?? DEFAULT_SPEC_BRANCH_PATTERN,
    noCacheLabel: project?.github?.noCacheLabel ?? DEFAULT_NO_CACHE_LABEL,
    queuedForDeployLabel: project?.github?.queuedForDeployLabel ?? DEFAULT_QUEUED_FOR_DEPLOY_LABEL,
    deployWorkflowName: project?.github?.deployWorkflowName,
  };
}
