import type { FactoryState } from "./factory-state.ts";
import {
  deriveClosedPrDispositionProjection,
  deriveIssueTerminalOutcome,
} from "./issue-execution-state.ts";
export { isCanceledLinearState, isCompletedLinearState, isTerminalLinearState } from "./linear-state.ts";
export { hasOpenPr, isClosedPrState, isOpenPrState } from "./pr-lifecycle.ts";

export interface PrLifecycleIssueLike {
  prNumber?: number | undefined;
  prState?: string | undefined;
  currentLinearState?: string | undefined;
  currentLinearStateType?: string | undefined;
  factoryState?: FactoryState | string | undefined;
}

export function isIssueCompleted(issue: Pick<PrLifecycleIssueLike, "currentLinearStateType" | "currentLinearState" | "factoryState">): boolean {
  return deriveIssueTerminalOutcome(issue) === "done";
}

export function isIssueTerminal(issue: Pick<PrLifecycleIssueLike, "factoryState">): boolean {
  return deriveClosedPrDispositionProjection(issue) === "terminal";
}

export function resolveClosedPrDisposition(issue: Pick<PrLifecycleIssueLike, "currentLinearStateType" | "currentLinearState" | "factoryState">): "done" | "terminal" | "redelegate" {
  return deriveClosedPrDispositionProjection(issue);
}

export function resolveClosedPrFactoryState(
  issue: Pick<PrLifecycleIssueLike, "currentLinearStateType" | "currentLinearState" | "factoryState">,
): FactoryState {
  const disposition = resolveClosedPrDisposition(issue);
  if (disposition === "done") return "done";
  if (disposition === "terminal") return issue.factoryState as FactoryState;
  return "delegated";
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
