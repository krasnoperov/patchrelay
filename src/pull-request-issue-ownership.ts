import type { RemotePrState } from "./remote-pr-state.ts";
import type { LinearIssueAttachment } from "./linear-types.ts";

export const PATCHRELAY_PR_RELATIONSHIP_KEY = "patchrelayRelationship";
export const PATCHRELAY_DELIVERY_PR_RELATIONSHIP = "delivery_pr";
export const PATCHRELAY_ISSUE_KEY = "patchrelayIssueKey";

export function attachmentDeclaresDelivery(
  attachment: LinearIssueAttachment,
  issueKey: string | undefined,
): boolean {
  const metadata = attachment.metadata;
  if (!metadata || metadata[PATCHRELAY_PR_RELATIONSHIP_KEY] !== PATCHRELAY_DELIVERY_PR_RELATIONSHIP) {
    return false;
  }
  return typeof issueKey === "string"
    && typeof metadata[PATCHRELAY_ISSUE_KEY] === "string"
    && metadata[PATCHRELAY_ISSUE_KEY].toLowerCase() === issueKey.toLowerCase();
}

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
