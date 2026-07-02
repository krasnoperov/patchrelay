import type { Logger } from "pino";
import type { PatchRelayDatabase } from "./db.ts";
import { appendDelegationObservedEvent } from "./delegation-audit.ts";
import { deriveIssueSessionReactiveIntent } from "./issue-session.ts";
import type { IssueSessionLeaseService } from "./issue-session-lease-service.ts";
import { hasPendingWake as computeHasPendingWake } from "./pending-wake.ts";
import { RunWakePlanner } from "./run-wake-planner.ts";
import type { AppConfig, LinearClientProvider, LinearIssueSnapshot, ProjectConfig } from "./types.ts";
import type { LinearSessionSync } from "./linear-session-sync.ts";
import { isResumablePausedLocalWork } from "./paused-issue-state.ts";
import { upsertLinearIssueProjection } from "./linear-issue-projection.ts";
import { reconcileWorkflowTasksForIssue } from "./workflow-task-reconciler.ts";

const WRITER = "service-startup-recovery";

export class ServiceStartupRecovery {
  private readonly runWakePlanner: RunWakePlanner;

  constructor(
    private readonly config: AppConfig,
    private readonly db: PatchRelayDatabase,
    private readonly linearProvider: LinearClientProvider,
    private readonly linearSync: LinearSessionSync,
    private readonly enqueueIssue: (projectId: string, issueId: string) => void,
    private readonly logger: Logger,
    private readonly leaseService: IssueSessionLeaseService,
  ) {
    this.runWakePlanner = new RunWakePlanner(db, logger);
  }

  async syncKnownAgentSessions(): Promise<void> {
    for (const issue of this.db.issues.listIssuesWithActiveRun()) {
      if (issue.factoryState === "done") {
        continue;
      }
      if (!issue.activeRunId) {
        continue;
      }
      const syncedIssue = issue.agentSessionId
        ? issue
        : (() => {
            const recoveredAgentSessionId = this.db.webhookEvents.findLatestAgentSessionIdForIssue(issue.linearIssueId);
            if (!recoveredAgentSessionId) return issue;
            const commit = this.db.issueSessions.commitIssueState({
              writer: WRITER,
              update: {
                projectId: issue.projectId,
                linearIssueId: issue.linearIssueId,
                agentSessionId: recoveredAgentSessionId,
              },
            });
            return commit.outcome === "applied" ? commit.issue : issue;
          })();
      if (!syncedIssue.agentSessionId) {
        continue;
      }
      const activeRunId = syncedIssue.activeRunId;
      if (!activeRunId) {
        continue;
      }
      const activeRun = this.db.runs.getRunById(activeRunId);
      if (!activeRun) {
        continue;
      }
      await this.linearSync.syncSession(syncedIssue, { activeRunType: activeRun.runType });
    }
  }

  reconcileKnownWorkflowTasks(): void {
    this.drainLegacyPendingRunColumns();
    let opened = 0;
    let updated = 0;
    let closed = 0;
    for (const issue of this.db.issues.listWorkflowTaskReconcileCandidates()) {
      const reconciliation = reconcileWorkflowTasksForIssue(this.db, issue);
      opened += reconciliation.result.opened.length;
      updated += reconciliation.result.updated.length;
      closed += reconciliation.result.closed.length;
    }
    if (opened > 0 || updated > 0 || closed > 0) {
      this.logger.info({ opened, updated, closed }, "Reconciled durable workflow tasks from local issue truth");
    }
  }

