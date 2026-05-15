import { resolveLinkedPullRequest } from "../linear-linked-pr-reconciliation.ts";
import { readRemotePrState } from "../remote-pr-state.ts";
import { deriveLinkedPrAdoptionOutcome } from "../delegation-linked-pr.ts";
import type { IssueMetadata, IssueRecord, ProjectConfig } from "../types.ts";

export interface LinkedPrAdoptionInput {
  project: ProjectConfig;
  issue: IssueMetadata;
  existingIssue: IssueRecord | undefined;
  delegated: boolean;
  triggerEvent: string;
}

/**
 * On `delegateChanged` for a newly-delegated issue with no recorded PR yet,
 * try to adopt any pull request referenced in Linear attachments. Returns
 * the desired stage / pending-run shape, or `undefined` if no adoption
 * applies (wrong trigger, not delegated, PR already tracked, no candidate).
 */
export async function resolveLinkedPrAdoption(
  input: LinkedPrAdoptionInput,
) {
  if (!input.delegated) return undefined;
  if (input.triggerEvent !== "delegateChanged") return undefined;
  if (input.existingIssue?.prNumber !== undefined) return undefined;

  const resolution = resolveLinkedPullRequest(input.issue.attachments, input.project.github?.repoFullName);
  if (resolution.kind === "none") return undefined;
  if (resolution.kind === "ambiguous") {
    return {
      factoryState: "awaiting_input",
      pendingRunType: null,
      pendingRunContext: undefined,
      issueUpdates: {},
    };
  }

  const remote = await readRemotePrState(resolution.reference.repoFullName, resolution.reference.prNumber);
  if (!remote) {
    return {
      factoryState: "awaiting_input",
      pendingRunType: null,
      pendingRunContext: undefined,
      issueUpdates: {
        prNumber: resolution.reference.prNumber,
        prUrl: resolution.reference.url,
      },
    };
  }

  return deriveLinkedPrAdoptionOutcome(input.project, resolution.reference.prNumber, remote);
}
