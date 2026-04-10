import type { PatchRelayDatabase } from "../db.ts";
import type { RunType } from "../factory-state.ts";
import type { OperatorEventFeed } from "../operator-feed.ts";
import { triggerEventAllowed } from "../project-resolution.ts";
import { resolveAwaitingInputReason } from "../awaiting-input-reason.ts";
import {
  decideActiveRunRelease,
  decideAgentSession,
  decideRunIntent,
  decideUnDelegation,
  isTerminalDelegationState,
  mergeIssueMetadata,
  resolveReDelegationResume,
} from "./decision-helpers.ts";
import type {
  IssueMetadata,
  LinearClientProvider,
  NormalizedEvent,
  ProjectConfig,
  TrackedIssueRecord,
} from "../types.ts";
import { buildOperatorRetryEvent } from "../operator-retry-event.ts";

export class DesiredStageRecorder {
  constructor(
    private readonly db: PatchRelayDatabase,
    private readonly linearProvider: LinearClientProvider,
    private readonly feed?: OperatorEventFeed,
  ) {}

  async record(params: {
    project: ProjectConfig;
    normalized: NormalizedEvent;
    peekPendingSessionWakeRunType: (projectId: string, issueId: string) => RunType | undefined;
    stopActiveRun: (run: NonNullable<ReturnType<PatchRelayDatabase["runs"]["getRunById"]>>, input: string) => Promise<void>;
  }): Promise<{
    issue: TrackedIssueRecord | undefined;
    wakeRunType: RunType | undefined;
    delegated: boolean;
  }> {
    const normalizedIssue = params.normalized.issue;
    if (!normalizedIssue) {
      return { issue: undefined, wakeRunType: undefined, delegated: false };
    }

    const existingIssue = this.db.issues.getIssue(params.project.id, normalizedIssue.id);
    const activeRun = existingIssue?.activeRunId ? this.db.runs.getRunById(existingIssue.activeRunId) : undefined;
    const latestRun = existingIssue ? this.db.runs.getLatestRunForIssue(params.project.id, normalizedIssue.id) : undefined;
    const triggerAllowed = triggerEventAllowed(params.project, params.normalized.triggerEvent);
    const incomingAgentSessionId = params.normalized.agentSession?.id;
    const hasPendingWake = this.db.issueSessions.peekIssueSessionWake(params.project.id, normalizedIssue.id) !== undefined;

    if (!existingIssue && !this.isDelegatedToPatchRelay(params.project, normalizedIssue) && !incomingAgentSessionId) {
      return { issue: undefined, wakeRunType: undefined, delegated: false };
    }

    const hydratedIssue = await this.syncIssueDependencies(params.project.id, normalizedIssue);
    const delegated = this.isDelegatedToPatchRelay(params.project, hydratedIssue);
    const unresolvedBlockers = this.db.issues.countUnresolvedBlockers(params.project.id, normalizedIssue.id);
    const terminal = isTerminalDelegationState(existingIssue, hydratedIssue);

    const desiredStage = decideRunIntent({
      delegated,
      triggerAllowed,
      triggerEvent: params.normalized.triggerEvent,
      unresolvedBlockers,
      hasActiveRun: Boolean(activeRun),
      hasPendingWake,
      terminal,
      currentState: existingIssue?.factoryState,
    });

    const runRelease = decideActiveRunRelease({
      hasActiveRun: Boolean(activeRun),
      terminal,
      triggerEvent: params.normalized.triggerEvent,
      delegated,
    });

    const undelegation = decideUnDelegation({
      triggerEvent: params.normalized.triggerEvent,
      delegated,
      currentState: existingIssue?.factoryState,
      hasPr: existingIssue?.prNumber !== undefined && existingIssue?.prState !== "merged",
    });
    const reDelegationResume = resolveReDelegationResume({
      delegated,
      previouslyDelegated: existingIssue?.delegatedToPatchRelay,
      currentState: existingIssue?.factoryState,
      awaitingInputReason: existingIssue
        ? resolveAwaitingInputReason({ issue: existingIssue, latestRun })
        : undefined,
      unresolvedBlockers,
      prNumber: existingIssue?.prNumber,
      prState: existingIssue?.prState,
      prReviewState: existingIssue?.prReviewState,
      prCheckStatus: existingIssue?.prCheckStatus,
      latestFailureSource: existingIssue?.lastGitHubFailureSource,
    });

    const existingWakeRunType = existingIssue
      ? params.peekPendingSessionWakeRunType(params.project.id, normalizedIssue.id)
      : undefined;
    const clearPending = (unresolvedBlockers > 0 && existingWakeRunType === "implementation" && !activeRun)
      || undelegation.clearPending;

    const agentSessionId = decideAgentSession({
      sessionId: params.normalized.agentSession?.id,
      triggerEvent: params.normalized.triggerEvent,
      delegated,
    });

    const commitIssueUpdate = () => {
      const record = this.db.issues.upsertIssue({
        projectId: params.project.id,
        linearIssueId: normalizedIssue.id,
        ...(hydratedIssue.identifier ? { issueKey: hydratedIssue.identifier } : {}),
        ...(hydratedIssue.title ? { title: hydratedIssue.title } : {}),
        ...(hydratedIssue.description ? { description: hydratedIssue.description } : {}),
        ...(hydratedIssue.url ? { url: hydratedIssue.url } : {}),
        ...(hydratedIssue.priority != null ? { priority: hydratedIssue.priority } : {}),
        ...(hydratedIssue.estimate != null ? { estimate: hydratedIssue.estimate } : {}),
        ...(hydratedIssue.stateName ? { currentLinearState: hydratedIssue.stateName } : {}),
        ...(hydratedIssue.stateType ? { currentLinearStateType: hydratedIssue.stateType } : {}),
        delegatedToPatchRelay: delegated,
        ...(!existingIssue && !delegated && incomingAgentSessionId ? { factoryState: "awaiting_input" as const } : {}),
        ...(reDelegationResume.factoryState ? { factoryState: reDelegationResume.factoryState as never } : {}),
        ...(reDelegationResume.pendingRunType !== undefined
          ? { pendingRunType: null, pendingRunContextJson: null }
          : {}),
        ...(!reDelegationResume.factoryState && desiredStage ? { pendingRunType: null, pendingRunContextJson: null, factoryState: "delegated" as const } : {}),
        ...(clearPending ? { pendingRunType: null, pendingRunContextJson: null } : {}),
        ...(agentSessionId !== undefined ? { agentSessionId } : {}),
        ...(runRelease.release ? { activeRunId: null } : {}),
        ...(undelegation.factoryState ? { factoryState: undelegation.factoryState as never } : {}),
      });
      if (runRelease.release && activeRun && runRelease.reason) {
        this.db.runs.finishRun(activeRun.id, { status: "released", failureReason: runRelease.reason });
      }
      return record;
    };

    const activeLease = this.db.issueSessions.getActiveIssueSessionLease(params.project.id, normalizedIssue.id);
    const issue = activeLease
      ? this.db.issueSessions.withIssueSessionLease(params.project.id, normalizedIssue.id, activeLease.leaseId, commitIssueUpdate) ?? (existingIssue ?? this.db.issues.upsertIssue({
          projectId: params.project.id,
          linearIssueId: normalizedIssue.id,
          ...(hydratedIssue.identifier ? { issueKey: hydratedIssue.identifier } : {}),
        }))
      : this.db.transaction(commitIssueUpdate);

    if (undelegation.factoryState) {
      if (activeRun?.threadId && activeRun.turnId) {
        await params.stopActiveRun(activeRun, "STOP: The issue was un-delegated from PatchRelay. Stop working immediately and exit.");
      }
      this.db.issueSessions.appendIssueSessionEvent({
        projectId: params.project.id,
        linearIssueId: normalizedIssue.id,
        eventType: "undelegated",
        dedupeKey: `undelegated:${normalizedIssue.id}`,
      });
      this.db.issueSessions.clearPendingIssueSessionEventsRespectingActiveLease(params.project.id, normalizedIssue.id);
      this.db.issueSessions.releaseIssueSessionLeaseRespectingActiveLease(params.project.id, normalizedIssue.id);
      this.feed?.publish({
        level: "warn",
        kind: "stage",
        issueKey: issue.issueKey,
        projectId: params.project.id,
        stage: issue.factoryState,
        status: "un_delegated",
        summary: issue.factoryState === "awaiting_input"
          ? "Issue un-delegated from PatchRelay"
          : `Issue un-delegated from PatchRelay; ${issue.factoryState} is now paused`,
      });
    } else if (reDelegationResume.pendingRunType) {
      this.db.issueSessions.appendIssueSessionEventRespectingActiveLease(params.project.id, normalizedIssue.id, {
        projectId: params.project.id,
        linearIssueId: normalizedIssue.id,
        ...buildOperatorRetryEvent(issue, reDelegationResume.pendingRunType, "re_delegated"),
      });
    } else if (
      !reDelegationResume.factoryState
      && !reDelegationResume.pendingRunType
      &&
      desiredStage === "implementation"
      && params.normalized.triggerEvent !== "commentCreated"
      && params.normalized.triggerEvent !== "commentUpdated"
      && params.normalized.triggerEvent !== "agentPrompted"
    ) {
      this.db.issueSessions.appendIssueSessionEventRespectingActiveLease(params.project.id, normalizedIssue.id, {
        projectId: params.project.id,
        linearIssueId: normalizedIssue.id,
        eventType: "delegated",
        eventJson: JSON.stringify({
          promptContext: params.normalized.agentSession?.promptContext?.trim()
            ?? (issue.issueKey ? `Linear issue ${issue.issueKey} was delegated to PatchRelay.` : undefined),
          promptBody: params.normalized.agentSession?.promptBody?.trim(),
        }),
        dedupeKey: `delegated:${normalizedIssue.id}`,
      });
    }

    return {
      issue: this.db.issueToTrackedIssue(issue),
      wakeRunType: params.peekPendingSessionWakeRunType(params.project.id, normalizedIssue.id),
      delegated,
    };
  }

