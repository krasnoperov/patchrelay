import type { IssueRecord } from "./db-types.ts";

export interface CiRepairContext {
  checkName?: string | undefined;
  checkUrl?: string | undefined;
  failureLogs?: string | undefined;
}

export interface ReviewFixContext {
  reviewBody?: string | undefined;
  reviewerName?: string | undefined;
  unresolved_comments?: string[] | undefined;
}

export interface QueueRepairContext {
  failureReason?: string | undefined;
  mergeGroupBranch?: string | undefined;
}

export function buildCiRepairPrompt(issue: IssueRecord, context: CiRepairContext): string {
  const lines: string[] = [
    `Issue: ${issue.issueKey ?? issue.linearIssueId}`,
    issue.title ? `Title: ${issue.title}` : undefined,
    `Branch: ${issue.branchName}`,
    issue.prNumber ? `PR: #${issue.prNumber}` : undefined,
    "",
    "## CI Repair",
    "",
    "A CI check has failed on your PR. Fix the failure and push.",
    "",
    context.checkName ? `Failed check: ${context.checkName}` : undefined,
    context.checkUrl ? `Check URL: ${context.checkUrl}` : undefined,
    "",
    "Steps:",
    "1. Read the CI failure logs to understand what failed",
    "2. Fix the issue in the code",
    "3. Run verification locally: `npm run typecheck && npm run lint && npm test`",
    "4. Commit and push the fix",
    "",
    "Do not change test expectations to make tests pass unless the test is genuinely wrong.",
    "Focus on fixing the actual code issue, not masking the failure.",
    "",
    context.failureLogs ? "## Failure logs\n\n```\n" + context.failureLogs.slice(0, 4000) + "\n```" : undefined,
  ].filter(Boolean) as string[];

  return lines.join("\n");
}

export function buildReviewFixPrompt(issue: IssueRecord, context: ReviewFixContext): string {
  const lines: string[] = [
    `Issue: ${issue.issueKey ?? issue.linearIssueId}`,
    issue.title ? `Title: ${issue.title}` : undefined,
    `Branch: ${issue.branchName}`,
    issue.prNumber ? `PR: #${issue.prNumber}` : undefined,
    "",
    "## Review Changes Requested",
    "",
    "A reviewer has requested changes on your PR. Address the feedback and push.",
    "",
    context.reviewerName ? `Reviewer: ${context.reviewerName}` : undefined,
    "",
    context.reviewBody ? `## Review comment\n\n${context.reviewBody}` : undefined,
    "",
    context.unresolved_comments?.length
      ? "## Unresolved comments\n\n" + context.unresolved_comments.map((c) => `- ${c}`).join("\n")
      : undefined,
    "",
    "Steps:",
    "1. Read the review feedback carefully",
    "2. Address each point in the code",
    "3. Run verification: `npm run typecheck && npm run lint && npm test`",
    "4. Commit and push the fix",
    "",
    "If a review comment is unclear or you disagree, explain your reasoning in a reply comment rather than ignoring it.",
  ].filter(Boolean) as string[];

  return lines.join("\n");
}

export function buildQueueRepairPrompt(issue: IssueRecord, context: QueueRepairContext): string {
  const lines: string[] = [
    `Issue: ${issue.issueKey ?? issue.linearIssueId}`,
    issue.title ? `Title: ${issue.title}` : undefined,
    `Branch: ${issue.branchName}`,
    issue.prNumber ? `PR: #${issue.prNumber}` : undefined,
    "",
    "## Merge Queue Failure",
    "",
    "The merge queue rejected this PR. This usually means a rebase conflict or an integration test failure when combined with other changes on main.",
    "",
    context.failureReason ? `Failure reason: ${context.failureReason}` : undefined,
    "",
    "Steps:",
    "1. Fetch and rebase onto the latest main: `git fetch origin && git rebase origin/main`",
    "2. Resolve any conflicts",
    "3. Run verification: `npm run typecheck && npm run lint && npm test`",
    "4. Push the rebased branch (force push is expected after rebase)",
    "",
    "If the conflict is a semantic contradiction (two features that individually work but break together), escalate to human_needed.",
  ].filter(Boolean) as string[];

  return lines.join("\n");
}
