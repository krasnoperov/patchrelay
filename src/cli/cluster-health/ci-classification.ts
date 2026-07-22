import { deriveGateCheckStatusFromRollup, type GitHubStatusRollupEntry } from "../../github-rollup.ts";
import type { IssueRecord } from "../../db-types.ts";
import type { IssueExecutionState } from "../../issue-execution-state.ts";
import type { AppConfig } from "../../types.ts";
import type {
  CiGateStatus,
  CiOwner,
  ClusterCiEntry,
  ReviewQuillAttemptOwnership,
} from "./types.ts";
import { deriveIssuePhase } from "../../issue-phase.ts";

export function getGateCheckNames(project: AppConfig["projects"][number] | undefined): string[] {
  const configured = project?.gateChecks?.map((entry) => entry.trim()).filter(Boolean) ?? [];
  return configured.length > 0 ? configured : ["Tests", "verify"];
}

export function deriveCiGateStatus(
  statusCheckRollup: GitHubStatusRollupEntry[] | undefined,
  gateCheckNames: string[],
): CiGateStatus {
  const gateStatus = deriveGateCheckStatusFromRollup(statusCheckRollup, gateCheckNames);
  if (gateStatus) {
    return gateStatus;
  }

  const entries = Array.isArray(statusCheckRollup) ? statusCheckRollup : [];
  if (entries.length === 0) {
    return "unknown";
  }

  const hasPending = entries.some((entry) => {
    const status = entry.status?.trim().toLowerCase();
    return status === "queued" || status === "in_progress" || status === "requested" || status === "waiting" || status === "pending";
  });
  if (hasPending) {
    return "pending";
  }

  return "unknown";
}

export interface CiOwnerParams {
  delegatedToPatchRelay: boolean;
  gateCheckStatus: CiGateStatus;
  executionState: IssueExecutionState;
  reviewDecision?: string | undefined;
  reviewRequested: boolean;
  currentHeadSha?: string | undefined;
  latestBlockingReviewHeadSha?: string | undefined;
  mergeConflictDetected: boolean;
  reviewQuillAttempt?: ReviewQuillAttemptOwnership | undefined;
}

export function deriveCiOwner(params: CiOwnerParams): CiOwner {
  if (params.executionState.kind === "running" || params.executionState.kind === "inconsistent") {
    return "patchrelay";
  }
  const headAdvancedPastBlockingReview = Boolean(
    params.currentHeadSha
      && params.latestBlockingReviewHeadSha
      && params.currentHeadSha !== params.latestBlockingReviewHeadSha,
  );
  if (params.gateCheckStatus === "failure") {
    if (!params.delegatedToPatchRelay) return "paused";
    return executionStateOwnsRunType(params.executionState, "ci_repair") ? "patchrelay" : "unknown";
  }
  if (params.gateCheckStatus === "pending") {
    return "external";
  }
  if (isDownstreamWait(params.executionState) || params.reviewDecision === "APPROVED") {
    if (params.mergeConflictDetected && !params.delegatedToPatchRelay) {
      return "paused";
    }
    return params.mergeConflictDetected && !executionStateOwnsRunType(params.executionState, "queue_repair")
      ? "unknown"
      : "downstream";
  }
  if (params.reviewDecision === "CHANGES_REQUESTED") {
    if (params.mergeConflictDetected) {
      if (!params.delegatedToPatchRelay) return "paused";
      return executionStateOwnsRunType(params.executionState, "branch_upkeep", "review_fix", "queue_repair")
        ? "patchrelay"
        : "unknown";
    }
    if (!params.delegatedToPatchRelay) return "paused";
    if (executionStateOwnsRunType(params.executionState, "review_fix", "branch_upkeep")) return "patchrelay";
    if (
      params.reviewQuillAttempt?.backlog
      && params.currentHeadSha
      && params.reviewQuillAttempt.headSha
      && params.currentHeadSha !== params.reviewQuillAttempt.headSha
    ) {
      return "review-quill";
    }
    if (params.reviewQuillAttempt && !params.reviewQuillAttempt.backlog) return "review-quill";
    if (headAdvancedPastBlockingReview) return "reviewer";
    return "unknown";
  }
  if (params.reviewDecision === "REVIEW_REQUIRED") {
    if (params.reviewQuillAttempt) return "review-quill";
    if (params.gateCheckStatus === "success") return "reviewer";
    return params.reviewRequested ? "reviewer" : "unknown";
  }
  if (params.gateCheckStatus === "success") {
    return "reviewer";
  }
  return "external";
}

function executionStateOwnsRunType(state: IssueExecutionState, ...runTypes: string[]): boolean {
  if (state.kind === "ready") return runTypes.includes(state.runnableTaskRunType);
  return false;
}

function isDownstreamWait(state: IssueExecutionState): boolean {
  return state.kind === "idle_awaiting_external"
    && (state.waitingOn === "merge_queue" || state.waitingOn === "downstream_automation");
}

export interface CiOwnershipDescriptionParams {
  delegatedToPatchRelay: boolean;
  gateCheckStatus: CiGateStatus;
  owner: CiOwner;
  reviewDecision?: string | undefined;
  reviewRequested: boolean;
  currentHeadSha?: string | undefined;
  latestBlockingReviewHeadSha?: string | undefined;
  mergeConflictDetected: boolean;
  reviewQuillAttempt?: ReviewQuillAttemptOwnership | undefined;
}

