import type { Logger } from "pino";
import type { IssueRecord } from "./db-types.ts";
import type { OperatorEventFeed } from "./operator-feed.ts";
import type { ProjectConfig } from "./workflow-types.ts";
import { execCommand } from "./utils.ts";

export const DEFAULT_REVIEW_LABEL = "needs-review";

export interface ReviewLabelProtocolConfig {
  repoFullName?: string | undefined;
  reviewLabel: string;
}

export function resolveReviewLabelProtocol(project?: ProjectConfig): ReviewLabelProtocolConfig {
  return {
    repoFullName: project?.github?.repoFullName,
    reviewLabel: project?.github?.reviewLabel ?? DEFAULT_REVIEW_LABEL,
  };
}

export async function requestReviewLabel(params: {
  issue: Pick<IssueRecord, "issueKey" | "projectId" | "prNumber">;
  protocol: ReviewLabelProtocolConfig;
  logger: Logger;
  feed?: OperatorEventFeed | undefined;
}): Promise<boolean> {
  const { issue, protocol, logger, feed } = params;
  if (!protocol.repoFullName || !issue.prNumber) return false;

  try {
    const [owner, repo] = protocol.repoFullName.split("/", 2);
    if (!owner || !repo) {
      throw new Error(`Invalid repoFullName: ${protocol.repoFullName}`);
    }
    await execCommand("gh", [
      "api",
      "--method", "POST",
      `repos/${owner}/${repo}/issues/${issue.prNumber}/labels`,
      "-f", `labels[]=${protocol.reviewLabel}`,
    ], { timeoutMs: 15_000 });

    feed?.publish({
      level: "info",
      kind: "github",
      issueKey: issue.issueKey,
      projectId: issue.projectId,
      stage: "pr_open",
      status: "review_label_applied",
      summary: `Review hand-off requested via label "${protocol.reviewLabel}" on PR #${issue.prNumber}`,
    });
    return true;
  } catch (error) {
    logger.warn({ issueKey: issue.issueKey, err: error }, "Failed to add review label");
    feed?.publish({
      level: "warn",
      kind: "github",
      issueKey: issue.issueKey,
      projectId: issue.projectId,
      stage: "pr_open",
      status: "review_label_failed",
      summary: `Review hand-off failed while adding label "${protocol.reviewLabel}" to PR #${issue.prNumber}`,
      detail: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

export async function clearReviewLabel(params: {
  issue: Pick<IssueRecord, "issueKey" | "projectId" | "prNumber">;
  protocol: ReviewLabelProtocolConfig;
  logger: Logger;
  feed?: OperatorEventFeed | undefined;
}): Promise<boolean> {
  const { issue, protocol, logger, feed } = params;
  if (!protocol.repoFullName || !issue.prNumber) return false;

  const [owner, repo] = protocol.repoFullName.split("/", 2);
  if (!owner || !repo) {
    logger.warn({ issueKey: issue.issueKey, repoFullName: protocol.repoFullName }, "Invalid repoFullName while clearing review label");
    return false;
  }

  const { stderr, exitCode } = await execCommand("gh", [
    "api",
    "--method", "DELETE",
    `repos/${owner}/${repo}/issues/${issue.prNumber}/labels/${encodeURIComponent(protocol.reviewLabel)}`,
  ], { timeoutMs: 15_000 });

  if (exitCode === 0) {
    feed?.publish({
      level: "info",
      kind: "github",
      issueKey: issue.issueKey,
      projectId: issue.projectId,
      stage: "pr_open",
      status: "review_label_cleared",
      summary: `Cleared stale review label "${protocol.reviewLabel}" from PR #${issue.prNumber}`,
    });
    return true;
  }

  if (stderr.includes("404")) {
    return false;
  }

  logger.warn({ issueKey: issue.issueKey, exitCode, stderr }, "Failed to clear review label");
  feed?.publish({
    level: "warn",
    kind: "github",
    issueKey: issue.issueKey,
    projectId: issue.projectId,
    stage: "pr_open",
    status: "review_label_clear_failed",
    summary: `Failed to clear review label "${protocol.reviewLabel}" from PR #${issue.prNumber}`,
    detail: stderr.trim() || `gh api exited with code ${exitCode}`,
  });
  return false;
}
