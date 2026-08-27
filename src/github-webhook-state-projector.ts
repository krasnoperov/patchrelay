import type { Logger } from "pino";
import type { IssueRecord } from "./db-types.ts";
import type { PatchRelayDatabase } from "./db.ts";
import { CLEARED_FAILURE_PROVENANCE } from "./failure-provenance.ts";
import { createGitHubCiSnapshotResolver, createGitHubFailureContextResolver, type GitHubCiSnapshotResolver, type GitHubFailureContextResolver } from "./github-failure-context.ts";
import type { NormalizedGitHubEvent } from "./github-types.ts";
import { buildClosedPrCleanupFields } from "./pr-state.ts";
import type { AppConfig, LinearClientProvider } from "./types.ts";
import type { OperatorEventFeed } from "./operator-feed.ts";
import type { ProjectConfig } from "./workflow-types.ts";
import {
  canClearFailureProvenance,
  deriveImmediatePrCheckStatus,
  getGateCheckNames,
  getPrimaryGateCheckName,
  isGateCheckEvent,
  isMetadataOnlyCheckEvent,
  isQueueEvictionFailure,
  isStaleGateEvent,
  isSettledBranchFailure,
} from "./github-webhook-policy.ts";
import {
  buildGitHubQueueFailureContext,
  resolveGitHubBranchFailureContext,
} from "./github-webhook-failure-context.ts";
import {
  emitGitHubLinearActivity,
  syncGitHubLinearDeliveryPr,
  syncGitHubLinearSession,
} from "./github-linear-session-sync.ts";
import { buildQueueRepairContextFromEvent } from "./merge-queue-incident.ts";
import { deriveIssuePhase } from "./issue-phase.ts";

const WRITER = "github-webhook-state-projector";

export interface GitHubWebhookStateProjectorDeps {
  config: AppConfig;
  db: PatchRelayDatabase;
  linearProvider: LinearClientProvider;
  logger: Logger;
  feed: OperatorEventFeed | undefined;
  failureContextResolver?: GitHubFailureContextResolver;
  ciSnapshotResolver?: GitHubCiSnapshotResolver;
}

