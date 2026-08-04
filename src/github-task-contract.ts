import type { IssueRecord } from "./db-types.ts";

export const PATCHRELAY_TASK_CONTRACT_START = "<!-- patchrelay-task-contract:v1:start -->";
export const PATCHRELAY_TASK_CONTRACT_END = "<!-- patchrelay-task-contract:v1:end -->";

export function renderGitHubTaskContract(issue: Pick<IssueRecord, "issueKey" | "linearIssueId" | "title" | "description">): string {
  const task = issue.description?.trim() ? issue.description : issue.title || `Complete ${issue.issueKey ?? issue.linearIssueId}.`;
  return [
    PATCHRELAY_TASK_CONTRACT_START,
    `Issue: ${issue.issueKey ?? issue.linearIssueId}`,
    ...(issue.title ? [`Title: ${issue.title}`] : []),
    "",
    task,
    PATCHRELAY_TASK_CONTRACT_END,
  ].join("\n");
}
