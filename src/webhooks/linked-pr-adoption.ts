import { resolveLinkedPullRequests, type LinkedPrReference } from "../linear-linked-pr-reconciliation.ts";
import { readRemotePrState } from "../remote-pr-state.ts";
import { deriveLinkedPrAdoptionOutcome, type LinkedPrAdoptionOutcome } from "../delegation-linked-pr.ts";
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

  const references = resolveLinkedPullRequests(input.issue.attachments, input.project.github?.repoFullName);
  if (references.length === 0) return undefined;

  // Operator contract: attaching a same-repository GitHub PR to a delegated
  // Linear issue means "PatchRelay owns this PR". PRs that are merely evidence
  // belong in the issue description or comments, not in attachments.
  if (references.length > 1) {
    return {
      factoryState: "awaiting_input" as const,
      issueUpdates: {},
    };
  }

  return resolveAttachedPr(input, references[0]!);
}

async function resolveAttachedPr(
  input: LinkedPrAdoptionInput,
  reference: LinkedPrReference,
): Promise<LinkedPrAdoptionOutcome> {
  const remote = await readRemotePrState(reference.repoFullName, reference.prNumber);
  if (!remote) {
    return {
      factoryState: "awaiting_input" as const,
      issueUpdates: {
        prNumber: reference.prNumber,
        prUrl: reference.url,
      },
    };
  }
  return deriveLinkedPrAdoptionOutcome(input.project, reference.prNumber, remote);
}
