import type { Logger } from "pino";
import type { IssueRecord } from "./db-types.ts";
import type { OperatorEventFeed } from "./operator-feed.ts";
import type { ProjectConfig } from "./workflow-types.ts";
import { execCommand } from "./utils.ts";

export const DEFAULT_MERGE_QUEUE_LABEL = "queue";
export const DEFAULT_MERGE_QUEUE_CHECK_NAME = "merge-steward/queue";

export interface MergeQueueProtocolConfig {
  repoFullName?: string | undefined;
  baseBranch?: string | undefined;
  admissionLabel: string;
  evictionCheckName: string;
}

export function resolveMergeQueueProtocol(project?: ProjectConfig): MergeQueueProtocolConfig {
  return {
    repoFullName: project?.github?.repoFullName,
    baseBranch: project?.github?.baseBranch,
    admissionLabel: project?.github?.mergeQueueLabel ?? DEFAULT_MERGE_QUEUE_LABEL,
    evictionCheckName: project?.github?.mergeQueueCheckName ?? DEFAULT_MERGE_QUEUE_CHECK_NAME,
  };
}

export async function requestMergeQueueAdmission(params: {
  issue: Pick<IssueRecord, "issueKey" | "projectId" | "prNumber">;
  protocol: MergeQueueProtocolConfig;
  logger: Logger;
  feed?: OperatorEventFeed | undefined;
}): Promise<void> {
  const { issue, protocol, logger, feed } = params;
  if (!protocol.repoFullName || !issue.prNumber) return;

  feed?.publish({
    level: "info",
    kind: "github",
    issueKey: issue.issueKey,
    projectId: issue.projectId,
    stage: "awaiting_queue",
    status: "queue_label_requested",
    summary: `Queue hand-off requested via label "${protocol.admissionLabel}" on PR #${issue.prNumber}`,
  });

  try {
    await execCommand("gh", [
      "pr", "edit", String(issue.prNumber),
      "--repo", protocol.repoFullName,
      "--add-label", protocol.admissionLabel,
    ], { timeoutMs: 15_000 });

    feed?.publish({
      level: "info",
      kind: "github",
      issueKey: issue.issueKey,
      projectId: issue.projectId,
      stage: "awaiting_queue",
      status: "queue_label_applied",
      summary: `Queue label "${protocol.admissionLabel}" applied to PR #${issue.prNumber}`,
    });
  } catch (error) {
    logger.warn({ issueKey: issue.issueKey, err: error }, "Failed to add merge queue label");
    feed?.publish({
      level: "warn",
      kind: "github",
      issueKey: issue.issueKey,
      projectId: issue.projectId,
      stage: "awaiting_queue",
      status: "queue_label_failed",
      summary: `Queue hand-off failed while adding label "${protocol.admissionLabel}" to PR #${issue.prNumber}`,
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}