export async function projectGitHubWebhookState(
  deps: GitHubWebhookStateProjectorDeps,
  issue: IssueRecord,
  event: NormalizedGitHubEvent,
  project?: ProjectConfig,
  linkedBy?: "pr" | "branch" | "issue_key",
): Promise<IssueRecord> {
  const failureContextResolver = deps.failureContextResolver ?? createGitHubFailureContextResolver();
  const ciSnapshotResolver = deps.ciSnapshotResolver ?? createGitHubCiSnapshotResolver();
  const immediateCheckStatus = deriveImmediatePrCheckStatus(issue, event, project);

  // Cache a stacked PR's parent branch; clear it after retargeting or close.
  const parentPrBranch = computeParentPrBranchUpdate(event, project);

  // Unconditional commit: every field below is a fact carried by the webhook
  // payload itself, not derived from a prior read of the issue row.
  deps.db.issueSessions.commitIssueState({
    writer: WRITER,
    update: {
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      ...(event.prNumber !== undefined ? { prNumber: event.prNumber } : {}),
      ...(event.prUrl !== undefined ? { prUrl: event.prUrl } : {}),
      ...(event.prState !== undefined ? { prState: event.prState } : {}),
      ...(event.headSha !== undefined ? { prHeadSha: event.headSha } : {}),
      ...(event.prAuthorLogin !== undefined ? { prAuthorLogin: event.prAuthorLogin } : {}),
      ...(event.reviewState !== undefined ? { prReviewState: event.reviewState } : {}),
      ...(immediateCheckStatus !== undefined ? { prCheckStatus: immediateCheckStatus } : {}),
      ...(linkedBy === "issue_key" ? { branchName: event.branchName } : {}),
      ...(parentPrBranch !== undefined ? { parentPrBranch } : {}),
      ...(event.reviewState === "changes_requested"
        ? { lastBlockingReviewHeadSha: event.reviewCommitId ?? event.headSha ?? null }
        : event.reviewState === "approved"
          ? { lastBlockingReviewHeadSha: null }
          : {}),
      ...(event.triggerEvent === "pr_closed"
        ? buildClosedPrCleanupFields()
        : {}),
    },
  });
  await updateGitHubCiSnapshot(deps, issue, event, project, ciSnapshotResolver);
  await updateGitHubFailureProvenance(deps, issue, event, project, failureContextResolver);

  const afterMetadata = deps.db.issues.getIssue(issue.projectId, issue.linearIssueId) ?? issue;
  const activeRun = afterMetadata.activeRunId
    ? deps.db.runs.getRunById(afterMetadata.activeRunId)
    : undefined;
  maybeSupersedeActiveRun({ db: deps.db, logger: deps.logger, feed: deps.feed, issue: afterMetadata, event, activeRun });

  if (!isMetadataOnlyCheckEvent(event) || isQueueEvictionFailure(issue, event, project)) {
    void emitGitHubLinearActivity({
      linearProvider: deps.linearProvider,
      logger: deps.logger,
      feed: deps.feed,
      issue: afterMetadata,
      phase: deriveIssuePhase({ ...afterMetadata, activeRunType: activeRun?.runType }),
      event,
    });
    void syncGitHubLinearSession({
      config: deps.config,
      linearProvider: deps.linearProvider,
      logger: deps.logger,
      issue: afterMetadata,
    });
  }

  const freshIssue = deps.db.issues.getIssue(issue.projectId, issue.linearIssueId) ?? issue;

  // A PR-opened webhook resolved to this issue is a proven linkage event. Keep
  // this separate from generic session sync so stale cached PR fields can never
  // turn an ordinary evidence attachment into PatchRelay's delivery PR.
  if (event.triggerEvent === "pr_opened") {
    void syncGitHubLinearDeliveryPr({
      linearProvider: deps.linearProvider,
      logger: deps.logger,
      issue: freshIssue,
    });
  }

  if (event.triggerEvent === "pr_synchronize" && !freshIssue.activeRunId) {
    // A push always resets the repair budgets and the CI snapshot for the new
    // head; failure provenance is only cleared when the pushed head actually
    // supersedes the recorded failure (`mayClearFailureProvenance`).
    deps.db.issueSessions.commitIssueState({
      writer: WRITER,
      update: {
        projectId: issue.projectId,
        linearIssueId: issue.linearIssueId,
        ciRepairAttempts: 0,
        queueRepairAttempts: 0,
        ...(canClearFailureProvenance(freshIssue, event, project) ? CLEARED_FAILURE_PROVENANCE : {}),
        lastGitHubCiSnapshotHeadSha: event.headSha ?? null,
        lastGitHubCiSnapshotGateCheckName: getPrimaryGateCheckName(project),
        lastGitHubCiSnapshotGateCheckStatus: "pending",
        lastGitHubCiSnapshotJson: null,
        lastGitHubCiSnapshotSettledAt: null,
      },
    });
  }

  deps.logger.info(
    { issueKey: issue.issueKey, branchName: event.branchName, triggerEvent: event.triggerEvent, prNumber: event.prNumber },
    "GitHub webhook: updated issue PR state",
  );

  deps.feed?.publish({
    level: event.triggerEvent.includes("failed") ? "warn" : "info",
    kind: "github",
    issueKey: freshIssue.issueKey,
    projectId: freshIssue.projectId,
    stage: deriveIssuePhase({ ...freshIssue, activeRunType: activeRun?.runType }),
    status: event.triggerEvent,
    summary: `GitHub: ${event.triggerEvent}${event.prNumber ? ` on PR #${event.prNumber}` : ""}`,
    detail: event.checkName ?? event.reviewBody?.slice(0, 200) ?? undefined,
  });

  return freshIssue;
}

// `undefined` preserves the cached parent; `null` clears it.
function computeParentPrBranchUpdate(
  event: NormalizedGitHubEvent,
  project: ProjectConfig | undefined,
): string | null | undefined {
  if (event.triggerEvent === "pr_closed" || event.triggerEvent === "pr_merged") {
    return null;
  }
  if (event.prBaseRef === undefined) {
    return undefined;
  }
  const repoDefault = project?.github?.baseBranch ?? "main";
  if (!event.prBaseRef || event.prBaseRef === repoDefault) {
    return null;
  }
  return event.prBaseRef;
}