  private isDelegatedToPatchRelay(project: ProjectConfig, issue: { delegateId?: string | undefined }): boolean {
    const installation = this.db.linearInstallations.getLinearInstallationForProject(project.id);
    if (!installation?.actorId) return false;
    return issue.delegateId === installation.actorId;
  }

  private async syncIssueDependencies(projectId: string, issue: IssueMetadata): Promise<IssueMetadata> {
    let source = issue;
    if (!source.relationsKnown) {
      const linear = await this.linearProvider.forProject(projectId);
      if (linear) {
        try {
          source = mergeIssueMetadata(source, await linear.getIssue(issue.id));
        } catch {
          // Preserve existing dependency rows when webhook relation data is incomplete.
        }
      }
    }

    if (source.relationsKnown) {
      this.db.issues.replaceIssueDependencies({
        projectId,
        linearIssueId: source.id,
        blockers: source.blockedBy.map((blocker) => ({
          blockerLinearIssueId: blocker.id,
          ...(blocker.identifier ? { blockerIssueKey: blocker.identifier } : {}),
          ...(blocker.title ? { blockerTitle: blocker.title } : {}),
          ...(blocker.stateName ? { blockerCurrentLinearState: blocker.stateName } : {}),
          ...(blocker.stateType ? { blockerCurrentLinearStateType: blocker.stateType } : {}),
        })),
      });
    }

    return source;
  }
}
