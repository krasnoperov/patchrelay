import type { PatchRelayDatabase } from "../db.ts";
import type { IssueMetadata, RunType } from "../types.ts";
import { deriveReactiveWorkflowIntent } from "../reactive-workflow-intent.ts";
import type { AwaitingInputReason } from "../awaiting-input-reason.ts";
import { isIssueAwaitingInputProjection, isIssueTerminalProjection } from "../issue-execution-state.ts";
import { workflowRunIntent, type WorkflowRunIntent } from "../workflow-intent.ts";

export function decideRunIntent(p: {
  delegated: boolean;
  triggerAllowed: boolean;
  triggerEvent: string;
  unresolvedBlockers: number;
  hasActiveRun: boolean;
  hasRunnableWorkflowTask: boolean;
  terminal: boolean;
  inputRequestKind?: AwaitingInputReason | undefined;
}): RunType | undefined {
  const delegatedStartupRecovery =
    p.delegated
    && p.inputRequestKind !== undefined
    && p.triggerEvent === "issueCreated";
  if (p.delegated && (p.triggerAllowed || delegatedStartupRecovery) && p.unresolvedBlockers === 0
      && !p.hasActiveRun && !p.hasRunnableWorkflowTask && !p.terminal
      && (p.inputRequestKind === undefined || delegatedStartupRecovery)) {
    return "implementation";
  }
  return undefined;
}

export function decideActiveRunRelease(p: {
  hasActiveRun: boolean;
  terminal: boolean;
  triggerEvent: string;
  delegated: boolean;
}): { release: boolean; reason?: string } {
  if (!p.hasActiveRun) return { release: false };
  // External terminal state is a fact, not a handoff. The active Codex turn owns completion.
  if (!p.delegated) return { release: true, reason: "Un-delegated from PatchRelay" };
  return { release: false };
}

export function decideUnDelegation(p: {
  triggerEvent: string;
  delegated: boolean;
  terminal: boolean;
  hasPr: boolean;
}): { paused: boolean; clearPending: boolean } {
  if (p.delegated) return { paused: false, clearPending: false };
  if (p.terminal) return { paused: false, clearPending: false };
  return { paused: true, clearPending: true };
}

export function resolveReDelegationResume(p: {
  delegated: boolean;
  previouslyDelegated?: boolean | undefined;
  awaitingInputReason?: AwaitingInputReason | undefined;
  unresolvedBlockers?: number | undefined;
  prNumber?: number | undefined;
  prState?: string | undefined;
  prIsDraft?: boolean | undefined;
  prHeadSha?: string | undefined;
  prReviewState?: string | undefined;
  prCheckStatus?: string | undefined;
  lastBlockingReviewHeadSha?: string | undefined;
  latestFailureSource?: string | undefined;
}): { workflowIntent?: WorkflowRunIntent | undefined } {
  if (!p.delegated || p.previouslyDelegated !== false) {
    return {};
  }

  if (p.prState === "merged") {
    return {};
  }

  if (p.prNumber !== undefined && (p.prState === undefined || p.prState === "open") && p.prIsDraft) {
    return (p.unresolvedBlockers ?? 0) === 0 ? { workflowIntent: workflowRunIntent("implementation") } : {};
  }

  const reactiveIntent = deriveReactiveWorkflowIntent({
    delegatedToPatchRelay: true,
    prNumber: p.prNumber,
    prState: p.prState,
    prIsDraft: p.prIsDraft,
    prHeadSha: p.prHeadSha,
    prReviewState: p.prReviewState,
    prCheckStatus: p.prCheckStatus,
    lastBlockingReviewHeadSha: p.lastBlockingReviewHeadSha,
    latestFailureSource: p.latestFailureSource,
  });
  if (reactiveIntent) {
    return { workflowIntent: workflowRunIntent(reactiveIntent.runType) };
  }

  if (p.prNumber !== undefined && (p.prState === undefined || p.prState === "open")) {
    if (p.prReviewState === "approved") {
      return {};
    }
    return {};
  }

  if (p.awaitingInputReason === "completion_check_question") {
    return {};
  }

  if (p.prNumber === undefined) {
    return (p.unresolvedBlockers ?? 0) === 0 ? { workflowIntent: workflowRunIntent("implementation") } : {};
  }

  return {};
}