// Approval invalidates an active review fix; suppress any late publication.
function maybeSupersedeActiveRun(params: {
  db: PatchRelayDatabase;
  logger: Logger;
  feed: OperatorEventFeed | undefined;
  issue: IssueRecord;
  event: NormalizedGitHubEvent;
  activeRun: { id: number; runType?: string | undefined; sourceHeadSha?: string | undefined } | undefined;
}): void {
  const { db, logger, feed, issue, event, activeRun } = params;
  if (event.triggerEvent !== "review_approved") return;
  if (!activeRun) return;
  if (activeRun.runType !== "review_fix") return;

  const approvalHead = event.reviewCommitId ?? event.headSha;
  if (!approvalHead || !activeRun.sourceHeadSha) return;
  if (approvalHead !== activeRun.sourceHeadSha) return;

  db.runs.markSuperseded(activeRun.id, {
    reason: "approved on the same head; further publication suppressed",
  });
  logger.info(
    {
      issueKey: issue.issueKey,
      runId: activeRun.id,
      headSha: approvalHead,
    },
    "Superseded mid-run review_fix after approval landed on the same head",
  );
  feed?.publish({
    level: "info",
    kind: "agent",
    summary: `Superseded review_fix run #${activeRun.id} — PR approved on the same head`,
    ...(issue.issueKey ? { issueKey: issue.issueKey } : {}),
    ...(issue.projectId ? { projectId: issue.projectId } : {}),
  });
}

async function updateGitHubCiSnapshot(
  deps: GitHubWebhookStateProjectorDeps,
  issue: IssueRecord,
  event: NormalizedGitHubEvent,
  project: ProjectConfig | undefined,
  ciSnapshotResolver: GitHubCiSnapshotResolver,
): Promise<void> {
  if (event.triggerEvent === "pr_merged") {
    deps.db.issueSessions.commitIssueState({
      writer: WRITER,
      update: {
        projectId: issue.projectId,
        linearIssueId: issue.linearIssueId,
        lastGitHubCiSnapshotHeadSha: null,
        lastGitHubCiSnapshotGateCheckName: null,
        lastGitHubCiSnapshotGateCheckStatus: null,
        lastGitHubCiSnapshotJson: null,
        lastGitHubCiSnapshotSettledAt: null,
      },
    });
    return;
  }

  if (event.triggerEvent === "pr_synchronize") {
    deps.db.issueSessions.commitIssueState({
      writer: WRITER,
      update: {
        projectId: issue.projectId,
        linearIssueId: issue.linearIssueId,
        prCheckStatus: "pending",
        lastGitHubCiSnapshotHeadSha: event.headSha ?? null,
        lastGitHubCiSnapshotGateCheckName: getPrimaryGateCheckName(project),
        lastGitHubCiSnapshotGateCheckStatus: "pending",
        lastGitHubCiSnapshotJson: null,
        lastGitHubCiSnapshotSettledAt: null,
      },
    });
    return;
  }

  if (issue.prState !== "open") return;
  if (event.eventSource !== "check_run" && event.eventSource !== "check_suite") return;
  if (isQueueEvictionFailure(issue, event, project)) return;
  if (!isGateCheckEvent(event, project)) return;
  if (isStaleGateEvent(issue, event)) return;
  if (event.triggerEvent === "check_pending") {
    deps.db.issueSessions.commitIssueState({
      writer: WRITER,
      update: {
        projectId: issue.projectId,
        linearIssueId: issue.linearIssueId,
        prCheckStatus: "pending",
        lastGitHubCiSnapshotHeadSha: event.headSha ?? issue.lastGitHubCiSnapshotHeadSha ?? null,
        lastGitHubCiSnapshotGateCheckName: event.checkName ?? getPrimaryGateCheckName(project),
        lastGitHubCiSnapshotGateCheckStatus: "pending",
        lastGitHubCiSnapshotJson: null,
        lastGitHubCiSnapshotSettledAt: null,
      },
    });
    return;
  }

  // Version read just before the async snapshot resolution: a conflict on the
  // write below means another writer landed while we were calling GitHub.
  const preResolveVersion = (deps.db.issues.getIssue(issue.projectId, issue.linearIssueId) ?? issue).version;
  const snapshot = await ciSnapshotResolver.resolve({
    repoFullName: project?.github?.repoFullName ?? event.repoFullName,
    event,
    gateCheckNames: getGateCheckNames(project),
  });
  if (!snapshot) {
    deps.db.issueSessions.commitIssueState({
      writer: WRITER,
      expectedVersion: preResolveVersion,
      update: {
        projectId: issue.projectId,
        linearIssueId: issue.linearIssueId,
        ...(event.triggerEvent === "check_failed"
          ? { prCheckStatus: "pending" }
          : event.triggerEvent === "check_passed"
            ? { prCheckStatus: "success" }
            : {}),
        lastGitHubCiSnapshotHeadSha: event.headSha ?? issue.lastGitHubCiSnapshotHeadSha ?? null,
        lastGitHubCiSnapshotGateCheckName: getPrimaryGateCheckName(project),
        lastGitHubCiSnapshotGateCheckStatus: "pending",
        lastGitHubCiSnapshotJson: null,
        lastGitHubCiSnapshotSettledAt: null,
      },
    });
    deps.logger.warn(
      { issueKey: issue.issueKey, repoFullName: project?.github?.repoFullName ?? event.repoFullName, headSha: event.headSha },
      "Could not resolve settled CI snapshot; waiting before CI repair",
    );
    deps.feed?.publish({
      level: "warn",
      kind: "github",
      issueKey: issue.issueKey,
      projectId: issue.projectId,
      stage: "ci_repair",
      status: "ci_snapshot_unavailable",
      summary: `Could not resolve settled ${getPrimaryGateCheckName(project)} snapshot; waiting before CI repair`,
    });
    return;
  }

  const gateCheckStatus = event.triggerEvent === "check_passed" && snapshot.gateCheckStatus === "pending"
    ? "success"
    : snapshot.gateCheckStatus;
  deps.db.issueSessions.commitIssueState({
    writer: WRITER,
    expectedVersion: preResolveVersion,
    update: {
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      prCheckStatus: gateCheckStatus,
      lastGitHubCiSnapshotHeadSha: snapshot.headSha,
      lastGitHubCiSnapshotGateCheckName: snapshot.gateCheckName ?? getPrimaryGateCheckName(project),
      lastGitHubCiSnapshotGateCheckStatus: gateCheckStatus,
      lastGitHubCiSnapshotJson: JSON.stringify(snapshot),
      lastGitHubCiSnapshotSettledAt: snapshot.settledAt ?? null,
    },
  });
}

