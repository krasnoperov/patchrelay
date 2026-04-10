import { TERMINAL_STATES, type FactoryState } from "./factory-state.ts";

export interface PrLifecycleIssueLike {
  prNumber?: number | undefined;
  prState?: string | undefined;
  currentLinearState?: string | undefined;
  currentLinearStateType?: string | undefined;
  factoryState?: FactoryState | string | undefined;
}

export function isOpenPrState(prState: string | undefined): boolean {
  return prState === undefined || prState === "open";
}

export function hasOpenPr(prNumber: number | undefined, prState: string | undefined): boolean {
  return prNumber !== undefined && isOpenPrState(prState);
}

export function isClosedPrState(prState: string | undefined): boolean {
  return prState === "closed";
}

export function isCompletedLinearState(
  currentLinearStateType: string | undefined,
  currentLinearState: string | undefined,
): boolean {
  return currentLinearStateType === "completed"
    || currentLinearState?.trim().toLowerCase() === "done";
}

export function isIssueCompleted(issue: Pick<PrLifecycleIssueLike, "currentLinearStateType" | "currentLinearState" | "factoryState">): boolean {
  return issue.factoryState === "done" || isCompletedLinearState(issue.currentLinearStateType, issue.currentLinearState);
}

export function isIssueTerminal(issue: Pick<PrLifecycleIssueLike, "factoryState">): boolean {
  return issue.factoryState !== undefined && TERMINAL_STATES.has(issue.factoryState as FactoryState);
}

export function resolveClosedPrDisposition(issue: Pick<PrLifecycleIssueLike, "currentLinearStateType" | "currentLinearState" | "factoryState">): "done" | "terminal" | "redelegate" {
  if (isIssueCompleted(issue)) return "done";
  if (isIssueTerminal(issue)) return "terminal";
  return "redelegate";
}

export function buildClosedPrCleanupFields() {
  return {
    prReviewState: null,
    prCheckStatus: null,
    lastBlockingReviewHeadSha: null,
    lastGitHubCiSnapshotHeadSha: null,
    lastGitHubCiSnapshotGateCheckName: null,
    lastGitHubCiSnapshotGateCheckStatus: null,
    lastGitHubCiSnapshotJson: null,
    lastGitHubCiSnapshotSettledAt: null,
  };
}
