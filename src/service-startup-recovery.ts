import type { Logger } from "pino";
import type { PatchRelayDatabase } from "./db.ts";
import { appendDelegationObservedEvent } from "./delegation-audit.ts";
import { deriveIssueSessionReactiveIntent } from "./issue-session.ts";
import type { LinearClientProvider } from "./types.ts";
import type { LinearSessionSync } from "./linear-session-sync.ts";
import { isResumablePausedLocalWork } from "./paused-issue-state.ts";

export class ServiceStartupRecovery {
  constructor(
    private readonly db: PatchRelayDatabase,
    private readonly linearProvider: LinearClientProvider,
    private readonly linearSync: LinearSessionSync,
    private readonly enqueueIssue: (projectId: string, issueId: string) => void,
    private readonly logger: Logger,
  ) {}

  async syncKnownAgentSessions(): Promise<void> {
    for (const issue of this.db.issues.listIssues()) {
      if (issue.factoryState === "done") {
        continue;
      }
      const syncedIssue = issue.agentSessionId
        ? issue
        : (() => {
            const recoveredAgentSessionId = this.db.webhookEvents.findLatestAgentSessionIdForIssue(issue.linearIssueId);
            return recoveredAgentSessionId
              ? this.db.issues.upsertIssue({
                  projectId: issue.projectId,
                  linearIssueId: issue.linearIssueId,
                  agentSessionId: recoveredAgentSessionId,
                })
              : issue;
          })();
      if (!syncedIssue.agentSessionId) {
        continue;
      }
      const activeRun = syncedIssue.activeRunId ? this.db.runs.getRunById(syncedIssue.activeRunId) : undefined;
      if (!activeRun) {
        continue;
      }
      await this.linearSync.syncSession(syncedIssue, { activeRunType: activeRun.runType });
    }
  }

