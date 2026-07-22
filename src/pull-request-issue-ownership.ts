import type { RemotePrState } from "./remote-pr-state.ts";

/**
 * A Linear attachment is only evidence that a PR is relevant to an issue.
 * Before adopting it as the issue's delivery PR, require the PR itself to
 * carry the issue identifier in durable GitHub metadata.
 */
export function pullRequestOwnsIssue(remote: RemotePrState, issueKey: string | undefined): boolean {
  const normalizedIssueKey = issueKey?.trim();
  if (!normalizedIssueKey) return false;

  return [remote.title, remote.body, remote.headRefName]
    .some((value) => containsIssueKey(value, normalizedIssueKey));
}

function containsIssueKey(value: string | undefined, issueKey: string): boolean {
  if (!value) return false;
  const escaped = issueKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`, "i").test(value);
}
