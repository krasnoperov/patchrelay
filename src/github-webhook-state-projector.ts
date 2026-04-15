import type { Logger } from "pino";
import type { IssueRecord } from "./db-types.ts";
import type { PatchRelayDatabase } from "./db.ts";
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
  resolveGitHubFactoryStateForEvent,
} from "./github-webhook-policy.ts";
import {
  buildGitHubQueueFailureContext,
  resolveGitHubBranchFailureContext,
} from "./github-webhook-failure-context.ts";
import { emitGitHubLinearActivity, syncGitHubLinearSession } from "./github-linear-session-sync.ts";
import { buildQueueRepairContextFromEvent } from "./merge-queue-incident.ts";

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

  deps.db.issues.upsertIssue({
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
    ...(event.reviewState === "changes_requested"
      ? { lastBlockingReviewHeadSha: event.reviewCommitId ?? event.headSha ?? null }
      : event.reviewState === "approved"
        ? { lastBlockingReviewHeadSha: null }
        : {}),
    ...(event.triggerEvent === "pr_closed"
      ? buildClosedPrCleanupFields()
      : {}),
  });
  await updateGitHubCiSnapshot(deps, issue, event, project, ciSnapshotResolver);
  await updateGitHubFailureProvenance(deps, issue, event, project, failureContextResolver);

  const queueEvictionCheck = isQueueEvictionFailure(issue, event, project);

  if (!isMetadataOnlyCheckEvent(event) || queueEvictionCheck) {
    const afterMetadata = deps.db.issues.getIssue(issue.projectId, issue.linearIssueId) ?? issue;
    const newState = resolveGitHubFactoryStateForEvent(afterMetadata, event, project);

    if (newState && newState !== afterMetadata.factoryState) {
      deps.db.issueSessions.upsertIssueRespectingActiveLease(issue.projectId, issue.linearIssueId, {
        projectId: issue.projectId,
        linearIssueId: issue.linearIssueId,
        factoryState: newState,
      });
      deps.logger.info(
        { issueKey: issue.issueKey, from: afterMetadata.factoryState, to: newState, trigger: event.triggerEvent },
        "Factory state transition from GitHub event",
      );

      const transitionedIssue = deps.db.issues.getIssue(issue.projectId, issue.linearIssueId) ?? issue;
      void emitGitHubLinearActivity({
        linearProvider: deps.linearProvider,
        logger: deps.logger,
        feed: deps.feed,
        issue: transitionedIssue,
        newState,
        event,
      });
      void syncGitHubLinearSession({
        config: deps.config,
        linearProvider: deps.linearProvider,
        logger: deps.logger,
        issue: transitionedIssue,
      });
    }
  }

  const freshIssue = deps.db.issues.getIssue(issue.projectId, issue.linearIssueId) ?? issue;

  if (event.triggerEvent === "pr_synchronize" && !freshIssue.activeRunId) {
    deps.db.issueSessions.upsertIssueRespectingActiveLease(issue.projectId, issue.linearIssueId, {
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      ciRepairAttempts: 0,
      queueRepairAttempts: 0,
      lastGitHubFailureSource: null,
      lastGitHubFailureHeadSha: null,
      lastGitHubFailureSignature: null,
      lastGitHubFailureCheckName: null,
      lastGitHubFailureCheckUrl: null,
      lastGitHubFailureContextJson: null,
      lastGitHubFailureAt: null,
      lastGitHubCiSnapshotHeadSha: event.headSha ?? null,
      lastGitHubCiSnapshotGateCheckName: getPrimaryGateCheckName(project),
      lastGitHubCiSnapshotGateCheckStatus: "pending",
      lastGitHubCiSnapshotJson: null,
      lastGitHubCiSnapshotSettledAt: null,
      lastQueueIncidentJson: null,
      lastAttemptedFailureHeadSha: null,
      lastAttemptedFailureSignature: null,
      lastAttemptedFailureAt: null,
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
    stage: freshIssue.factoryState,
    status: event.triggerEvent,
    summary: `GitHub: ${event.triggerEvent}${event.prNumber ? ` on PR #${event.prNumber}` : ""}`,
    detail: event.checkName ?? event.reviewBody?.slice(0, 200) ?? undefined,
  });

  return freshIssue;
}

