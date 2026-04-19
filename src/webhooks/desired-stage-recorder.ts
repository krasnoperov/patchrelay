import type { PatchRelayDatabase } from "../db.ts";
import type { RunType } from "../factory-state.ts";
import type { OperatorEventFeed } from "../operator-feed.ts";
import { classifyIssue } from "../issue-class.ts";
import {
  computeOrchestrationSettleUntil,
  wakeOrchestrationParentsForChildEvent,
} from "../orchestration-parent-wake.ts";
import { triggerEventAllowed } from "../project-resolution.ts";
import { resolveAwaitingInputReason } from "../awaiting-input-reason.ts";
import { appendDelegationObservedEvent, type DelegationAuditHydration } from "../delegation-audit.ts";
import {
  decideActiveRunRelease,
  decideAgentSession,
  decideRunIntent,
  decideUnDelegation,
  isResolvedLinearState,
  isTerminalDelegationState,
  mergeIssueMetadata,
  resolveReDelegationResume,
} from "./decision-helpers.ts";
import type {
  IssueRecord,
  IssueMetadata,
  LinearClientProvider,
  NormalizedEvent,
  ProjectConfig,
  TrackedIssueRecord,
} from "../types.ts";
import { buildOperatorRetryEvent } from "../operator-retry-event.ts";
import { resolveLinkedPullRequest } from "../linear-linked-pr-reconciliation.ts";
import { readRemotePrState } from "../remote-pr-state.ts";
import { deriveLinkedPrAdoptionOutcome } from "../delegation-linked-pr.ts";

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

    const syncResult = await this.syncIssueDependencies(params.project.id, normalizedIssue);
    const hydratedIssue = syncResult.issue;
    const delegation = this.resolveDelegationTruth({
      project: params.project,
      normalizedIssue,
      hydratedIssue,
      existingIssue,
      triggerEvent: params.normalized.triggerEvent,
      webhookId: params.normalized.webhookId,
      actorId: params.normalized.actor?.id,
      hydration: syncResult.hydration,
      activeRunId: activeRun?.id,
    });
    const delegated = delegation.delegated;
    const linkedPrAdoption = await this.resolveLinkedPrAdoption({
      project: params.project,
      issue: hydratedIssue,
      existingIssue,
      delegated,
      triggerEvent: params.normalized.triggerEvent,
    });
    const unresolvedBlockers = this.db.issues.countUnresolvedBlockers(params.project.id, normalizedIssue.id);
    const terminal = isTerminalDelegationState(existingIssue, hydratedIssue);
    const openPrExists = existingIssue?.prNumber !== undefined
      && existingIssue.prState !== "closed"
      && existingIssue.prState !== "merged";
    const blockerPausedImplementation = unresolvedBlockers > 0
      && activeRun?.runType === "implementation"
      && !openPrExists;

    const desiredStage = linkedPrAdoption
      ? undefined
      : decideRunIntent({
        delegated,
        triggerAllowed,
        triggerEvent: params.normalized.triggerEvent,
        unresolvedBlockers,
        hasActiveRun: Boolean(activeRun),
        hasPendingWake,
        terminal,
        currentState: existingIssue?.factoryState,
      });

    const childIssueCount = this.db.issues.listChildIssues(params.project.id, normalizedIssue.id).length;
    const classification = classifyIssue({
      issue: {
        issueClass: existingIssue?.issueClass,
        issueClassSource: existingIssue?.issueClassSource,
        title: hydratedIssue.title ?? existingIssue?.title,
        description: hydratedIssue.description ?? existingIssue?.description,
        parentLinearIssueId: hydratedIssue.parentId ?? existingIssue?.parentLinearIssueId,
      },
      childIssueCount,
    });
    const shouldEnterOrchestrationSettle = Boolean(
      delegated
      && desiredStage === "implementation"
      && classification.issueClass === "orchestration"
      && childIssueCount === 0
      && !existingIssue?.threadId
      && !activeRun
      && !terminal,
    );

    const runRelease = decideActiveRunRelease({
      hasActiveRun: Boolean(activeRun),
      terminal,
      triggerEvent: params.normalized.triggerEvent,
      delegated,
    });
    const effectiveRunRelease = blockerPausedImplementation
      ? { release: true, reason: "Issue became blocked during implementation" }
      : runRelease;

    const undelegation = decideUnDelegation({
      triggerEvent: params.normalized.triggerEvent,
      delegated,
      currentState: existingIssue?.factoryState,
      hasPr: existingIssue?.prNumber !== undefined && existingIssue?.prState !== "merged",
    });
    const startupResume = linkedPrAdoption
      ? {
          factoryState: linkedPrAdoption.factoryState,
          pendingRunType: linkedPrAdoption.pendingRunType,
          pendingRunContext: linkedPrAdoption.pendingRunContext,
          source: "linked_pr_adoption",
        }
      : {
          ...resolveReDelegationResume({
            delegated,
            previouslyDelegated: existingIssue?.delegatedToPatchRelay,
            currentState: existingIssue?.factoryState,
            awaitingInputReason: existingIssue
              ? resolveAwaitingInputReason({ issue: existingIssue, latestRun })
              : undefined,
            unresolvedBlockers,
            prNumber: existingIssue?.prNumber,
            prState: existingIssue?.prState,
            prIsDraft: existingIssue?.prIsDraft,
            prReviewState: existingIssue?.prReviewState,
            prCheckStatus: existingIssue?.prCheckStatus,
            latestFailureSource: existingIssue?.lastGitHubFailureSource,
          }),
          source: "re_delegated",
        };

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
    const terminalRunRelease = effectiveRunRelease.release && terminal;

    const commitIssueUpdate = () => {
      const record = this.db.issues.upsertIssue({
        projectId: params.project.id,
        linearIssueId: normalizedIssue.id,
        ...(hydratedIssue.identifier ? { issueKey: hydratedIssue.identifier } : {}),
        ...(hydratedIssue.parentId !== undefined ? { parentLinearIssueId: hydratedIssue.parentId ?? null } : {}),
        ...(hydratedIssue.parentIdentifier !== undefined ? { parentIssueKey: hydratedIssue.parentIdentifier ?? null } : {}),
        issueClass: classification.issueClass,
        issueClassSource: classification.issueClassSource,
        ...(hydratedIssue.title ? { title: hydratedIssue.title } : {}),
        ...(hydratedIssue.description ? { description: hydratedIssue.description } : {}),
        ...(hydratedIssue.url ? { url: hydratedIssue.url } : {}),
        ...(hydratedIssue.priority != null ? { priority: hydratedIssue.priority } : {}),
        ...(hydratedIssue.estimate != null ? { estimate: hydratedIssue.estimate } : {}),
        ...(hydratedIssue.stateName ? { currentLinearState: hydratedIssue.stateName } : {}),
        ...(hydratedIssue.stateType ? { currentLinearStateType: hydratedIssue.stateType } : {}),
        ...(linkedPrAdoption?.issueUpdates ?? {}),
        delegatedToPatchRelay: delegated,
        ...(!existingIssue && !delegated && incomingAgentSessionId ? { factoryState: "awaiting_input" as const } : {}),
        ...(startupResume.factoryState ? { factoryState: startupResume.factoryState as never } : {}),
        ...(startupResume.pendingRunType !== undefined
          ? {
              pendingRunType: null,
              pendingRunContextJson: startupResume.pendingRunContext
                ? JSON.stringify(startupResume.pendingRunContext)
                : null,
            }
          : {}),
        ...(!startupResume.factoryState && desiredStage ? { pendingRunType: null, pendingRunContextJson: null, factoryState: "delegated" as const } : {}),
        ...(clearPending ? { pendingRunType: null, pendingRunContextJson: null } : {}),
        ...(agentSessionId !== undefined ? { agentSessionId } : {}),
        ...(effectiveRunRelease.release ? { activeRunId: null } : {}),
        ...(terminalRunRelease ? { factoryState: "done" as const, pendingRunType: null, pendingRunContextJson: null } : {}),
        ...(blockerPausedImplementation ? { factoryState: "delegated" as const } : {}),
        ...(undelegation.factoryState ? { factoryState: undelegation.factoryState as never } : {}),
        ...(shouldEnterOrchestrationSettle ? { orchestrationSettleUntil: computeOrchestrationSettleUntil() } : {}),
      });
      if (effectiveRunRelease.release && activeRun && effectiveRunRelease.reason) {
        this.db.runs.finishRun(activeRun.id, { status: "released", failureReason: effectiveRunRelease.reason });
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

    const previousParentIssueId = existingIssue?.parentLinearIssueId;
    const currentParentIssueId = issue.parentLinearIssueId;
    const wasResolved = isResolvedLinearState(existingIssue?.currentLinearStateType, existingIssue?.currentLinearState);
    const isResolved = isResolvedLinearState(issue.currentLinearStateType, issue.currentLinearState);

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
    } else if (blockerPausedImplementation) {
      if (activeRun?.threadId && activeRun.turnId) {
        await params.stopActiveRun(activeRun, "STOP: The issue is now blocked by another task. Stop working immediately and exit without publishing.");
      }
      this.db.issueSessions.clearPendingIssueSessionEventsRespectingActiveLease(params.project.id, normalizedIssue.id);
      this.db.issueSessions.releaseIssueSessionLeaseRespectingActiveLease(params.project.id, normalizedIssue.id);
      this.feed?.publish({
        level: "warn",
        kind: "stage",
        issueKey: issue.issueKey,
        projectId: params.project.id,
        stage: issue.factoryState,
        status: "blocked",
        summary: `Implementation paused because ${issue.issueKey ?? normalizedIssue.id} is now blocked`,
      });
    } else if (startupResume.pendingRunType) {
      this.db.issueSessions.appendIssueSessionEventRespectingActiveLease(params.project.id, normalizedIssue.id, {
        projectId: params.project.id,
        linearIssueId: normalizedIssue.id,
        ...buildOperatorRetryEvent(issue, startupResume.pendingRunType, startupResume.source),
      });
    } else if (shouldEnterOrchestrationSettle) {
      this.feed?.publish({
        level: "info",
        kind: "stage",
        issueKey: issue.issueKey,
        projectId: params.project.id,
        stage: issue.factoryState,
        status: "settling_children",
        summary: "Waiting briefly for child issues to settle before orchestration starts",
      });
    } else if (
      !startupResume.factoryState
      && !startupResume.pendingRunType
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

    if (previousParentIssueId && previousParentIssueId !== currentParentIssueId) {
      wakeOrchestrationParentsForChildEvent({
        db: this.db,
        child: {
          projectId: issue.projectId,
          linearIssueId: issue.linearIssueId,
          parentLinearIssueId: previousParentIssueId,
          ...(issue.issueKey ? { issueKey: issue.issueKey } : {}),
          ...(issue.title ? { title: issue.title } : {}),
          factoryState: issue.factoryState,
          ...(issue.currentLinearState ? { currentLinearState: issue.currentLinearState } : {}),
          ...(issue.prNumber !== undefined ? { prNumber: issue.prNumber } : {}),
          ...(issue.prState ? { prState: issue.prState } : {}),
        },
        eventType: "child_changed",
        changeKind: "detached",
      });
    }

    if (currentParentIssueId) {
      const changeKind = previousParentIssueId !== currentParentIssueId
        ? "attached"
        : issue.currentLinearState?.trim().toLowerCase() === "duplicate"
          ? "duplicate"
          : issue.currentLinearStateType === "canceled"
            ? "canceled"
            : "updated";
      const eventType = previousParentIssueId !== currentParentIssueId
        ? "child_changed"
        : !wasResolved && isResolved
          ? "child_delivered"
          : wasResolved && !isResolved
            ? "child_regressed"
            : "child_changed";
      wakeOrchestrationParentsForChildEvent({
        db: this.db,
        child: issue,
        eventType,
        changeKind,
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

  private resolveDelegationTruth(params: {
    project: ProjectConfig;
    normalizedIssue: IssueMetadata;
    hydratedIssue: IssueMetadata;
    existingIssue: IssueRecord | undefined;
    triggerEvent: string;
    webhookId: string;
    actorId?: string | undefined;
    hydration: DelegationAuditHydration;
    activeRunId?: number | undefined;
  }): {
    delegated: boolean;
  } {
    const previousDelegated = params.existingIssue?.delegatedToPatchRelay;
    const observedDelegated = this.isDelegatedToPatchRelay(params.project, params.hydratedIssue);
    const explicitDelegateSignal = params.triggerEvent === "delegateChanged";
    const hasObservedDelegate = params.hydratedIssue.delegateId !== undefined;

    let delegated = observedDelegated;
    let reason = hasObservedDelegate
      ? "delegate_id_present"
      : `missing_delegate_identity_after_${params.hydration}`;

    if (!hasObservedDelegate && !explicitDelegateSignal && previousDelegated !== undefined) {
      delegated = previousDelegated;
      reason = `preserved_previous_delegation_after_${params.hydration}`;
    }

    if (
      previousDelegated !== delegated
      || params.hydration === "live_linear_failed"
      || (!hasObservedDelegate && previousDelegated !== undefined)
    ) {
      appendDelegationObservedEvent(this.db, {
        projectId: params.project.id,
        linearIssueId: params.normalizedIssue.id,
        payload: {
          source: "linear_webhook",
          webhookId: params.webhookId,
          triggerEvent: params.triggerEvent,
          ...(params.actorId ? { actorId: params.actorId } : {}),
          ...(params.hydratedIssue.delegateId ? { observedDelegateId: params.hydratedIssue.delegateId } : {}),
          ...(previousDelegated !== undefined ? { previousDelegatedToPatchRelay: previousDelegated } : {}),
          observedDelegatedToPatchRelay: observedDelegated,
          appliedDelegatedToPatchRelay: delegated,
          hydration: params.hydration,
          ...(params.activeRunId !== undefined ? { activeRunId: params.activeRunId } : {}),
          decision: "none",
          reason,
        },
      });
    }

    return { delegated };
  }

  private async syncIssueDependencies(projectId: string, issue: IssueMetadata): Promise<{
    issue: IssueMetadata;
    hydration: DelegationAuditHydration;
  }> {
    let source = issue;
    let hydration: DelegationAuditHydration = "webhook_only";
    if (!source.relationsKnown) {
      const linear = await this.linearProvider.forProject(projectId);
      if (linear) {
        try {
          source = mergeIssueMetadata(source, await linear.getIssue(issue.id));
          hydration = "live_linear";
        } catch {
          // Preserve existing dependency rows when webhook relation data is incomplete.
          hydration = "live_linear_failed";
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

    this.db.issues.replaceIssueParentLink({
      projectId,
      childLinearIssueId: source.id,
      parentLinearIssueId: source.parentId ?? null,
    });

    return { issue: source, hydration };
  }

  private async resolveLinkedPrAdoption(params: {
    project: ProjectConfig;
    issue: IssueMetadata;
    existingIssue: IssueRecord | undefined;
    delegated: boolean;
    triggerEvent: string;
  }) {
    if (!params.delegated) return undefined;
    if (params.triggerEvent !== "delegateChanged") return undefined;
    if (params.existingIssue?.prNumber !== undefined) return undefined;

    const resolution = resolveLinkedPullRequest(params.issue.attachments, params.project.github?.repoFullName);
    if (resolution.kind === "none") return undefined;
    if (resolution.kind === "ambiguous") {
      return {
        factoryState: "awaiting_input" as const,
        pendingRunType: null,
        pendingRunContext: undefined,
        issueUpdates: {},
      };
    }

    const remote = await readRemotePrState(resolution.reference.repoFullName, resolution.reference.prNumber);
    if (!remote) {
      return {
        factoryState: "awaiting_input" as const,
        pendingRunType: null,
        pendingRunContext: undefined,
        issueUpdates: {
          prNumber: resolution.reference.prNumber,
          prUrl: resolution.reference.url,
        },
      };
    }

    return deriveLinkedPrAdoptionOutcome(params.project, resolution.reference.prNumber, remote);
  }
}
