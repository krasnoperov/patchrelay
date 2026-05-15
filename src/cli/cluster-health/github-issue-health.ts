import type { AppConfig } from "../../types.ts";
import { resolveClosedPrDisposition } from "../../pr-state.ts";
import type { CommandRunner } from "../command-types.ts";
import {
  buildCiEntry,
  deriveCiGateStatus,
  getGateCheckNames,
} from "./ci-classification.ts";
import {
  extractLatestBlockingReviewHeadSha,
  extractRequestedReviewerLogins,
  probeGitHubPullRequest,
} from "./github-probe.ts";
import { RECONCILIATION_GRACE_MS } from "./shared.ts";
import type {
  ClusterCiEntry,
  ClusterHealthCheck,
  IssueSnapshot,
  ReviewQuillAttemptOwnership,
  ServiceProbeResult,
} from "./types.ts";

export interface GitHubIssueHealthResult {
  finding?: ClusterHealthCheck | undefined;
  ciEntry?: ClusterCiEntry | undefined;
}

export async function evaluateGitHubIssueHealth(
  snapshot: IssueSnapshot,
  config: AppConfig,
  runCommand: CommandRunner,
  reviewQuillProbe?: ServiceProbeResult,
  reviewQuillAttemptOwners?: Map<string, ReviewQuillAttemptOwnership>,
  mergeStewardProbe?: ServiceProbeResult,
): Promise<GitHubIssueHealthResult> {
  const { issue, ageMs } = snapshot;
  const project = config.projects.find((entry) => entry.id === issue.projectId);
  const repoFullName = project?.github?.repoFullName;
  if (!repoFullName || issue.prNumber === undefined) {
    return {
      finding: issue.prNumber !== undefined
        ? {
            status: "fail",
            scope: "github:config",
            message: "PR-backed issue has no GitHub repo configured",
          }
        : undefined,
    };
  }

  const probe = await probeGitHubPullRequest(runCommand, repoFullName, issue.prNumber);
  if (!probe.ok) {
    return {
      ciEntry: {
        ...(issue.issueKey ? { issueKey: issue.issueKey } : {}),
        projectId: issue.projectId,
        prNumber: issue.prNumber,
        gateStatus: "unknown",
        owner: "unknown",
        orphaned: true,
        factoryState: issue.factoryState,
        message: `GitHub probe failed: ${probe.error}`,
      },
      finding: {
        status: "warn",
        scope: "github:probe",
        message: `Unable to query GitHub PR state: ${probe.error}`,
      },
    };
  }

  const pr = probe.pr;
  const gateCheckNames = getGateCheckNames(project);
  const gateCheckStatus = deriveCiGateStatus(pr.statusCheckRollup, gateCheckNames);
  const reviewDecision = pr.reviewDecision?.trim().toUpperCase();
  const requestedReviewers = extractRequestedReviewerLogins(pr.reviewRequests);
  const reviewRequested = requestedReviewers.length > 0;
  const latestBlockingReviewHeadSha = extractLatestBlockingReviewHeadSha(pr.latestReviews);
  const mergeConflictDetected = pr.mergeable === "CONFLICTING" || pr.mergeStateStatus === "DIRTY";
  const reviewQuillAttempt = issue.issueKey ? reviewQuillAttemptOwners?.get(issue.issueKey) : undefined;

  if (pr.state === "MERGED" && issue.factoryState !== "done" && ageMs >= RECONCILIATION_GRACE_MS) {
    return {
      finding: {
        status: "fail",
        scope: "github:reconcile",
        message: "PR is already merged but the issue has not advanced to done",
      },
    };
  }

  if (pr.state === "CLOSED") {
    const closedPrDisposition = resolveClosedPrDisposition(issue);
    if (closedPrDisposition === "redelegate" && issue.factoryState !== "delegated" && ageMs >= RECONCILIATION_GRACE_MS) {
      return {
        finding: {
          status: "fail",
          scope: "github:reconcile",
          message: "PR is closed but unfinished work has not been re-delegated",
        },
      };
    }
    return {};
  }

  const ciEntry = buildCiEntry({
    issue,
    delegatedToPatchRelay: issue.delegatedToPatchRelay,
    gateCheckStatus,
    reviewDecision,
    reviewRequested,
    currentHeadSha: pr.headRefOid,
    latestBlockingReviewHeadSha,
    mergeConflictDetected,
    reviewQuillAttempt,
  });

  if (pr.state === "MERGED" && issue.factoryState !== "done" && ageMs >= RECONCILIATION_GRACE_MS) {
    return {
      ciEntry,
      finding: {
        status: "fail",
        scope: "github:reconcile",
        message: "PR is already merged but the issue has not advanced to done",
      },
    };
  }

  if (pr.state === "CLOSED" && issue.factoryState !== "delegated" && issue.factoryState !== "done" && ageMs >= RECONCILIATION_GRACE_MS) {
    return {
      ciEntry,
      finding: {
        status: "fail",
        scope: "github:reconcile",
        message: "PR is closed but the issue is still waiting on PR state",
      },
    };
  }

  if (
    issue.delegatedToPatchRelay
    && gateCheckStatus === "failure"
    && issue.factoryState !== "repairing_ci"
    // Plan §6.1 / §4.3: branch CI failures while In Deploy are
    // metadata only — the lander's spec CI is the gate. Don't flag
    // these as a missing-ci-repair condition.
    && issue.factoryState !== "awaiting_queue"
    && issue.activeRunId === undefined
    && ageMs >= RECONCILIATION_GRACE_MS
  ) {
    // Plan §6.1: when the PR is also approved, this is the
    // "In Review · stuck at admission" condition — the lander would
    // accept the verdict but branch CI is red and (post-§4.3) we no
    // longer auto-repair. Keep the same scope/status pair so existing
    // dashboards continue to surface it; just sharpen the message.
    if (reviewDecision === "APPROVED") {
      return {
        ciEntry,
        finding: {
          status: "fail",
          scope: "github:ci",
          message: "In Review · stuck at admission — PR is approved but gate CI is red and no CI repair is running",
        },
      };
    }
    return {
      ciEntry,
      finding: {
        status: "fail",
        scope: "github:ci",
        message: "Gate CI is failing but no CI repair is running or queued",
      },
    };
  }

  if (reviewDecision === "APPROVED" && issue.factoryState !== "awaiting_queue" && issue.factoryState !== "done" && ageMs >= RECONCILIATION_GRACE_MS) {
    return {
      ciEntry,
      finding: {
        status: "fail",
        scope: "github:reconcile",
        message: "PR is approved but the issue has not handed off to downstream merge automation",
      },
    };
  }

  if (
    gateCheckStatus === "success"
    && reviewDecision === "CHANGES_REQUESTED"
    && mergeConflictDetected
    && issue.delegatedToPatchRelay
    && issue.factoryState !== "changes_requested"
    && issue.activeRunId === undefined
    && ageMs >= RECONCILIATION_GRACE_MS
  ) {
    return {
      ciEntry,
      finding: {
        status: "fail",
        scope: "github:branch-upkeep",
        message: "PR is still dirty after requested changes, but no branch-upkeep run is active",
      },
    };
  }

  if (
    gateCheckStatus === "success"
    && reviewDecision === "CHANGES_REQUESTED"
    && latestBlockingReviewHeadSha === pr.headRefOid
    && !reviewQuillAttempt
    && issue.delegatedToPatchRelay
    && issue.factoryState !== "changes_requested"
    && ageMs >= RECONCILIATION_GRACE_MS
  ) {
    return {
      ciEntry,
      finding: {
        status: "fail",
        scope: "github:review-handoff",
        message: "Requested changes still block the current head, but no review fix is running",
      },
    };
  }

  if (requestedReviewers.includes("review-quill") && reviewQuillProbe && reviewQuillProbe.status !== "pass") {
    return {
      ciEntry,
      finding: {
        status: "fail",
        scope: "github:review-automation",
        message: `PR is waiting on review-quill but the service is not healthy: ${reviewQuillProbe.message}`,
      },
    };
  }

  if (
    issue.delegatedToPatchRelay
    && issue.factoryState === "awaiting_queue"
    && mergeConflictDetected
    && issue.activeRunId === undefined
    && ageMs >= RECONCILIATION_GRACE_MS
  ) {
    return {
      ciEntry,
      finding: {
        status: "fail",
        scope: "github:queue",
        message: "PR has merge conflicts but no queue repair is running or queued",
      },
    };
  }

  if (issue.factoryState === "awaiting_queue" && mergeStewardProbe && mergeStewardProbe.status !== "pass" && ageMs >= RECONCILIATION_GRACE_MS) {
    return {
      ciEntry,
      finding: {
        status: "fail",
        scope: "github:queue",
        message: `Issue is waiting on downstream merge automation but merge-steward is not healthy: ${mergeStewardProbe.message}`,
      },
    };
  }

  return { ciEntry };
}