  /**
   * S6 drain: every legacy writer now routes intent through durable
   * observations + workflow tasks, but existing rows may still carry a
   * `pending_run_type` / `pending_run_context_json` value. For each, synthesize
   * the equivalent session event via the shared
   * {@link RunWakePlanner.materializeLegacyPendingWake} logic (which also nulls
   * the columns), then reconcile so a runnable workflow task materializes from
   * the issue facts. Idempotent — runs every startup; a second pass finds no
   * rows once the columns are drained. This is what makes S7's live-DB zero-row
   * check (`pending_run_type IS NULL` everywhere) hold.
   */
  private drainLegacyPendingRunColumns(): void {
    const pending = this.db.issues.listIssuesWithPendingRunType();
    if (pending.length === 0) return;
    let drained = 0;
    for (const issue of pending) {
      if (!issue.pendingRunType) continue;
      // A fresh lease gates the session-event append + column-null commit inside
      // materializeLegacyPendingWake. If the issue is actively leased elsewhere,
      // skip it this pass — the next startup drains it.
      const leaseId = this.leaseService.acquire(issue.projectId, issue.linearIssueId);
      if (!leaseId) continue;
      try {
        const after = this.runWakePlanner.materializeLegacyPendingWake(issue, {
          projectId: issue.projectId,
          linearIssueId: issue.linearIssueId,
          leaseId,
        });
        const refreshed = this.db.issues.getIssue(issue.projectId, issue.linearIssueId) ?? after;
        reconcileWorkflowTasksForIssue(this.db, refreshed);
        if (!refreshed.pendingRunType) drained += 1;
      } catch (error) {
        this.logger.warn(
          {
            issueKey: issue.issueKey,
            linearIssueId: issue.linearIssueId,
            error: error instanceof Error ? error.message : String(error),
          },
          "Failed to drain legacy pending-run columns for issue",
        );
      } finally {
        this.leaseService.release(issue.projectId, issue.linearIssueId);
      }
    }
    if (drained > 0) {
      this.logger.info({ drained }, "Drained legacy pending-run columns into durable workflow tasks");
    }
  }