async function updateGitHubFailureProvenance(
  deps: GitHubWebhookStateProjectorDeps,
  issue: IssueRecord,
  event: NormalizedGitHubEvent,
  project: ProjectConfig | undefined,
  failureContextResolver: GitHubFailureContextResolver,
): Promise<void> {
  const isQueueEvictionCheck = isQueueEvictionFailure(issue, event, project);

  if (event.triggerEvent === "check_failed" && issue.prState === "open") {
    const source = isQueueEvictionCheck
      ? "queue_eviction"
      : "branch_ci";
    if (source === "branch_ci" && !isSettledBranchFailure(deps.db, issue, event, project)) {
      return;
    }
    // Version read before the (possibly async) failure-context resolution.
    const preResolveVersion = (deps.db.issues.getIssue(issue.projectId, issue.linearIssueId) ?? issue).version;
    const failureContext = source === "queue_eviction"
      ? buildGitHubQueueFailureContext(event, project, buildQueueRepairContextFromEvent(event))
      : await resolveGitHubBranchFailureContext({
          db: deps.db,
          issue,
          event,
          project,
          failureContextResolver,
        });
    deps.db.issueSessions.commitIssueState({
      writer: WRITER,
      expectedVersion: preResolveVersion,
      update: {
        projectId: issue.projectId,
        linearIssueId: issue.linearIssueId,
        lastGitHubFailureSource: source,
        lastGitHubFailureHeadSha: failureContext.failureHeadSha ?? event.headSha ?? null,
        lastGitHubFailureSignature: failureContext.failureSignature ?? null,
        lastGitHubFailureCheckName: failureContext.checkName ?? event.checkName ?? null,
        lastGitHubFailureCheckUrl: failureContext.checkUrl ?? event.checkUrl ?? null,
        lastGitHubFailureContextJson: JSON.stringify(failureContext),
        lastGitHubFailureAt: new Date().toISOString(),
        ...(source === "queue_eviction"
          ? {
              lastQueueSignalAt: new Date().toISOString(),
              lastQueueIncidentJson: JSON.stringify(buildQueueRepairContextFromEvent(event)),
            }
          : {
              lastQueueIncidentJson: null,
            }),
      },
    });
    return;
  }

  if (
    (event.triggerEvent === "check_passed" && (!isMetadataOnlyCheckEvent(event) || isQueueEvictionFailure(issue, event, project) || isGateCheckEvent(event, project)))
    || event.triggerEvent === "pr_synchronize"
    || event.triggerEvent === "pr_merged"
  ) {
    if (!canClearFailureProvenance(issue, event, project)) {
      return;
    }
    deps.db.issueSessions.commitIssueState({
      writer: WRITER,
      update: {
        projectId: issue.projectId,
        linearIssueId: issue.linearIssueId,
        ...CLEARED_FAILURE_PROVENANCE,
      },
    });
  }
}
