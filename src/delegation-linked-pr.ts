import type { FactoryState } from "./factory-state.ts";
import type { ProjectConfig } from "./types.ts";
import type { RemotePrState } from "./remote-pr-state.ts";
import { deriveGateCheckStatusFromRollup } from "./github-rollup.ts";
import { deriveReactiveWorkflowIntent } from "./reactive-workflow-intent.ts";
import { buildClosedPrCleanupFields } from "./pr-state.ts";
import {
  buildReviewFixBranchUpkeepContext,
  normalizeRemotePrState,
  normalizeRemoteReviewDecision,
} from "./reactive-pr-state.ts";
import { workflowRunIntent, type WorkflowRunIntent } from "./workflow-intent.ts";

export interface LinkedPrAdoptionOutcome {
  factoryState: FactoryState;
  workflowIntent?: WorkflowRunIntent | undefined;
  issueUpdates: {
    branchName?: string;
    prNumber?: number;
    prUrl?: string | null;
    prState?: string | null;
    prIsDraft?: boolean | null;
    prHeadSha?: string | null;
    prAuthorLogin?: string | null;
    prReviewState?: string | null;
    prCheckStatus?: string | null;
    lastBlockingReviewHeadSha?: string | null;
    lastGitHubCiSnapshotHeadSha?: string | null;
    lastGitHubCiSnapshotGateCheckName?: string | null;
    lastGitHubCiSnapshotGateCheckStatus?: string | null;
    lastGitHubCiSnapshotSettledAt?: string | null;
  };
}

export function deriveLinkedPrAdoptionOutcome(
  project: ProjectConfig,
  prNumber: number,
  remote: RemotePrState,
): LinkedPrAdoptionOutcome {
  const prState = normalizeRemotePrState(remote.state);
  const reviewState = normalizeRemoteReviewDecision(remote.reviewDecision);
  const configuredGateChecks = (project.gateChecks ?? []).map((entry) => entry.trim()).filter(Boolean);
  const gateCheckNames = configuredGateChecks.length > 0 ? configuredGateChecks : ["verify"];
  const primaryGateCheck = gateCheckNames[0]!;
  const gateCheckStatus = deriveGateCheckStatusFromRollup(remote.statusCheckRollup, gateCheckNames);
  const mergeConflictDetected = remote.mergeable === "CONFLICTING" || remote.mergeStateStatus === "DIRTY";
  const downstreamOwned = reviewState === "approved";

  const issueUpdates: LinkedPrAdoptionOutcome["issueUpdates"] = {
    prNumber,
    ...(remote.url ? { prUrl: remote.url } : {}),
    ...(prState ? { prState } : {}),
    ...(typeof remote.isDraft === "boolean" ? { prIsDraft: remote.isDraft } : {}),
    ...(remote.headRefName ? { branchName: remote.headRefName } : {}),
    ...(remote.headRefOid ? { prHeadSha: remote.headRefOid } : {}),
    ...(remote.author?.login ? { prAuthorLogin: remote.author.login } : {}),
    ...(reviewState ? { prReviewState: reviewState } : {}),
    ...(gateCheckStatus ? { prCheckStatus: gateCheckStatus } : {}),
    ...(reviewState === "changes_requested"
      ? { lastBlockingReviewHeadSha: remote.headRefOid ?? null }
      : { lastBlockingReviewHeadSha: null }),
    ...(remote.headRefOid && gateCheckStatus
      ? {
          lastGitHubCiSnapshotHeadSha: remote.headRefOid,
          lastGitHubCiSnapshotGateCheckName: primaryGateCheck,
          lastGitHubCiSnapshotGateCheckStatus: gateCheckStatus,
          lastGitHubCiSnapshotSettledAt: gateCheckStatus === "pending" ? null : new Date().toISOString(),
        }
      : {}),
  };

  if (prState === "merged") {
    return {
      factoryState: "done",
      issueUpdates: {
        ...issueUpdates,
        prIsDraft: false,
      },
    };
  }

  if (prState === "closed") {
    return {
      factoryState: "delegated",
      workflowIntent: workflowRunIntent("implementation"),
      issueUpdates: {
        ...issueUpdates,
        prIsDraft: false,
        ...buildClosedPrCleanupFields(),
      },
    };
  }

  if (remote.isCrossRepository) {
    return {
      factoryState: "awaiting_input",
      issueUpdates,
    };
  }

  if (remote.isDraft) {
    return {
      factoryState: "delegated",
      workflowIntent: workflowRunIntent("implementation"),
      issueUpdates,
    };
  }

  const reactiveIntent = deriveReactiveWorkflowIntent({
    delegatedToPatchRelay: true,
    prNumber,
    prState,
    prHeadSha: remote.headRefOid,
    prReviewState: reviewState,
    prCheckStatus: gateCheckStatus,
    lastBlockingReviewHeadSha: reviewState === "changes_requested" ? remote.headRefOid : undefined,
    mergeConflictDetected,
    downstreamOwned,
  });
  if (reactiveIntent) {
    return {
      factoryState: reactiveIntent.compatibilityFactoryState,
      workflowIntent: workflowRunIntent(
        reactiveIntent.runType,
        reactiveIntent.runType === "branch_upkeep"
          ? buildReviewFixBranchUpkeepContext(
              prNumber,
              project.github?.baseBranch ?? "main",
              remote,
            )
          : undefined,
      ),
      issueUpdates,
    };
  }

  if (reviewState === "approved") {
    return {
      factoryState: "awaiting_queue",
      issueUpdates,
    };
  }

  return {
    factoryState: "pr_open",
    issueUpdates,
  };
}
