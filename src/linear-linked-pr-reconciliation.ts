import type { LinearIssueAttachment } from "./linear-types.ts";

export interface LinkedPrReference {
  repoFullName: string;
  prNumber: number;
  url: string;
  attachment: LinearIssueAttachment;
}

const GITHUB_PR_URL_PATTERN = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:[/?#].*)?$/i;

export function resolveLinkedPullRequests(
  attachments: LinearIssueAttachment[] | undefined,
  repoFullName: string | undefined,
): LinkedPrReference[] {
  if (!repoFullName || !attachments || attachments.length === 0) return [];
  return dedupeReferences(attachments
    .map((attachment) => parseGitHubPullRequestAttachment(attachment))
    .filter((reference): reference is LinkedPrReference => Boolean(reference))
    .filter((reference) => reference.repoFullName.toLowerCase() === repoFullName.toLowerCase()));
}

function parseGitHubPullRequestAttachment(attachment: LinearIssueAttachment): LinkedPrReference | undefined {
  const { url } = attachment;
  const match = url.trim().match(GITHUB_PR_URL_PATTERN);
  if (!match) return undefined;
  const [, owner, repo, prNumberRaw] = match;
  const prNumber = Number(prNumberRaw);
  if (!Number.isInteger(prNumber) || prNumber <= 0) return undefined;
  return {
    repoFullName: `${owner}/${repo}`,
    prNumber,
    url,
    attachment,
  };
}

function dedupeReferences(references: LinkedPrReference[]): LinkedPrReference[] {
  const seen = new Set<string>();
  const unique: LinkedPrReference[] = [];
  for (const reference of references) {
    const key = `${reference.repoFullName.toLowerCase()}#${reference.prNumber}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(reference);
  }
  return unique;
}