  async recoverDelegatedIssueStateFromLinear(): Promise<void> {
    for (const issue of this.db.issues.listIssues()) {
      if (issue.factoryState === "done" || issue.activeRunId !== undefined) {
        continue;
      }
      const linear = await this.linearProvider.forProject(issue.projectId).catch(() => undefined);
      if (!linear) {
        continue;
      }
      const installation = this.db.linearInstallations.getLinearInstallationForProject(issue.projectId);
      if (!installation?.actorId) {
        continue;
      }

      const liveIssue = await linear.getIssue(issue.linearIssueId).catch(() => undefined);
      if (!liveIssue) {
        continue;
      }

      this.db.issues.replaceIssueDependencies({
        projectId: issue.projectId,
        linearIssueId: issue.linearIssueId,
        blockers: liveIssue.blockedBy.map((blocker) => ({
          blockerLinearIssueId: blocker.id,
          ...(blocker.identifier ? { blockerIssueKey: blocker.identifier } : {}),
          ...(blocker.title ? { blockerTitle: blocker.title } : {}),
          ...(blocker.stateName ? { blockerCurrentLinearState: blocker.stateName } : {}),
          ...(blocker.stateType ? { blockerCurrentLinearStateType: blocker.stateType } : {}),
        })),
      });

      const delegated = liveIssue.delegateId === installation.actorId;
      if (issue.delegatedToPatchRelay !== delegated) {
        appendDelegationObservedEvent(this.db, {
          projectId: issue.projectId,
          linearIssueId: issue.linearIssueId,
          payload: {
            source: "startup_recovery",
            actorId: installation.actorId,
            ...(liveIssue.delegateId ? { observedDelegateId: liveIssue.delegateId } : {}),
            previousDelegatedToPatchRelay: issue.delegatedToPatchRelay,
            observedDelegatedToPatchRelay: delegated,
            appliedDelegatedToPatchRelay: delegated,
            hydration: "live_linear",
            ...(issue.activeRunId !== undefined ? { activeRunId: issue.activeRunId } : {}),
            decision: delegated ? "resume_issue" : "none",
            reason: "startup_recovery_refreshed_linear_delegation",
          },
        });
      }
      const unresolvedBlockers = this.db.issues.countUnresolvedBlockers(issue.projectId, issue.linearIssueId);
      const latestRun = this.db.runs.getLatestRunForIssue(issue.projectId, issue.linearIssueId);
      const hasPendingWake = this.db.issueSessions.peekIssueSessionWake(issue.projectId, issue.linearIssueId) !== undefined;
      const shouldRecoverPausedLocalWork =
        delegated
        && isResumablePausedLocalWork({
          issue: {
            ...issue,
            delegatedToPatchRelay: delegated,
          },
          latestRun,
        })
        && !hasPendingWake;
      const reactiveIntent = delegated && !hasPendingWake
        ? deriveIssueSessionReactiveIntent({
            delegatedToPatchRelay: delegated,
            prNumber: issue.prNumber,
            prState: issue.prState,
            prIsDraft: issue.prIsDraft,
            prReviewState: issue.prReviewState,
            prCheckStatus: issue.prCheckStatus,
            latestFailureSource: issue.lastGitHubFailureSource,
          })
        : undefined;
      const shouldRecoverReactivePrWork =
        delegated
        && issue.prNumber !== undefined
        && reactiveIntent !== undefined;

      const updated = this.db.issues.upsertIssue({
        projectId: issue.projectId,
        linearIssueId: issue.linearIssueId,
        delegatedToPatchRelay: delegated,
        ...(liveIssue.identifier ? { issueKey: liveIssue.identifier } : {}),
        ...(liveIssue.title ? { title: liveIssue.title } : {}),
        ...(liveIssue.description ? { description: liveIssue.description } : {}),
        ...(liveIssue.url ? { url: liveIssue.url } : {}),
        ...(liveIssue.priority != null ? { priority: liveIssue.priority } : {}),
        ...(liveIssue.estimate != null ? { estimate: liveIssue.estimate } : {}),
        ...(liveIssue.stateName ? { currentLinearState: liveIssue.stateName } : {}),
        ...(liveIssue.stateType ? { currentLinearStateType: liveIssue.stateType } : {}),
        ...(shouldRecoverPausedLocalWork
          ? { factoryState: "delegated" as never }
          : shouldRecoverReactivePrWork
            ? { factoryState: reactiveIntent.compatibilityFactoryState }
            : {}),
      });

      if (!shouldRecoverPausedLocalWork && !shouldRecoverReactivePrWork) {
        continue;
      }

      if (unresolvedBlockers === 0) {
        if (shouldRecoverReactivePrWork && reactiveIntent) {
          this.appendReactiveWakeEvent(issue.projectId, issue.linearIssueId, issue, reactiveIntent.runType);
        } else {
          this.db.issueSessions.appendIssueSessionEventRespectingActiveLease(issue.projectId, issue.linearIssueId, {
            projectId: issue.projectId,
            linearIssueId: issue.linearIssueId,
            eventType: "delegated",
            dedupeKey: `delegated:${issue.linearIssueId}`,
          });
        }
        if (this.db.issueSessions.peekIssueSessionWake(issue.projectId, issue.linearIssueId)) {
          this.enqueueIssue(issue.projectId, issue.linearIssueId);
        }
        this.logger.info(
          {
            issueKey: updated.issueKey,
            ...(shouldRecoverReactivePrWork && reactiveIntent ? { runType: reactiveIntent.runType } : {}),
          },
          shouldRecoverReactivePrWork
            ? "Recovered delegated PR issue from reactive paused state and re-queued follow-up work"
            : "Recovered delegated issue from paused local-work state and re-queued implementation",
        );
      } else {
        this.logger.info(
          {
            issueKey: updated.issueKey,
            unresolvedBlockers,
            ...(shouldRecoverReactivePrWork && reactiveIntent ? { runType: reactiveIntent.runType } : {}),
          },
          shouldRecoverReactivePrWork
            ? "Recovered delegated blocked PR issue from reactive paused state"
            : "Recovered delegated blocked issue from paused local-work state",
        );
      }
    }
  }

  private appendReactiveWakeEvent(
    projectId: string,
    linearIssueId: string,
    issue: { prHeadSha?: string | undefined; lastGitHubFailureHeadSha?: string | undefined; lastGitHubFailureSignature?: string | undefined },
    runType: "review_fix" | "branch_upkeep" | "ci_repair" | "queue_repair",
  ): void {
    const eventType = runType === "queue_repair"
      ? "merge_steward_incident"
      : runType === "ci_repair"
        ? "settled_red_ci"
        : "review_changes_requested";
    const dedupeKey = runType === "queue_repair"
      ? `startup_recovery:queue_repair:${linearIssueId}:${issue.lastGitHubFailureSignature ?? issue.prHeadSha ?? issue.lastGitHubFailureHeadSha ?? "unknown"}`
      : runType === "ci_repair"
        ? `startup_recovery:ci_repair:${linearIssueId}:${issue.lastGitHubFailureSignature ?? issue.prHeadSha ?? issue.lastGitHubFailureHeadSha ?? "unknown"}`
        : `startup_recovery:${runType}:${linearIssueId}:${issue.prHeadSha ?? "unknown"}`;

    this.db.issueSessions.appendIssueSessionEventRespectingActiveLease(projectId, linearIssueId, {
      projectId,
      linearIssueId,
      eventType,
      dedupeKey,
    });
  }
}
