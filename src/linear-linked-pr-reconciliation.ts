import type { LinearIssueAttachment } from "./linear-types.ts";

export interface LinkedPrReference {
  repoFullName: string;
  prNumber: number;
  url: string;
}

export type LinkedPrResolution =
  | { kind: "none" }
  | { kind: "matched"; reference: LinkedPrReference }
  | { kind: "ambiguous"; references: LinkedPrReference[] };

const GITHUB_PR_URL_PATTERN = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:[/?#].*)?$/i;

export function resolveLinkedPullRequest(
  attachments: LinearIssueAttachment[] | undefined,
  repoFullName: string | undefined,
): LinkedPrResolution {
  if (!repoFullName || !attachments || attachments.length === 0) {
    return { kind: "none" };
  }

  const matches = attachments
    .map((attachment) => parseGitHubPullRequestUrl(attachment.url))
    .filter((reference): reference is LinkedPrReference => Boolean(reference))
    .filter((reference) => reference.repoFullName.toLowerCase() === repoFullName.toLowerCase());

  const unique = dedupeReferences(matches);
  if (unique.length === 0) {
    return { kind: "none" };
  }
  if (unique.length === 1) {
    return { kind: "matched", reference: unique[0]! };
  }
  return { kind: "ambiguous", references: unique };
}

function parseGitHubPullRequestUrl(url: string): LinkedPrReference | undefined {
  const match = url.trim().match(GITHUB_PR_URL_PATTERN);
  if (!match) return undefined;
  const [, owner, repo, prNumberRaw] = match;
  const prNumber = Number(prNumberRaw);
  if (!Number.isInteger(prNumber) || prNumber <= 0) return undefined;
  return {
    repoFullName: `${owner}/${repo}`,
    prNumber,
    url,
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
