import type { IssueRecord } from "./db-types.ts";
import type { LinearClient } from "./linear-types.ts";
import {
  PATCHRELAY_DELIVERY_PR_RELATIONSHIP,
  PATCHRELAY_ISSUE_KEY,
  PATCHRELAY_PR_RELATIONSHIP_KEY,
} from "./pull-request-issue-ownership.ts";

export async function syncLinearDeliveryPrAttachment(
  issue: Pick<IssueRecord, "linearIssueId" | "issueKey" | "projectId" | "prNumber" | "prUrl" | "prState">,
  linear: LinearClient,
): Promise<void> {
  if (!linear.upsertIssueAttachment || !issue.issueKey || !issue.prUrl || issue.prNumber === undefined) return;

  await linear.upsertIssueAttachment({
    issueId: issue.linearIssueId,
    title: `PatchRelay delivery PR #${issue.prNumber}`,
    ...(issue.prState ? { subtitle: issue.prState } : {}),
    url: issue.prUrl,
    metadata: {
      [PATCHRELAY_PR_RELATIONSHIP_KEY]: PATCHRELAY_DELIVERY_PR_RELATIONSHIP,
      [PATCHRELAY_ISSUE_KEY]: issue.issueKey,
      patchrelayProjectId: issue.projectId,
      githubPrNumber: issue.prNumber,
    },
  });
}
