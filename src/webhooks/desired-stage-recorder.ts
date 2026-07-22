import type { PatchRelayDatabase } from "../db.ts";
import type { IssueRecord } from "../db-types.ts";
import type { RunType } from "../run-type.ts";
import type { OperatorEventFeed } from "../operator-feed.ts";
import { dispatchOrchestrationParentsForChildEvent } from "../orchestration-parent-dispatch.ts";
import { triggerEventAllowed } from "../project-resolution.ts";
import { isResolvedLinearState } from "./decision-helpers.ts";
import { isDelegatedToPatchRelay, resolveDelegationTruth } from "./delegation-truth.ts";
import { syncIssueDependencies } from "./issue-dependency-sync.ts";
import { resolveLinkedPrAdoption } from "./linked-pr-adoption.ts";
import type {
  LinearClientProvider,
  NormalizedEvent,
  ProjectConfig,
  TrackedIssueRecord,
} from "../types.ts";
import { buildOperatorRetryEvent } from "../operator-retry-event.ts";
import { appendBranchUpkeepObservation } from "../branch-upkeep-signal.ts";
import { planIssueWebhookWorkflow } from "./issue-webhook-workflow-planner.ts";
import type { WorkflowTaskDispatcher } from "../workflow-task-dispatcher.ts";
import { dirtyWorktreeEventPayload, inspectGitWorktreeStatus } from "../git-worktree-status.ts";
import { deriveIssuePhase } from "../issue-phase.ts";

const WRITER = "desired-stage-recorder";

export class DesiredStageRecorder {
  constructor(
    private readonly db: PatchRelayDatabase,
    private readonly linearProvider: LinearClientProvider,
    private readonly workflowTaskDispatcher: WorkflowTaskDispatcher,
    private readonly feed?: OperatorEventFeed,
  ) {}

