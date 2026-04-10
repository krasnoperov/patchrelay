import type { Logger } from "pino";
import type { PatchRelayDatabase } from "./db.ts";
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
      await this.linearSync.syncSession(syncedIssue, activeRun ? { activeRunType: activeRun.runType } : undefined);
    }
  }

  async recoverDelegatedIssueStateFromLinear(): Promise<void> {
    for (const issue of this.db.issues.listIssuesWithAgentSessions()) {
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
      const unresolvedBlockers = this.db.issues.countUnresolvedBlockers(issue.projectId, issue.linearIssueId);
      const latestRun = this.db.runs.getLatestRunForIssue(issue.projectId, issue.linearIssueId);
      const shouldRecoverPausedLocalWork =
        delegated
        && isResumablePausedLocalWork({ issue, latestRun })
        && this.db.issueSessions.peekIssueSessionWake(issue.projectId, issue.linearIssueId) === undefined;

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
        ...(shouldRecoverPausedLocalWork ? { factoryState: "delegated" as never } : {}),
      });

      if (!shouldRecoverPausedLocalWork) {
        continue;
      }

      if (unresolvedBlockers === 0) {
        this.db.issueSessions.appendIssueSessionEventRespectingActiveLease(issue.projectId, issue.linearIssueId, {
          projectId: issue.projectId,
          linearIssueId: issue.linearIssueId,
          eventType: "delegated",
          dedupeKey: `delegated:${issue.linearIssueId}`,
        });
        if (this.db.issueSessions.peekIssueSessionWake(issue.projectId, issue.linearIssueId)) {
          this.enqueueIssue(issue.projectId, issue.linearIssueId);
        }
        this.logger.info({ issueKey: updated.issueKey }, "Recovered delegated issue from paused local-work state and re-queued implementation");
      } else {
        this.logger.info({ issueKey: updated.issueKey, unresolvedBlockers }, "Recovered delegated blocked issue from paused local-work state");
      }
    }
  }
}
