import type { ProjectConfig } from "./workflow-types.ts";

export const DEFAULT_MERGE_QUEUE_LABEL = "queue";
export const DEFAULT_MERGE_QUEUE_CHECK_NAME = "merge-steward/queue";
export const DEFAULT_PRIORITY_QUEUE_LABEL = "queue:priority";

export interface MergeQueueProtocolConfig {
  repoFullName?: string | undefined;
  baseBranch?: string | undefined;
  admissionLabel: string;
  evictionCheckName: string;
  priorityLabel: string;
}

export function resolveMergeQueueProtocol(project?: ProjectConfig): MergeQueueProtocolConfig {
  return {
    repoFullName: project?.github?.repoFullName,
    baseBranch: project?.github?.baseBranch,
    admissionLabel: project?.github?.mergeQueueLabel ?? DEFAULT_MERGE_QUEUE_LABEL,
    evictionCheckName: project?.github?.mergeQueueCheckName ?? DEFAULT_MERGE_QUEUE_CHECK_NAME,
    priorityLabel: project?.github?.priorityQueueLabel ?? DEFAULT_PRIORITY_QUEUE_LABEL,
  };
}
