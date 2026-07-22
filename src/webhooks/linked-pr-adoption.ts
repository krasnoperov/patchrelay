import { resolveLinkedPullRequests, type LinkedPrReference } from "../linear-linked-pr-reconciliation.ts";
import { readRemotePrState } from "../remote-pr-state.ts";
import { deriveLinkedPrAdoptionOutcome, type LinkedPrAdoptionOutcome } from "../delegation-linked-pr.ts";
import { attachmentDeclaresDelivery, pullRequestOwnsIssue } from "../pull-request-issue-ownership.ts";
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

  const declaredDelivery = references.filter((reference) =>
    attachmentDeclaresDelivery(reference.attachment, input.issue.identifier)
  );
  if (declaredDelivery.length > 1) {
    return {
      factoryState: "awaiting_input" as const,
      issueUpdates: {},
    };
  }

  if (declaredDelivery.length === 1) {
    return resolveDeclaredDelivery(input, declaredDelivery[0]!);
  }

  const inspected = await Promise.all(references.map(async (reference) => ({
    reference,
    remote: await readRemotePrState(reference.repoFullName, reference.prNumber),
  })));
  const owned = inspected.filter(({ remote }) => remote && pullRequestOwnsIssue(remote, input.issue.identifier));
  if (owned.length > 1) {
    return {
      factoryState: "awaiting_input" as const,
      issueUpdates: {},
    };
  }
  if (owned.length === 0) return undefined;

  const match = owned[0]!;
  return deriveLinkedPrAdoptionOutcome(input.project, match.reference.prNumber, match.remote!);
}

async function resolveDeclaredDelivery(
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
