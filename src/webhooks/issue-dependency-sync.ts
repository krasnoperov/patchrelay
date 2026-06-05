import type { PatchRelayDatabase } from "../db.ts";
import type { DelegationAuditHydration } from "../delegation-audit.ts";
import type { IssueMetadata, LinearClientProvider } from "../types.ts";
import { replaceIssueDependenciesFromLinearIssue } from "../linear-issue-projection.ts";
import { mergeIssueMetadata } from "./decision-helpers.ts";

export interface SyncIssueDependenciesResult {
  issue: IssueMetadata;
  hydration: DelegationAuditHydration;
}

/**
 * Brings the local dependency / parent-link state for `issue` up to date.
 * If the webhook payload doesn't already include relation data we fetch it
 * from Linear directly so subsequent decisions don't operate on a
 * stale-by-omission snapshot. Returns the resolved `IssueMetadata` plus a
 * label describing where the relation data came from (used by the audit
 * trail).
 */
export async function syncIssueDependencies(
  db: PatchRelayDatabase,
  linearProvider: LinearClientProvider,
  projectId: string,
  issue: IssueMetadata,
): Promise<SyncIssueDependenciesResult> {
  let source = issue;
  let hydration: DelegationAuditHydration = "webhook_only";
  if (!source.relationsKnown) {
    const linear = await linearProvider.forProject(projectId);
    if (linear) {
      try {
        source = mergeIssueMetadata(source, await linear.getIssue(issue.id));
        hydration = "live_linear";
      } catch {
        // Preserve existing dependency rows when webhook relation data is incomplete.
        hydration = "live_linear_failed";
      }
    }
  }

  if (source.relationsKnown) {
    replaceIssueDependenciesFromLinearIssue(db, projectId, source);
  }

  db.issues.replaceIssueParentLink({
    projectId,
    childLinearIssueId: source.id,
    parentLinearIssueId: source.parentId ?? null,
  });

  return { issue: source, hydration };
}
