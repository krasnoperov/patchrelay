import type { PatchRelayDatabase } from "./db.ts";
import type { IssueRecord } from "./db-types.ts";
import type { NormalizedGitHubEvent } from "./github-types.ts";
import type { ProjectConfig } from "./workflow-types.ts";

export type GitHubWebhookIssueResolution = {
  issue: IssueRecord;
  linkedBy: "pr" | "branch" | "issue_key";
};

export function resolveGitHubWebhookIssue(
  db: PatchRelayDatabase,
  project: ProjectConfig,
  event: NormalizedGitHubEvent,
): GitHubWebhookIssueResolution | undefined {
  if (event.prNumber !== undefined) {
    const byPr = db.issues.getIssueByPrNumber(event.prNumber);
    if (byPr && byPr.projectId === project.id) {
      return { issue: byPr, linkedBy: "pr" };
    }
  }

  const byBranch = db.issues.getIssueByBranch(event.branchName);
  if (byBranch && byBranch.projectId === project.id) {
    return { issue: byBranch, linkedBy: "branch" };
  }

  const byIssueKey = resolveGitHubWebhookIssueByKey(db, project, event);
  if (byIssueKey) {
    return { issue: byIssueKey, linkedBy: "issue_key" };
  }

  return undefined;
}

export function resolveGitHubWebhookIssueByKey(
  db: PatchRelayDatabase,
  project: ProjectConfig,
  event: NormalizedGitHubEvent,
): IssueRecord | undefined {
  const candidates = new Set<string>();
  const sources = [event.prTitle, event.prBody, event.branchName];

  for (const prefix of project.issueKeyPrefixes) {
    const normalizedPrefix = prefix.trim();
    if (!normalizedPrefix) continue;
    const pattern = new RegExp(`\\b${escapeRegExp(normalizedPrefix)}-\\d+\\b`, "gi");
    for (const source of sources) {
      if (!source) continue;
      for (const match of source.matchAll(pattern)) {
        candidates.add(match[0].toUpperCase());
      }
    }
  }

  if (candidates.size !== 1) {
    return undefined;
  }

  const [issueKey] = [...candidates];
  if (!issueKey) {
    return undefined;
  }
  const issue = db.issues.getIssueByKey(issueKey);
  return issue?.projectId === project.id ? issue : undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

