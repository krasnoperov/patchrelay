import type { PatchRelayDatabase } from "./db.ts";
import type { IssueRecord } from "./db-types.ts";
import { classifyIssue } from "./issue-class.ts";

export function wakeOrchestrationParentsForChildEvent(params: {
  db: PatchRelayDatabase;
  child: Pick<IssueRecord, "projectId" | "linearIssueId" | "issueKey" | "title" | "factoryState" | "currentLinearState" | "prNumber" | "prState">;
  eventType: "child_changed" | "child_delivered" | "child_regressed";
  enqueueIssue?: ((projectId: string, issueId: string) => void) | undefined;
}): string[] {
  const parentIds: string[] = [];

  for (const blocker of params.db.issues.listIssueDependencies(params.child.projectId, params.child.linearIssueId)) {
    const parent = params.db.issues.getIssue(params.child.projectId, blocker.blockerLinearIssueId);
    if (!parent || !parent.delegatedToPatchRelay) {
      continue;
    }

    const classification = classifyIssue({
      issue: parent,
      trackedDependentCount: params.db.issues.listDependents(parent.projectId, parent.linearIssueId).length,
    });
    if (classification.issueClass !== "orchestration") {
      continue;
    }

    params.db.issueSessions.appendIssueSessionEventRespectingActiveLease(parent.projectId, parent.linearIssueId, {
      projectId: parent.projectId,
      linearIssueId: parent.linearIssueId,
      eventType: params.eventType,
      eventJson: JSON.stringify({
        childIssueId: params.child.linearIssueId,
        ...(params.child.issueKey ? { childIssueKey: params.child.issueKey } : {}),
        ...(params.child.title ? { childTitle: params.child.title } : {}),
        factoryState: params.child.factoryState,
        ...(params.child.currentLinearState ? { currentLinearState: params.child.currentLinearState } : {}),
        ...(params.child.prNumber !== undefined ? { prNumber: params.child.prNumber } : {}),
        ...(params.child.prState ? { prState: params.child.prState } : {}),
      }),
      dedupeKey: `${params.eventType}:${parent.linearIssueId}:${params.child.linearIssueId}:${params.child.factoryState}:${params.child.prState ?? "no-pr"}`,
    });
    if (params.db.issueSessions.peekIssueSessionWake(parent.projectId, parent.linearIssueId)) {
      params.enqueueIssue?.(parent.projectId, parent.linearIssueId);
    }
    parentIds.push(parent.linearIssueId);
  }

  return parentIds;
}