  async recoverDelegatedIssueStateFromLinear(): Promise<void> {
    await this.discoverDelegatedIssuesFromLinear();

    for (let issue of this.db.issues.listIssues()) {
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

      upsertLinearIssueProjection(this.db, issue.projectId, liveIssue);
      // The projection write bumped the issue version; continue with the
      // fresh row so the recovery commit below doesn't self-conflict.
      issue = this.db.issues.getIssue(issue.projectId, issue.linearIssueId) ?? issue;

      const delegated = liveIssue.delegateId === installation.actorId;
      if (issue.delegatedToPatchRelay !== delegated) {
        this.appendAuthorityObservation({
          projectId: issue.projectId,
          linearIssueId: issue.linearIssueId,
          delegated,
          actorId: installation.actorId,
          observedDelegateId: liveIssue.delegateId,
          reason: "startup_recovery_refreshed_linear_delegation",
        });
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
      const hasPendingWake = computeHasPendingWake(this.db, issue.projectId, issue.linearIssueId);
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
            prHeadSha: issue.prHeadSha,
            prReviewState: issue.prReviewState,
            prCheckStatus: issue.prCheckStatus,
            lastBlockingReviewHeadSha: issue.lastBlockingReviewHeadSha,
            latestFailureSource: issue.lastGitHubFailureSource,
          })
        : undefined;
      const shouldRecoverReactivePrWork =
        delegated
        && issue.prNumber !== undefined
        && reactiveIntent !== undefined;

      const commit = this.db.issueSessions.commitIssueState({
        writer: WRITER,
        expectedVersion: issue.version,
        update: {
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
        },
        // The recovery decision was derived from the row read at loop start
        // plus stale PR facts; a concurrent writer (webhook, another recovery
        // pass) invalidates it. Skip — reconciliation re-derives shortly.
        onConflict: () => undefined,
      });
      if (commit.outcome !== "applied") {
        continue;
      }
      const updated = commit.issue;

      if (!shouldRecoverPausedLocalWork && !shouldRecoverReactivePrWork) {
        continue;
      }

      if (unresolvedBlockers === 0) {
        if (this.reconcileAndFindRunnableTask(updated.projectId, updated.linearIssueId)) {
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
    this.reconcileKnownWorkflowTasks();
  }

  private async discoverDelegatedIssuesFromLinear(): Promise<void> {
    for (const project of this.config.projects) {
      const installation = this.db.linearInstallations.getLinearInstallationForProject(project.id);
      if (!installation?.actorId) {
        continue;
      }
      const linear = await this.linearProvider.forProject(project.id).catch(() => undefined);
      if (!linear?.listIssuesDelegatedTo) {
        continue;
      }

      const liveIssues = await linear.listIssuesDelegatedTo({
        delegateId: installation.actorId,
        teamIds: project.linearTeamIds,
      }).catch((error) => {
        this.logger.warn(
          {
            projectId: project.id,
            error: error instanceof Error ? error.message : String(error),
          },
          "Failed to discover delegated Linear issues during startup recovery",
        );
        return [];
      });

      for (const liveIssue of liveIssues) {
        if (!this.shouldRecoverDiscoveredIssue(project, liveIssue, installation.actorId)) {
          continue;
        }
        const existing = this.db.issues.getIssue(project.id, liveIssue.id);
        if (existing) {
          continue;
        }
        this.upsertDiscoveredDelegatedIssue(project, liveIssue);
      }
    }
  }

  private shouldRecoverDiscoveredIssue(project: ProjectConfig, liveIssue: LinearIssueSnapshot, actorId: string): boolean {
    if (liveIssue.delegateId !== actorId) return false;
    if (liveIssue.stateType === "completed" || liveIssue.stateType === "canceled") return false;
    if (project.linearTeamIds.length > 0 && (!liveIssue.teamId || !project.linearTeamIds.includes(liveIssue.teamId))) {
      return false;
    }
    return true;
  }

  private upsertDiscoveredDelegatedIssue(project: ProjectConfig, liveIssue: LinearIssueSnapshot): void {
    upsertLinearIssueProjection(this.db, project.id, liveIssue);

    const existing = this.db.issues.getIssue(project.id, liveIssue.id);
    const commit = this.db.issueSessions.commitIssueState({
      writer: WRITER,
      update: {
        projectId: project.id,
        linearIssueId: liveIssue.id,
        delegatedToPatchRelay: true,
        factoryState: existing?.factoryState ?? "delegated",
        ...(liveIssue.identifier ? { issueKey: liveIssue.identifier } : {}),
        ...(liveIssue.title ? { title: liveIssue.title } : {}),
        ...(liveIssue.description ? { description: liveIssue.description } : {}),
        ...(liveIssue.url ? { url: liveIssue.url } : {}),
        ...(liveIssue.priority != null ? { priority: liveIssue.priority } : {}),
        ...(liveIssue.estimate != null ? { estimate: liveIssue.estimate } : {}),
        ...(liveIssue.stateName ? { currentLinearState: liveIssue.stateName } : {}),
        ...(liveIssue.stateType ? { currentLinearStateType: liveIssue.stateType } : {}),
      },
    });
    if (commit.outcome !== "applied") return;
    const updated = commit.issue;

    this.appendAuthorityObservation({
      projectId: project.id,
      linearIssueId: liveIssue.id,
      delegated: true,
      observedDelegateId: liveIssue.delegateId,
      reason: "startup_recovery_discovered_delegated_issue",
    });

    const unresolvedBlockers = this.db.issues.countUnresolvedBlockers(project.id, liveIssue.id);
    this.logger.info(
      {
        issueKey: updated.issueKey,
        projectId: project.id,
        unresolvedBlockers,
      },
      unresolvedBlockers === 0
        ? "Discovered delegated Linear issue during startup recovery"
        : "Discovered delegated blocked Linear issue during startup recovery",
    );
  }

  private appendAuthorityObservation(params: {
    projectId: string;
    linearIssueId: string;
    delegated: boolean;
    actorId?: string | undefined;
    observedDelegateId?: string | undefined;
    reason: string;
  }): void {
    this.db.workflowObservations.appendObservation({
      projectId: params.projectId,
      subjectId: params.linearIssueId,
      source: "linear",
      type: params.delegated ? "linear.delegated" : "linear.undelegated",
      payloadJson: JSON.stringify({
        source: "startup_recovery",
        delegated: params.delegated,
        issueId: params.linearIssueId,
        actorId: params.actorId,
        observedDelegateId: params.observedDelegateId,
        reason: params.reason,
      }),
      dedupeKey: [
        "startup_recovery",
        "authority",
        params.linearIssueId,
        params.delegated ? "delegated" : "undelegated",
        params.observedDelegateId ?? "",
      ].join(":"),
    });
  }

  private reconcileAndFindRunnableTask(projectId: string, linearIssueId: string): boolean {
    const issue = this.db.issues.getIssue(projectId, linearIssueId);
    if (!issue) return false;
    const reconciliation = reconcileWorkflowTasksForIssue(this.db, issue);
    return [
      ...reconciliation.result.opened,
      ...reconciliation.result.updated,
    ].some((task) => task.gateAction === "start" && task.runType);
  }
}
