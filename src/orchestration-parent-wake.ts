import type { PatchRelayDatabase } from "./db.ts";
import type { IssueRecord } from "./db-types.ts";
import { classifyIssue } from "./issue-class.ts";
import type { WakeDispatcher } from "./wake-dispatcher.ts";
import type { RunContext } from "./run-context.ts";

const WRITER = "orchestration-parent-wake";

export const ORCHESTRATION_SETTLE_WINDOW_MS = 10_000;

export function computeOrchestrationSettleUntil(now = Date.now()): string {
  return new Date(now + ORCHESTRATION_SETTLE_WINDOW_MS).toISOString();
}

function resolveOrchestrationIssueClass(
  db: PatchRelayDatabase,
  issue: Pick<IssueRecord, "projectId" | "linearIssueId" | "issueClass" | "issueClassSource" | "title" | "description" | "parentLinearIssueId">,
): "implementation" | "orchestration" {
  return classifyIssue({
    issue,
    childIssueCount: db.issues.listCanonicalChildIssues(issue.projectId, issue.linearIssueId).length,
  }).issueClass;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function resolveParentIssueIds(
  db: PatchRelayDatabase,
  child: Pick<IssueRecord, "projectId" | "linearIssueId" | "parentLinearIssueId">,
): string[] {
  const parentIds: string[] = [];
  if (child.parentLinearIssueId) {
    parentIds.push(child.parentLinearIssueId);
  }
  for (const blocker of db.issues.listIssueDependencies(child.projectId, child.linearIssueId)) {
    parentIds.push(blocker.blockerLinearIssueId);
  }
  return unique(parentIds);
}

export function startOrchestrationSettleWindow(
  db: PatchRelayDatabase,
  issue: Pick<IssueRecord, "projectId" | "linearIssueId">,
  now = Date.now(),
): string {
  const settleUntil = computeOrchestrationSettleUntil(now);
  db.issueSessions.commitIssueState({
    writer: WRITER,
    update: {
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      orchestrationSettleUntil: settleUntil,
    },
  });
  return settleUntil;
}

export function queueSettledOrchestrationIssue(params: {
  db: PatchRelayDatabase;
  issue: Pick<IssueRecord, "projectId" | "linearIssueId">;
  wakeDispatcher: WakeDispatcher;
  promptContext?: string | undefined;
}): boolean {
  params.db.issueSessions.commitIssueState({
    writer: WRITER,
    update: {
      projectId: params.issue.projectId,
      linearIssueId: params.issue.linearIssueId,
      orchestrationSettleUntil: null,
    },
  });
  const dispatched = params.wakeDispatcher.recordEventAndDispatch(
    params.issue.projectId,
    params.issue.linearIssueId,
    {
      eventType: "delegated",
      eventJson: JSON.stringify({
        promptContext: params.promptContext ?? "The orchestration child set has settled enough to begin planning.",
      } satisfies RunContext),
      dedupeKey: `delegated:orchestration_settle:${params.issue.linearIssueId}`,
    },
  );
  return dispatched !== undefined;
}

export function wakeOrchestrationParentsForChildEvent(params: {
  db: PatchRelayDatabase;
  child: Pick<IssueRecord, "projectId" | "linearIssueId" | "parentLinearIssueId" | "issueKey" | "title" | "factoryState" | "currentLinearState" | "prNumber" | "prState">;
  eventType: "child_changed" | "child_delivered" | "child_regressed";
  changeKind?: "attached" | "detached" | "duplicate" | "canceled" | "updated" | undefined;
  wakeDispatcher: WakeDispatcher;
  now?: number | undefined;
}): string[] {
  const parentIds: string[] = [];

  for (const parentIssueId of resolveParentIssueIds(params.db, params.child)) {
    const parent = params.db.issues.getIssue(params.child.projectId, parentIssueId);
    if (!parent || !parent.delegatedToPatchRelay) {
      continue;
    }

    if (resolveOrchestrationIssueClass(params.db, parent) !== "orchestration") {
      continue;
    }

    // Before the umbrella has started its first turn, keep absorbing nearby
    // child-set changes into the settle window instead of launching too early.
    if (!parent.threadId && parent.activeRunId === undefined && parent.orchestrationSettleUntil) {
      startOrchestrationSettleWindow(params.db, parent, params.now);
      parentIds.push(parent.linearIssueId);
      continue;
    }

    params.wakeDispatcher.recordEventAndDispatch(parent.projectId, parent.linearIssueId, {
      eventType: params.eventType,
      eventJson: JSON.stringify({
        childIssueId: params.child.linearIssueId,
        ...(params.child.issueKey ? { childIssueKey: params.child.issueKey } : {}),
        ...(params.child.title ? { childTitle: params.child.title } : {}),
        factoryState: params.child.factoryState,
        ...(params.child.currentLinearState ? { currentLinearState: params.child.currentLinearState } : {}),
        ...(params.child.prNumber !== undefined ? { prNumber: params.child.prNumber } : {}),
        ...(params.child.prState ? { prState: params.child.prState } : {}),
        ...(params.changeKind ? { changeKind: params.changeKind } : {}),
      } satisfies RunContext),
      dedupeKey: `${params.eventType}:${parent.linearIssueId}:${params.child.linearIssueId}:${params.child.factoryState}:${params.changeKind ?? params.child.prState ?? "no-pr"}`,
    });
    parentIds.push(parent.linearIssueId);
  }

  return unique(parentIds);
}