export function describeCiOwnership(params: CiOwnershipDescriptionParams): string {
  const blockingReviewTargetsCurrentHead = Boolean(
    params.currentHeadSha
      && params.latestBlockingReviewHeadSha
      && params.currentHeadSha === params.latestBlockingReviewHeadSha,
  );
  const headAdvancedPastBlockingReview = Boolean(
    params.currentHeadSha
      && params.latestBlockingReviewHeadSha
      && params.currentHeadSha !== params.latestBlockingReviewHeadSha,
  );
  if (params.owner === "patchrelay") {
    if (params.mergeConflictDetected) {
      return "PatchRelay owns the next branch-upkeep move";
    }
    return params.gateCheckStatus === "failure"
      ? "PatchRelay owns the next CI repair move"
      : "PatchRelay owns the next requested-changes move";
  }
  if (params.owner === "review-quill") {
    if (params.reviewQuillAttempt?.backlog) {
      return "review-quill is actively reconciling this repo; this PR is waiting in the current review backlog";
    }
    return params.reviewQuillAttempt?.id && params.reviewQuillAttempt.status
      ? `review-quill attempt #${params.reviewQuillAttempt.id} is ${params.reviewQuillAttempt.status} on the current head`
      : "review-quill owns the current review attempt";
  }
  if (params.owner === "reviewer") {
    if (headAdvancedPastBlockingReview) {
      return "Waiting on review of a newer pushed head";
    }
    return params.reviewRequested
      ? "Waiting on an active reviewer request"
      : "Waiting on review of the current head";
  }
  if (params.owner === "downstream") {
    return params.mergeConflictDetected
      ? "Downstream merge automation is expected to repair or requeue this PR"
      : "Downstream merge automation owns the next move";
  }
  if (params.owner === "external") {
    return params.gateCheckStatus === "pending"
      ? "Waiting on external CI checks to settle"
      : "Waiting on external GitHub automation";
  }
  if (params.owner === "paused") {
    if (params.gateCheckStatus === "failure") {
      return "PatchRelay is paused; delegate the issue again to repair failing CI";
    }
    if (params.reviewDecision === "CHANGES_REQUESTED") {
      return params.mergeConflictDetected
        ? "PatchRelay is paused; delegate the issue again to repair the blocked PR branch"
        : "PatchRelay is paused; delegate the issue again to address requested changes";
    }
    if (params.mergeConflictDetected) {
      return "PatchRelay is paused; delegate the issue again to repair this merge conflict";
    }
    return "PatchRelay is paused; no automatic repair will start until the issue is delegated again";
  }
  if (params.reviewDecision === "CHANGES_REQUESTED") {
    if (params.mergeConflictDetected) {
      return headAdvancedPastBlockingReview
        ? "PR is still dirty after a newer pushed head and no branch-upkeep run is active"
        : "PR is still dirty on the current blocked head and no branch-upkeep run is active";
    }
    return blockingReviewTargetsCurrentHead
      ? "Requested changes still block the same head and no fix run is active"
      : "Waiting on review after a newer pushed head";
  }
  if (params.reviewDecision === "REVIEW_REQUIRED") {
    return "Waiting on review of the current head";
  }
  return "No visible next owner for this PR state";
}

export interface BuildCiEntryParams {
  issue: IssueRecord;
  delegatedToPatchRelay: boolean;
  gateCheckStatus: CiGateStatus;
  executionState: IssueExecutionState;
  reviewDecision?: string | undefined;
  reviewRequested: boolean;
  currentHeadSha?: string | undefined;
  latestBlockingReviewHeadSha?: string | undefined;
  mergeConflictDetected: boolean;
  reviewQuillAttempt?: ReviewQuillAttemptOwnership | undefined;
}

export function buildCiEntry(params: BuildCiEntryParams): ClusterCiEntry {
  const {
    issue,
    delegatedToPatchRelay,
    gateCheckStatus,
    executionState,
    reviewDecision,
    reviewRequested,
    currentHeadSha,
    latestBlockingReviewHeadSha,
    mergeConflictDetected,
    reviewQuillAttempt,
  } = params;
  const owner = deriveCiOwner({
    delegatedToPatchRelay,
    gateCheckStatus,
    executionState,
    reviewDecision,
    reviewRequested,
    currentHeadSha,
    latestBlockingReviewHeadSha,
    mergeConflictDetected,
    reviewQuillAttempt,
  });
  return {
    ...(issue.issueKey ? { issueKey: issue.issueKey } : {}),
    projectId: issue.projectId,
    prNumber: issue.prNumber!,
    gateStatus: gateCheckStatus,
    owner,
    orphaned: owner === "unknown",
    phase: deriveIssuePhase(issue),
    ...(reviewDecision ? { reviewDecision } : {}),
    message: describeCiOwnership({
      delegatedToPatchRelay,
      gateCheckStatus,
      owner,
      reviewDecision,
      reviewRequested,
      currentHeadSha,
      latestBlockingReviewHeadSha,
      mergeConflictDetected,
      reviewQuillAttempt,
    }),
  };
}