  async record(params: {
    project: ProjectConfig;
    normalized: NormalizedEvent;
    peekRunnableWorkflowTaskRunType: (projectId: string, issueId: string) => RunType | undefined;
    stopActiveRun: (run: NonNullable<ReturnType<PatchRelayDatabase["runs"]["getRunById"]>>, input: string) => Promise<void>;
  }): Promise<{
    issue: TrackedIssueRecord | undefined;
    runnableTaskRunType: RunType | undefined;
    delegated: boolean;
  }> {
    const normalizedIssue = params.normalized.issue;
    if (!normalizedIssue) {
      return { issue: undefined, runnableTaskRunType: undefined, delegated: false };
    }

    const existingIssue = this.db.issues.getIssue(params.project.id, normalizedIssue.id);
    const activeRun = existingIssue?.activeRunId ? this.db.runs.getRunById(existingIssue.activeRunId) : undefined;
    const latestRun = existingIssue ? this.db.runs.getLatestRunForIssue(params.project.id, normalizedIssue.id) : undefined;
    const triggerAllowed = triggerEventAllowed(params.project, params.normalized.triggerEvent);
    const incomingAgentSessionId = params.normalized.agentSession?.id;
    const hasRunnableWorkflowTask = params.peekRunnableWorkflowTaskRunType(params.project.id, normalizedIssue.id) !== undefined;

    if (!existingIssue && !isDelegatedToPatchRelay(this.db, params.project, normalizedIssue) && !incomingAgentSessionId) {
      return { issue: undefined, runnableTaskRunType: undefined, delegated: false };
    }

    const syncResult = await syncIssueDependencies(this.db, this.linearProvider, params.project.id, normalizedIssue);
    const hydratedIssue = syncResult.issue;
    const delegation = resolveDelegationTruth({
      db: this.db,
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
    const linkedPrAdoption = await resolveLinkedPrAdoption({
      project: params.project,
      issue: hydratedIssue,
      existingIssue,
      delegated,
      triggerEvent: params.normalized.triggerEvent,
    });
    const unresolvedBlockers = this.db.issues.countUnresolvedBlockers(params.project.id, normalizedIssue.id);
    const childIssueCount = this.db.issues.listCanonicalChildIssues(params.project.id, normalizedIssue.id).length;
    const existingWorkflowTaskRunType = existingIssue
      ? params.peekRunnableWorkflowTaskRunType(params.project.id, normalizedIssue.id)
      : undefined;
    const workflowPlan = planIssueWebhookWorkflow({
      existingIssue,
      hydratedIssue,
      latestRun,
      delegated,
      linkedPrAdoption,
      triggerAllowed,
      triggerEvent: params.normalized.triggerEvent,
      unresolvedBlockers,
      hasActiveRun: Boolean(activeRun),
      activeRunType: activeRun?.runType,
      hasRunnableWorkflowTask,
      existingWorkflowTaskRunType,
      incomingAgentSessionId,
      childIssueCount,
    });
    const releaseWorktreeStatus = workflowPlan.effectiveRunRelease.release && activeRun && existingIssue?.worktreePath
      ? inspectGitWorktreeStatus(existingIssue.worktreePath)
      : undefined;
    const releaseReason = workflowPlan.effectiveRunRelease.reason
      ? releaseWorktreeStatus?.dirty && releaseWorktreeStatus.summary
        ? `${workflowPlan.effectiveRunRelease.reason}; ${releaseWorktreeStatus.summary}`
        : workflowPlan.effectiveRunRelease.reason
      : undefined;
    const dirtyWorktreePayload = releaseWorktreeStatus ? dirtyWorktreeEventPayload(releaseWorktreeStatus) : undefined;

    const activeLease = this.db.issueSessions.getActiveIssueSessionLease(params.project.id, normalizedIssue.id);
    // Webhook intake projection: the fields are facts carried by the webhook
    // payload and the hydrated Linear issue, applied unconditionally (the
    // active lease still gates the write, matching the previous semantics).
    const issueCommit = this.db.issueSessions.commitIssueState({
      writer: WRITER,
      ...(activeLease ? { lease: activeLease } : {}),
      update: {
        projectId: params.project.id,
        linearIssueId: normalizedIssue.id,
        ...(hydratedIssue.identifier ? { issueKey: hydratedIssue.identifier } : {}),
        ...(hydratedIssue.parentId !== undefined ? { parentLinearIssueId: hydratedIssue.parentId ?? null } : {}),
        ...(hydratedIssue.parentIdentifier !== undefined ? { parentIssueKey: hydratedIssue.parentIdentifier ?? null } : {}),
        issueClass: workflowPlan.classification.issueClass,
        issueClassSource: workflowPlan.classification.issueClassSource,
        ...(hydratedIssue.title ? { title: hydratedIssue.title } : {}),
        ...(hydratedIssue.description ? { description: hydratedIssue.description } : {}),
        ...(hydratedIssue.url ? { url: hydratedIssue.url } : {}),
        ...(hydratedIssue.priority != null ? { priority: hydratedIssue.priority } : {}),
        ...(hydratedIssue.estimate != null ? { estimate: hydratedIssue.estimate } : {}),
        ...(hydratedIssue.stateName ? { currentLinearState: hydratedIssue.stateName } : {}),
        ...(hydratedIssue.stateType ? { currentLinearStateType: hydratedIssue.stateType } : {}),
        ...linkedPrAdoption?.issueUpdates,
        delegatedToPatchRelay: delegated,
        ...workflowPlan.resolvedIssueUpdate,
      },
    });
    let issue: IssueRecord;
    if (issueCommit.outcome === "applied") {
      issue = issueCommit.issue;
      if (workflowPlan.effectiveRunRelease.release && activeRun && releaseReason) {
        this.db.runs.finishRun(activeRun.id, { status: "released", failureReason: releaseReason });
      }
    } else if (existingIssue) {
      issue = existingIssue;
    } else {
      const fallbackCommit = this.db.issueSessions.commitIssueState({
        writer: WRITER,
        update: {
          projectId: params.project.id,
          linearIssueId: normalizedIssue.id,
          ...(hydratedIssue.identifier ? { issueKey: hydratedIssue.identifier } : {}),
        },
      });
      if (fallbackCommit.outcome !== "applied") {
        return { issue: undefined, runnableTaskRunType: undefined, delegated };
      }
      issue = fallbackCommit.issue;
    }

    const previousParentIssueId = existingIssue?.parentLinearIssueId;
    const currentParentIssueId = issue.parentLinearIssueId;
    const wasResolved = isResolvedLinearState(existingIssue?.currentLinearStateType, existingIssue?.currentLinearState);
    const isResolved = isResolvedLinearState(issue.currentLinearStateType, issue.currentLinearState);

    if (workflowPlan.undelegation.paused) {
      if (activeRun && releaseReason) {
        this.db.runs.revokeRunLease(activeRun.id, { reason: releaseReason });
      }
      if (activeRun?.threadId && activeRun.turnId) {
        await params.stopActiveRun(activeRun, "STOP: The issue was un-delegated from PatchRelay. Stop working immediately and exit.");
      }
      this.db.issueSessions.appendIssueSessionEvent({
        projectId: params.project.id,
        linearIssueId: normalizedIssue.id,
        eventType: "undelegated",
        ...(dirtyWorktreePayload
          ? {
              eventJson: JSON.stringify(dirtyWorktreePayload),
            }
          : {}),
        dedupeKey: `undelegated:${normalizedIssue.id}`,
      });
      this.db.issueSessions.clearPendingIssueSessionEventsRespectingActiveLease(params.project.id, normalizedIssue.id);
      this.db.issueSessions.releaseIssueSessionLeaseRespectingActiveLease(params.project.id, normalizedIssue.id);
      this.feed?.publish({
        level: "warn",
        kind: "stage",
        issueKey: issue.issueKey,
        projectId: params.project.id,
        stage: deriveIssuePhase(issue),
        status: "un_delegated",
        summary: releaseWorktreeStatus?.dirty && releaseWorktreeStatus.summary
          ? `Issue un-delegated from PatchRelay with dirty worktree: ${releaseWorktreeStatus.summary}`
          : "Issue un-delegated from PatchRelay; automation is now paused",
      });
    } else if (workflowPlan.blockerPausedImplementation) {
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
        stage: deriveIssuePhase(issue),
        status: "blocked",
        summary: `Implementation paused because ${issue.issueKey ?? normalizedIssue.id} is now blocked`,
      });
    } else if (workflowPlan.startupResume.workflowIntent) {
      // A branch_upkeep resume folds its run context into the durable
      // `github.parent_head_moved` observation the workflow-task path derives
      // `run:branch_upkeep` from. Every other resume run type is fact-derived
      // from the PR facts / delegation just committed above.
      const resumeIntent = workflowPlan.startupResume.workflowIntent;
      const resumeContext = resumeIntent.context;
      if (resumeIntent.runType === "branch_upkeep" && resumeContext) {
        appendBranchUpkeepObservation(this.db, issue, {
          parentBranch: typeof resumeContext.baseBranch === "string" ? resumeContext.baseBranch : "main",
          ...(issue.prHeadSha ? { childHeadSha: issue.prHeadSha } : {}),
          ...(issue.prNumber !== undefined ? { childPrNumber: issue.prNumber } : {}),
        });
      }
      // Session event kept for diagnostics; it no longer holds dispatch
      // authority. The webhook handler reconciles workflow tasks and enqueues
      // right after `record()` returns, so the branch_upkeep observation above
      // (and the PR facts just committed) materialize the runnable `workflow_task`
      // that drives the resumed run — no dispatch call is needed here.
      this.db.issueSessions.appendIssueSessionEventRespectingActiveLease(params.project.id, normalizedIssue.id, {
        projectId: params.project.id,
        linearIssueId: normalizedIssue.id,
        ...buildOperatorRetryEvent(issue, resumeIntent.runType, workflowPlan.startupResume.source),
      });
    } else if (workflowPlan.shouldEnterOrchestrationSettle) {
      this.feed?.publish({
        level: "info",
        kind: "stage",
        issueKey: issue.issueKey,
        projectId: params.project.id,
        stage: deriveIssuePhase(issue),
        status: "settling_children",
        summary: "Waiting briefly for child issues to settle before orchestration starts",
      });
    }

    if (previousParentIssueId && previousParentIssueId !== currentParentIssueId) {
      dispatchOrchestrationParentsForChildEvent({
        db: this.db,
        child: {
          ...issue,
          projectId: issue.projectId,
          linearIssueId: issue.linearIssueId,
          parentLinearIssueId: previousParentIssueId,
          ...(issue.issueKey ? { issueKey: issue.issueKey } : {}),
          ...(issue.title ? { title: issue.title } : {}),
          ...(issue.currentLinearState ? { currentLinearState: issue.currentLinearState } : {}),
          ...(issue.prNumber !== undefined ? { prNumber: issue.prNumber } : {}),
          ...(issue.prState ? { prState: issue.prState } : {}),
        },
        eventType: "child_changed",
        changeKind: "detached",
        workflowTaskDispatcher: this.workflowTaskDispatcher,
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
            : undefined;
      if (eventType) {
        dispatchOrchestrationParentsForChildEvent({
          db: this.db,
          child: issue,
          eventType,
          changeKind,
          workflowTaskDispatcher: this.workflowTaskDispatcher,
        });
      }
    }

    return {
      issue: this.db.issueToTrackedIssue(issue),
      runnableTaskRunType: params.peekRunnableWorkflowTaskRunType(params.project.id, normalizedIssue.id),
      delegated,
    };
  }

}