export function decideAgentSession(p: {
  sessionId?: string | undefined;
  triggerEvent: string;
  delegated: boolean;
}): string | null | undefined {
  if (p.sessionId) return p.sessionId;
  if (p.triggerEvent === "delegateChanged" && !p.delegated) return null;
  return undefined;
}

export function isResolvedLinearState(stateType?: string, stateName?: string): boolean {
  return stateType === "completed" || stateName?.trim().toLowerCase() === "done";
}

export function isTerminalDelegationState(
  existingIssue: ReturnType<PatchRelayDatabase["getIssue"]>,
  hydratedIssue: IssueMetadata,
): boolean {
  if (existingIssue?.prState === "merged") {
    return true;
  }
  if (existingIssue && !isIssueAwaitingInputProjection(existingIssue) && isIssueTerminalProjection(existingIssue)) {
    return true;
  }
  return isResolvedLinearState(hydratedIssue.stateType, hydratedIssue.stateName);
}

export function hasCompleteIssueContext(issue: IssueMetadata): boolean {
  return Boolean(issue.stateName && issue.delegateId && issue.teamId && issue.teamKey);
}

export function mergeIssueMetadata(
  issue: IssueMetadata,
  liveIssue: {
    parentId?: string;
    parentIdentifier?: string;
    parentTitle?: string;
    identifier?: string; title?: string; url?: string;
    attachments?: Array<{ id: string; title?: string; subtitle?: string; url: string }>;
    teamId?: string; teamKey?: string; projectId?: string; projectName?: string; stateId?: string; stateName?: string; stateType?: string;
    delegateId?: string; delegateName?: string;
    blockedBy?: Array<{ id: string; identifier?: string; title?: string; stateName?: string; stateType?: string }>;
    blocks?: Array<{ id: string; identifier?: string; title?: string; stateName?: string; stateType?: string }>;
    labels?: Array<{ id: string; name: string }>;
  },
): IssueMetadata {
  return {
    ...issue,
    ...(issue.parentId ? {} : liveIssue.parentId ? { parentId: liveIssue.parentId } : {}),
    ...(issue.parentIdentifier ? {} : liveIssue.parentIdentifier ? { parentIdentifier: liveIssue.parentIdentifier } : {}),
    ...(issue.parentTitle ? {} : liveIssue.parentTitle ? { parentTitle: liveIssue.parentTitle } : {}),
    ...(issue.identifier ? {} : liveIssue.identifier ? { identifier: liveIssue.identifier } : {}),
    ...(issue.title ? {} : liveIssue.title ? { title: liveIssue.title } : {}),
    ...(issue.url ? {} : liveIssue.url ? { url: liveIssue.url } : {}),
    ...(issue.attachments && issue.attachments.length > 0 ? {} : liveIssue.attachments ? { attachments: liveIssue.attachments } : {}),
    ...(issue.teamId ? {} : liveIssue.teamId ? { teamId: liveIssue.teamId } : {}),
    ...(issue.teamKey ? {} : liveIssue.teamKey ? { teamKey: liveIssue.teamKey } : {}),
    ...(issue.projectId ? {} : liveIssue.projectId ? { projectId: liveIssue.projectId } : {}),
    ...(issue.projectName ? {} : liveIssue.projectName ? { projectName: liveIssue.projectName } : {}),
    ...(issue.stateId ? {} : liveIssue.stateId ? { stateId: liveIssue.stateId } : {}),
    ...(issue.stateName ? {} : liveIssue.stateName ? { stateName: liveIssue.stateName } : {}),
    ...(issue.stateType ? {} : liveIssue.stateType ? { stateType: liveIssue.stateType } : {}),
    ...(issue.delegateId ? {} : liveIssue.delegateId ? { delegateId: liveIssue.delegateId } : {}),
    ...(issue.delegateName ? {} : liveIssue.delegateName ? { delegateName: liveIssue.delegateName } : {}),
    relationsKnown: issue.relationsKnown || liveIssue.blockedBy !== undefined || liveIssue.blocks !== undefined,
    labelNames: issue.labelNames.length > 0 ? issue.labelNames : (liveIssue.labels ?? []).map((l) => l.name),
    blockedBy: issue.relationsKnown ? issue.blockedBy : (liveIssue.blockedBy ?? issue.blockedBy),
    blocks: issue.relationsKnown ? issue.blocks : (liveIssue.blocks ?? issue.blocks),
  };
}
