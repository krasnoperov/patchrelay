import { resolveLinkedPullRequest } from "../linear-linked-pr-reconciliation.ts";
import { readRemotePrState } from "../remote-pr-state.ts";
import { deriveLinkedPrAdoptionOutcome, type LinkedPrAdoptionOutcome } from "../delegation-linked-pr.ts";
import { pullRequestOwnsIssue } from "../pull-request-issue-ownership.ts";
import type { IssueMetadata, IssueRecord, ProjectConfig } from "../types.ts";

export interface LinkedPrAdoptionInput {
  project: ProjectConfig;
  issue: IssueMetadata;
  existingIssue: IssueRecord | undefined;
  delegated: boolean;
  triggerEvent: string;
}

/**
 * For a delegated issue with no recorded PR yet, try to adopt any pull
 * request referenced in Linear attachments. Delegation and status events can
 * arrive in either order, so this cannot be tied to `delegateChanged` only.
 */
export async function resolveLinkedPrAdoption(
  input: LinkedPrAdoptionInput,
): Promise<LinkedPrAdoptionOutcome | undefined> {
  if (!input.delegated) return undefined;
  if (input.existingIssue?.prNumber !== undefined) return undefined;

  const resolution = resolveLinkedPullRequest(input.issue.attachments, input.project.github?.repoFullName);
  if (resolution.kind === "none") return undefined;
  if (resolution.kind === "ambiguous") {
    return {
      factoryState: "awaiting_input" as const,
      issueUpdates: {},
    };
  }

  const remote = await readRemotePrState(resolution.reference.repoFullName, resolution.reference.prNumber);
  if (!remote) {
    return {
      factoryState: "awaiting_input" as const,
      issueUpdates: {
        prNumber: resolution.reference.prNumber,
        prUrl: resolution.reference.url,
      },
    };
  }

  if (!pullRequestOwnsIssue(remote, input.issue.identifier)) {
    return undefined;
  }

  return deriveLinkedPrAdoptionOutcome(input.project, resolution.reference.prNumber, remote);
}
