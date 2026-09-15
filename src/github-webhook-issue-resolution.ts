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
    const byPr = db.issues.getIssueByProjectPrNumber(project.id, event.prNumber);
    if (byPr) {
      return { issue: byPr, linkedBy: "pr" };
    }
  }

  const byBranch = db.issues.getIssueByProjectBranch(project.id, event.branchName);
  if (byBranch) {
    return { issue: byBranch, linkedBy: "branch" };
  }

  // An issue-key mention is discovery evidence, not PR ownership. Only the
  // opening event may establish that association; later review, check, close,
  // and merge events must resolve through the persisted repo-local PR or
  // branch identity. Otherwise a foreign PR that merely references an issue
  // can mutate or complete the referenced issue's workflow.
  if (event.triggerEvent !== "pr_opened") {
    return undefined;
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
  return db.issues.getIssueByProjectKey(project.id, issueKey);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
