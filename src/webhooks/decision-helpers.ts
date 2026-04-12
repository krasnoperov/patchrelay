import { TERMINAL_STATES, type FactoryState } from "../factory-state.ts";
import type { PatchRelayDatabase } from "../db.ts";
import type { IssueMetadata, RunType } from "../types.ts";
import { deriveIssueSessionReactiveIntent } from "../issue-session.ts";
import type { AwaitingInputReason } from "../awaiting-input-reason.ts";

export function decideRunIntent(p: {
  delegated: boolean;
  triggerAllowed: boolean;
  triggerEvent: string;
  unresolvedBlockers: number;
  hasActiveRun: boolean;
  hasPendingWake: boolean;
  terminal: boolean;
  currentState?: FactoryState | undefined;
}): RunType | undefined {
  const wakeEligibleState =
    p.currentState === undefined
    || p.currentState === "delegated"
    || p.currentState === "awaiting_input";
  const delegatedStartupRecovery =
    p.delegated
    && p.currentState === "awaiting_input"
    && p.triggerEvent === "issueCreated";
  if (p.delegated && (p.triggerAllowed || delegatedStartupRecovery) && p.unresolvedBlockers === 0
      && !p.hasActiveRun && !p.hasPendingWake && !p.terminal && wakeEligibleState) {
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
  if (p.terminal) return { release: true, reason: "Issue reached terminal state during active run" };
  if (p.triggerEvent === "delegateChanged" && !p.delegated) return { release: true, reason: "Un-delegated from PatchRelay" };
  return { release: false };
}

export function decideUnDelegation(p: {
  triggerEvent: string;
  delegated: boolean;
  currentState?: FactoryState | undefined;
  hasPr: boolean;
}): { factoryState?: FactoryState | undefined; clearPending: boolean } {
  if (p.triggerEvent !== "delegateChanged" || p.delegated) return { clearPending: false };
  if (!p.currentState) return { clearPending: false };
  if (TERMINAL_STATES.has(p.currentState)) return { clearPending: false };
  return { factoryState: p.currentState, clearPending: true };
}

export function resolveReDelegationResume(p: {
  delegated: boolean;
  previouslyDelegated?: boolean | undefined;
  currentState?: FactoryState | undefined;
  awaitingInputReason?: AwaitingInputReason | undefined;
  unresolvedBlockers?: number | undefined;
  prNumber?: number | undefined;
  prState?: string | undefined;
  prIsDraft?: boolean | undefined;
  prReviewState?: string | undefined;
  prCheckStatus?: string | undefined;
  latestFailureSource?: string | undefined;
}): { factoryState?: FactoryState | undefined; pendingRunType?: RunType | null } {
  if (!p.delegated || p.previouslyDelegated !== false) {
    return {};
  }

  if (p.prState === "merged") {
    return { factoryState: "done", pendingRunType: null };
  }

  if (p.prNumber !== undefined && (p.prState === undefined || p.prState === "open") && p.prIsDraft) {
    return {
      factoryState: "delegated",
      pendingRunType: (p.unresolvedBlockers ?? 0) === 0 ? "implementation" : null,
    };
  }

  const reactiveIntent = deriveIssueSessionReactiveIntent({
    delegatedToPatchRelay: true,
    prNumber: p.prNumber,
    prState: p.prState,
    prIsDraft: p.prIsDraft,
    prReviewState: p.prReviewState,
    prCheckStatus: p.prCheckStatus,
    latestFailureSource: p.latestFailureSource,
  });
  if (reactiveIntent) {
    return {
      factoryState: reactiveIntent.compatibilityFactoryState,
      pendingRunType: reactiveIntent.runType,
    };
  }

  if (p.prNumber !== undefined && (p.prState === undefined || p.prState === "open")) {
    if (p.prReviewState === "approved") {
      return { factoryState: "awaiting_queue", pendingRunType: null };
    }
    return { factoryState: "pr_open", pendingRunType: null };
  }

  if (p.currentState === "awaiting_input" && p.awaitingInputReason === "completion_check_question") {
    return {
      factoryState: "awaiting_input",
      pendingRunType: null,
    };
  }

  if (p.currentState === "awaiting_input" || p.currentState === "delegated" || p.currentState === "implementing") {
    return {
      factoryState: "delegated",
      pendingRunType: (p.unresolvedBlockers ?? 0) === 0 ? "implementation" : null,
    };
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
  if (existingIssue?.factoryState && existingIssue.factoryState !== "awaiting_input" && TERMINAL_STATES.has(existingIssue.factoryState)) {
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
    identifier?: string; title?: string; url?: string;
    attachments?: Array<{ id: string; title?: string; subtitle?: string; url: string }>;
    teamId?: string; teamKey?: string; stateId?: string; stateName?: string; stateType?: string;
    delegateId?: string; delegateName?: string;
    blockedBy?: Array<{ id: string; identifier?: string; title?: string; stateName?: string; stateType?: string }>;
    blocks?: Array<{ id: string; identifier?: string; title?: string; stateName?: string; stateType?: string }>;
    labels?: Array<{ id: string; name: string }>;
  },
): IssueMetadata {
  return {
    ...issue,
    ...(issue.identifier ? {} : liveIssue.identifier ? { identifier: liveIssue.identifier } : {}),
    ...(issue.title ? {} : liveIssue.title ? { title: liveIssue.title } : {}),
    ...(issue.url ? {} : liveIssue.url ? { url: liveIssue.url } : {}),
    ...(issue.attachments && issue.attachments.length > 0 ? {} : liveIssue.attachments ? { attachments: liveIssue.attachments } : {}),
    ...(issue.teamId ? {} : liveIssue.teamId ? { teamId: liveIssue.teamId } : {}),
    ...(issue.teamKey ? {} : liveIssue.teamKey ? { teamKey: liveIssue.teamKey } : {}),
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