async function updateGitHubCiSnapshot(
  deps: GitHubWebhookStateProjectorDeps,
  issue: IssueRecord,
  event: NormalizedGitHubEvent,
  project: ProjectConfig | undefined,
  ciSnapshotResolver: GitHubCiSnapshotResolver,
): Promise<void> {
  if (event.triggerEvent === "pr_merged") {
    deps.db.issues.upsertIssue({
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      lastGitHubCiSnapshotHeadSha: null,
      lastGitHubCiSnapshotGateCheckName: null,
      lastGitHubCiSnapshotGateCheckStatus: null,
      lastGitHubCiSnapshotJson: null,
      lastGitHubCiSnapshotSettledAt: null,
    });
    return;
  }

  if (event.triggerEvent === "pr_synchronize") {
    deps.db.issues.upsertIssue({
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      prCheckStatus: "pending",
      lastGitHubCiSnapshotHeadSha: event.headSha ?? null,
      lastGitHubCiSnapshotGateCheckName: getPrimaryGateCheckName(project),
      lastGitHubCiSnapshotGateCheckStatus: "pending",
      lastGitHubCiSnapshotJson: null,
      lastGitHubCiSnapshotSettledAt: null,
    });
    return;
  }

  if (issue.prState !== "open") return;
  if (event.eventSource !== "check_run" && event.eventSource !== "check_suite") return;
  if (isQueueEvictionFailure(issue, event, project)) return;
  if (!isGateCheckEvent(event, project)) return;
  if (isStaleGateEvent(issue, event)) return;
  if (event.triggerEvent === "check_pending") {
    deps.db.issues.upsertIssue({
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      prCheckStatus: "pending",
      lastGitHubCiSnapshotHeadSha: event.headSha ?? issue.lastGitHubCiSnapshotHeadSha ?? null,
      lastGitHubCiSnapshotGateCheckName: event.checkName ?? getPrimaryGateCheckName(project),
      lastGitHubCiSnapshotGateCheckStatus: "pending",
      lastGitHubCiSnapshotJson: null,
      lastGitHubCiSnapshotSettledAt: null,
    });
    return;
  }

  const snapshot = await ciSnapshotResolver.resolve({
    repoFullName: project?.github?.repoFullName ?? event.repoFullName,
    event,
    gateCheckNames: getGateCheckNames(project),
  });
  if (!snapshot) {
    deps.db.issues.upsertIssue({
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      lastGitHubCiSnapshotHeadSha: event.headSha ?? issue.lastGitHubCiSnapshotHeadSha ?? null,
      lastGitHubCiSnapshotGateCheckName: getPrimaryGateCheckName(project),
      lastGitHubCiSnapshotGateCheckStatus: "pending",
      lastGitHubCiSnapshotJson: null,
      lastGitHubCiSnapshotSettledAt: null,
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
      stage: issue.factoryState,
      status: "ci_snapshot_unavailable",
      summary: `Could not resolve settled ${getPrimaryGateCheckName(project)} snapshot; waiting before CI repair`,
    });
    return;
  }

  deps.db.issues.upsertIssue({
    projectId: issue.projectId,
    linearIssueId: issue.linearIssueId,
    prCheckStatus: snapshot.gateCheckStatus,
    lastGitHubCiSnapshotHeadSha: snapshot.headSha,
    lastGitHubCiSnapshotGateCheckName: snapshot.gateCheckName ?? getPrimaryGateCheckName(project),
    lastGitHubCiSnapshotGateCheckStatus: snapshot.gateCheckStatus,
    lastGitHubCiSnapshotJson: JSON.stringify(snapshot),
    lastGitHubCiSnapshotSettledAt: snapshot.settledAt ?? null,
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
    const failureContext = source === "queue_eviction"
      ? buildGitHubQueueFailureContext(event, project, buildQueueRepairContextFromEvent(event))
      : await resolveGitHubBranchFailureContext({
          db: deps.db,
          issue,
          event,
          project,
          failureContextResolver,
        });
    deps.db.issues.upsertIssue({
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
    });
    return;
  }

  if (
    (event.triggerEvent === "check_passed" && (!isMetadataOnlyCheckEvent(event) || isQueueEvictionFailure(issue, event, project) || isGateCheckEvent(event, project)))
    || event.triggerEvent === "pr_synchronize"
    || event.triggerEvent === "pr_merged"
  ) {
    if (event.triggerEvent === "check_passed" && !canClearFailureProvenance(issue, event, project)) {
      return;
    }
    deps.db.issues.upsertIssue({
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      lastGitHubFailureSource: null,
      lastGitHubFailureHeadSha: null,
      lastGitHubFailureSignature: null,
      lastGitHubFailureCheckName: null,
      lastGitHubFailureCheckUrl: null,
      lastGitHubFailureContextJson: null,
      lastGitHubFailureAt: null,
      lastQueueIncidentJson: null,
      lastAttemptedFailureHeadSha: null,
      lastAttemptedFailureSignature: null,
      lastAttemptedFailureAt: null,
    });
  }
}
