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
  workflowIntent?: WorkflowRunIntent | undefined;
  issueUpdates: {
    workflowOutcome?: "completed" | null;
    workflowOutcomeReason?: string | null;
    inputRequestKind?: "completion_check_question" | null;
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
      issueUpdates: {
        ...issueUpdates,
        prIsDraft: false,
        workflowOutcome: "completed",
        workflowOutcomeReason: "adopted_pr_already_merged",
        inputRequestKind: null,
      },
    };
  }

  if (prState === "closed") {
    return {
      workflowIntent: workflowRunIntent("implementation"),
      issueUpdates: {
        ...issueUpdates,
        prIsDraft: false,
        ...buildClosedPrCleanupFields(),
        workflowOutcome: null,
        workflowOutcomeReason: null,
        inputRequestKind: null,
      },
    };
  }

  if (remote.isCrossRepository) {
    return {
      issueUpdates: { ...issueUpdates, inputRequestKind: "completion_check_question" },
    };
  }

  if (remote.isDraft) {
    return {
      workflowIntent: workflowRunIntent("implementation"),
      issueUpdates: { ...issueUpdates, workflowOutcome: null, workflowOutcomeReason: null, inputRequestKind: null },
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
    return { issueUpdates };
  }

  return { issueUpdates };
}
