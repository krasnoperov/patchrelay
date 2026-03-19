import type { Logger } from "pino";
import type { CodexNotification } from "./codex-app-server.ts";
import type { CodexAppServerClient } from "./codex-app-server.ts";
import type { IssueControlStoreProvider, IssueSessionStoreProvider, ObligationStoreProvider, RunLeaseStoreProvider, WorkspaceOwnershipStoreProvider } from "./ledger-ports.ts";
import { ReconciliationActionApplier } from "./reconciliation-action-applier.ts";
import { reconcileIssue } from "./reconciliation-engine.ts";
import { buildReconciliationSnapshot } from "./reconciliation-snapshot-builder.ts";
import type { ReconciliationSnapshot } from "./reconciliation-snapshot-builder.ts";
import type { StageEventLogStoreProvider } from "./stage-event-ports.ts";
import type { IssueWorkflowCoordinatorProvider, IssueWorkflowQueryStoreProvider } from "./workflow-ports.ts";
import { syncFailedStageToLinear } from "./stage-failure.ts";
import { parseStageHandoff } from "./stage-handoff.ts";
import { resolveAuthoritativeLinearStopState, resolveDoneLinearState, resolveFallbackLinearState } from "./linear-workflow.ts";
import type { OperatorEventFeed } from "./operator-feed.ts";
import { resolveDefaultTransitionTarget, transitionTargetAllowed, type WorkflowTransitionTarget } from "./workflow-policy.ts";
import {
  buildFailedStageReport,
  buildPendingMaterializationThread,
  buildStageReport,
  countEventMethods,
  extractStageSummary,
  extractTurnId,
  resolveStageRunStatus,
  summarizeCurrentThread,
} from "./stage-reporting.ts";
import { StageLifecyclePublisher } from "./stage-lifecycle-publisher.ts";
import { StageTurnInputDispatcher } from "./stage-turn-input-dispatcher.ts";
import type { AppConfig, CodexThreadSummary, LinearClientProvider, StageReport, StageRunRecord, TrackedIssueRecord, WorkflowStage } from "./types.ts";

export class ServiceStageFinalizer {
  private readonly inputDispatcher: StageTurnInputDispatcher;
  private readonly lifecyclePublisher: StageLifecyclePublisher;
  private readonly actionApplier: ReconciliationActionApplier;
  private readonly runAtomically: <T>(fn: () => T) => T;

  constructor(
    private readonly config: AppConfig,
    private readonly stores: IssueWorkflowCoordinatorProvider &
      IssueWorkflowQueryStoreProvider &
      StageEventLogStoreProvider &
      IssueControlStoreProvider &
      IssueSessionStoreProvider &
      ObligationStoreProvider &
      RunLeaseStoreProvider &
      WorkspaceOwnershipStoreProvider,
    private readonly codex: CodexAppServerClient,
    private readonly linearProvider: LinearClientProvider,
    private readonly enqueueIssue: (projectId: string, issueId: string) => void,
    private readonly logger: Logger = consoleLogger(),
    private readonly feed?: OperatorEventFeed,
    runAtomically: <T>(fn: () => T) => T = (fn) => fn(),
  ) {
    this.runAtomically = runAtomically;
    this.inputDispatcher = new StageTurnInputDispatcher(stores, codex, this.logger);
    this.lifecyclePublisher = new StageLifecyclePublisher(config, stores, linearProvider, this.logger, feed);
    this.actionApplier = new ReconciliationActionApplier({
      enqueueIssue,
      deliverPendingObligations: (projectId, linearIssueId, threadId, turnId) =>
        this.deliverPendingObligations(projectId, linearIssueId, threadId, turnId),
      completeRun: (projectId, linearIssueId, thread, params) =>
        this.completeReconciledRun(projectId, linearIssueId, thread, params),
      failRunDuringReconciliation: (projectId, linearIssueId, threadId, message, options) =>
        this.failRunLeaseDuringReconciliation(projectId, linearIssueId, threadId, message, options),
      releaseRunDuringReconciliation: (projectId, linearIssueId, params) =>
        this.releaseRunDuringReconciliation(projectId, linearIssueId, params),
    });
  }

  async getActiveStageStatus(issueKey: string) {
    const issue = this.stores.issueWorkflows.getTrackedIssueByKey(issueKey);
    if (!issue) {
      return undefined;
    }

    const stageRun = this.resolveActiveStageRun(issue);
    if (!stageRun?.threadId) {
      return undefined;
    }

    const thread = await this.codex.readThread(stageRun.threadId, true).catch((error) => {
      const err = error instanceof Error ? error : new Error(String(error));
      return buildPendingMaterializationThread(stageRun, err);
    });

    return {
      issue,
      stageRun,
      liveThread: summarizeCurrentThread(thread),
    };
  }

  async handleCodexNotification(notification: CodexNotification): Promise<void> {
    const threadId = typeof notification.params.threadId === "string" ? notification.params.threadId : undefined;
    if (!threadId) {
      return;
    }

    const stageRun = this.stores.issueWorkflows.getStageRunByThreadId(threadId);
    if (!stageRun) {
      return;
    }

    const turnId = typeof notification.params.turnId === "string" ? notification.params.turnId : undefined;
    if (this.config.runner.codex.persistExtendedHistory) {
      this.stores.stageEvents.saveThreadEvent({
        stageRunId: stageRun.id,
        threadId,
        ...(turnId ? { turnId } : {}),
        method: notification.method,
        eventJson: JSON.stringify(notification.params),
      });
    }

    if (notification.method === "turn/started" || notification.method.startsWith("item/")) {
      if (notification.method === "turn/started") {
        const issue = this.stores.issueWorkflows.getTrackedIssue(stageRun.projectId, stageRun.linearIssueId);
        this.feed?.publish({
          level: "info",
          kind: "turn",
          issueKey: issue?.issueKey,
          projectId: stageRun.projectId,
          stage: stageRun.stage,
          ...(issue?.selectedWorkflowId ? { workflowId: issue.selectedWorkflowId } : {}),
          status: "started",
          summary: `Turn started for ${stageRun.stage}`,
          detail: turnId ? `Turn ${turnId} is now live.` : undefined,
        });
      }
      await this.flushQueuedTurnInputs(stageRun);
    }

    if (notification.method !== "turn/completed") {
      return;
    }

    const thread = await this.codex.readThread(threadId, true);
    const issue = this.stores.issueWorkflows.getTrackedIssue(stageRun.projectId, stageRun.linearIssueId);
    if (!issue) {
      return;
    }

    const completedTurnId = extractTurnId(notification.params);
    const status = resolveStageRunStatus(notification.params);
    if (status === "failed") {
      this.feed?.publish({
        level: "error",
        kind: "turn",
        issueKey: issue.issueKey,
        projectId: stageRun.projectId,
        stage: stageRun.stage,
        ...(issue.selectedWorkflowId ? { workflowId: issue.selectedWorkflowId } : {}),
        status: "failed",
        summary: `Turn failed for ${stageRun.stage}`,
        detail: completedTurnId ? `Turn ${completedTurnId} completed in a failed state.` : undefined,
      });
      await this.failStageRunAndSync(stageRun, issue, threadId, "Codex reported the turn completed in a failed state", {
        ...(completedTurnId ? { turnId: completedTurnId } : {}),
      });
      return;
    }

    this.feed?.publish({
      level: "info",
      kind: "turn",
      issueKey: issue.issueKey,
      projectId: stageRun.projectId,
      stage: stageRun.stage,
      ...(issue.selectedWorkflowId ? { workflowId: issue.selectedWorkflowId } : {}),
      status: "completed",
      summary: `Turn completed for ${stageRun.stage}`,
      detail: summarizeCurrentThread(thread).latestAgentMessage,
    });

    this.completeStageRun(stageRun, issue, thread, status, {
      threadId,
      ...(completedTurnId ? { turnId: completedTurnId } : {}),
    });
  }

  async reconcileActiveStageRuns(): Promise<void> {
    for (const runLeaseId of this.stores.runLeases.listActiveRunLeases().filter((runLease) => runLease.status === "running").map((runLease) => runLease.id)) {
      await this.reconcileRunLease(runLeaseId);
    }
  }

  private completeStageRun(
    stageRun: StageRunRecord,
    issue: TrackedIssueRecord,
    thread: CodexThreadSummary,
    status: StageRunRecord["status"],
    params: { threadId: string; turnId?: string; nextLifecycleStatus?: TrackedIssueRecord["lifecycleStatus"] },
  ): void {
    const refreshedStageRun = this.stores.issueWorkflows.getStageRun(stageRun.id) ?? stageRun;
    const finalizedStageRun = {
      ...refreshedStageRun,
      status,
      threadId: params.threadId,
      ...(params.turnId ? { turnId: params.turnId } : {}),
    };
    const report = buildStageReport(finalizedStageRun, issue, thread, countEventMethods(this.stores.stageEvents.listThreadEvents(stageRun.id)));

    this.runAtomically(() => {
      this.finishLedgerRun(stageRun.projectId, stageRun.linearIssueId, "completed", {
        stageRunId: stageRun.id,
        threadId: params.threadId,
        ...(params.turnId ? { turnId: params.turnId } : {}),
        nextLifecycleStatus: params.nextLifecycleStatus ?? (issue.desiredStage ? "queued" : "completed"),
      });
      this.stores.workflowCoordinator.finishStageRun({
        stageRunId: stageRun.id,
        status,
        threadId: params.threadId,
        ...(params.turnId ? { turnId: params.turnId } : {}),
        summaryJson: JSON.stringify(extractStageSummary(report)),
        reportJson: JSON.stringify(report),
      });
    });

    void this.advanceAfterStageCompletion(stageRun, report);
  }

  private failStageRun(
    stageRun: StageRunRecord,
    threadId: string,
    message: string,
    options?: {
      turnId?: string;
    },
  ): void {
    this.runAtomically(() => {
      this.finishLedgerRun(stageRun.projectId, stageRun.linearIssueId, "failed", {
        stageRunId: stageRun.id,
        threadId,
        ...(options?.turnId ? { turnId: options.turnId } : {}),
        failureReason: message,
        nextLifecycleStatus: "failed",
      });
      this.stores.workflowCoordinator.finishStageRun({
        stageRunId: stageRun.id,
        status: "failed",
        threadId,
        ...(options?.turnId ? { turnId: options.turnId } : {}),
        summaryJson: JSON.stringify({ message }),
        reportJson: JSON.stringify(
          buildFailedStageReport(stageRun, "failed", {
            threadId,
            ...(options?.turnId ? { turnId: options.turnId } : {}),
          }),
        ),
      });
    });
  }

  private async failStageRunDuringReconciliation(
    stageRun: StageRunRecord,
    threadId: string,
    message: string,
    options?: {
      turnId?: string;
    },
  ): Promise<void> {
    this.failStageRun(stageRun, threadId, message, options);

    const issue = this.stores.issueWorkflows.getTrackedIssue(stageRun.projectId, stageRun.linearIssueId);
    const project = this.config.projects.find((candidate) => candidate.id === stageRun.projectId);
    if (!issue || !project) {
      return;
    }

    await syncFailedStageToLinear({
      stores: this.stores,
      linearProvider: this.linearProvider,
      project,
      issue,
      stageRun: {
        ...stageRun,
        threadId,
        ...(options?.turnId ? { turnId: options.turnId } : {}),
      },
      message,
      mode: "failed",
      requireActiveLinearStateMatch: true,
    });
  }

  private async failStageRunAndSync(
    stageRun: StageRunRecord,
    issue: TrackedIssueRecord,
    threadId: string,
    message: string,
    options?: {
      turnId?: string;
    },
  ): Promise<void> {
    this.failStageRun(stageRun, threadId, message, options);

    const project = this.config.projects.find((candidate) => candidate.id === stageRun.projectId);
    if (!project) {
      return;
    }

    await syncFailedStageToLinear({
      stores: this.stores,
      linearProvider: this.linearProvider,
      project,
      issue,
      stageRun: {
        ...stageRun,
        threadId,
        ...(options?.turnId ? { turnId: options.turnId } : {}),
      },
      message,
      mode: "failed",
    });
  }

  async flushQueuedTurnInputs(stageRun: StageRunRecord): Promise<void> {
    await this.inputDispatcher.flush(stageRun);
  }

  private async advanceAfterStageCompletion(stageRun: StageRunRecord, report: StageReport): Promise<void> {
    await this.maybeQueueAutomaticTransition(stageRun, report);
    await this.lifecyclePublisher.publishStageCompletion(stageRun, this.enqueueIssue);
  }

  private async maybeQueueAutomaticTransition(stageRun: StageRunRecord, report: StageReport): Promise<void> {
    const refreshedIssue = this.stores.issueWorkflows.getTrackedIssue(stageRun.projectId, stageRun.linearIssueId);
    if (!refreshedIssue) {
      return;
    }

    const project = this.config.projects.find((candidate) => candidate.id === stageRun.projectId);
    if (!project) {
      return;
    }

    const handoff = parseStageHandoff(project, report.assistantMessages, refreshedIssue.selectedWorkflowId);
    if (!handoff) {
      return;
    }

    const linear = await this.linearProvider.forProject(stageRun.projectId);
    if (!linear) {
      return;
    }

    const linearIssue = await linear.getIssue(stageRun.linearIssueId).catch(() => undefined);
    if (!linearIssue) {
      return;
    }

    const authoritativeStopState = resolveAuthoritativeLinearStopState(linearIssue);
    if (authoritativeStopState) {
      this.syncIssueToAuthoritativeLinearStopState(stageRun, refreshedIssue, authoritativeStopState);
      return;
    }

    if (refreshedIssue.desiredStage) {
      return;
    }

    const continuationPrecondition = await this.checkAutomaticContinuationPreconditions(
      stageRun,
      refreshedIssue,
      linear,
      linearIssue,
    );
    if (!continuationPrecondition.allowed) {
      this.feed?.publish({
        level: "info",
        kind: "workflow",
        issueKey: refreshedIssue.issueKey,
        projectId: stageRun.projectId,
        stage: stageRun.stage,
        ...(refreshedIssue.selectedWorkflowId ? { workflowId: refreshedIssue.selectedWorkflowId } : {}),
        status: "transition_suppressed",
        summary: `Suppressed automatic continuation after ${stageRun.stage}`,
        detail: continuationPrecondition.reason,
      });
      return;
    }

    const nextTarget = this.resolveTransitionTarget(project, stageRun, refreshedIssue.selectedWorkflowId, handoff);
    if (nextTarget === "done") {
      const doneState = resolveDoneLinearState(linearIssue);
      if (!doneState) {
        await this.routeStageToHumanNeeded(project, stageRun, linearIssue, "PatchRelay could not determine the repo's done state.");
        return;
      }

      this.feed?.publish({
        level: "info",
        kind: "workflow",
        issueKey: refreshedIssue.issueKey,
        projectId: stageRun.projectId,
        stage: stageRun.stage,
        ...(refreshedIssue.selectedWorkflowId ? { workflowId: refreshedIssue.selectedWorkflowId } : {}),
        status: "completed",
        summary: `Completed workflow after ${stageRun.stage}`,
      });
      await linear.setIssueState(stageRun.linearIssueId, doneState);
      this.stores.workflowCoordinator.setIssueDesiredStage(stageRun.projectId, stageRun.linearIssueId, undefined, {
        lifecycleStatus: "completed",
      });
      this.stores.workflowCoordinator.upsertTrackedIssue({
        projectId: stageRun.projectId,
        linearIssueId: stageRun.linearIssueId,
        currentLinearState: doneState,
        lifecycleStatus: "completed",
      });
      return;
    }

    if (nextTarget === "human_needed") {
      await this.routeStageToHumanNeeded(
        project,
        stageRun,
        linearIssue,
        handoff.nextLikelyStageText
          ? `PatchRelay could not safely continue from "${handoff.nextLikelyStageText}".`
          : handoff.suggestsHumanNeeded
            ? "PatchRelay needs human input before the next stage is clear."
            : `PatchRelay could not map the ${stageRun.stage} result to an allowed next transition.`,
      );
      return;
    }

    if (nextTarget === stageRun.stage) {
      await this.routeStageToHumanNeeded(
        project,
        stageRun,
        linearIssue,
        `PatchRelay received ${nextTarget} as the next stage again and needs a human to confirm the intended loop.`,
      );
      return;
    }

    if (this.isTransitionAlreadyInFlight(stageRun, nextTarget)) {
      this.feed?.publish({
        level: "info",
        kind: "workflow",
        issueKey: refreshedIssue.issueKey,
        projectId: stageRun.projectId,
        stage: stageRun.stage,
        ...(refreshedIssue.selectedWorkflowId ? { workflowId: refreshedIssue.selectedWorkflowId } : {}),
        nextStage: nextTarget,
        status: "transition_in_progress",
        summary: `${nextTarget} is already queued or running`,
        detail: `PatchRelay kept ${stageRun.stage} completion from re-queueing ${nextTarget}.`,
      });
      return;
    }

    this.feed?.publish({
      level: "info",
      kind: "workflow",
      issueKey: refreshedIssue.issueKey,
      projectId: stageRun.projectId,
      stage: stageRun.stage,
      ...(refreshedIssue.selectedWorkflowId ? { workflowId: refreshedIssue.selectedWorkflowId } : {}),
      nextStage: nextTarget,
      status: "transition_chosen",
      summary: `Chose ${stageRun.stage} -> ${nextTarget}`,
      detail: handoff.nextLikelyStageText ? `Stage result suggested "${handoff.nextLikelyStageText}".` : "PatchRelay used the workflow policy default.",
    });
    this.stores.workflowCoordinator.setIssueDesiredStage(stageRun.projectId, stageRun.linearIssueId, nextTarget, {
      desiredWebhookId: `auto-transition:${stageRun.id}:${nextTarget}`,
      lifecycleStatus: "queued",
    });
  }

  private syncIssueToAuthoritativeLinearStopState(
    stageRun: StageRunRecord,
    issue: TrackedIssueRecord,
    stopState: { stateName: string; lifecycleStatus: "completed" | "paused" },
  ): void {
    this.stores.workflowCoordinator.setIssueDesiredStage(stageRun.projectId, stageRun.linearIssueId, undefined, {
      lifecycleStatus: stopState.lifecycleStatus,
    });
    this.stores.workflowCoordinator.upsertTrackedIssue({
      projectId: stageRun.projectId,
      linearIssueId: stageRun.linearIssueId,
      currentLinearState: stopState.stateName,
      lifecycleStatus: stopState.lifecycleStatus,
    });
    this.feed?.publish({
      level: "info",
      kind: "workflow",
      issueKey: issue.issueKey,
      projectId: stageRun.projectId,
      stage: stageRun.stage,
      ...(issue.selectedWorkflowId ? { workflowId: issue.selectedWorkflowId } : {}),
      status: stopState.lifecycleStatus === "completed" ? "completed" : "transition_suppressed",
      summary:
        stopState.lifecycleStatus === "completed"
          ? `Kept workflow completed after ${stageRun.stage}`
          : `Ignored stale ${stageRun.stage} completion`,
      detail:
        stopState.lifecycleStatus === "completed"
          ? `Live Linear state is already ${stopState.stateName}, so PatchRelay kept the issue finished.`
          : `Live Linear state is already ${stopState.stateName}, so PatchRelay kept the issue paused.`,
    });
  }

  private async checkAutomaticContinuationPreconditions(
    stageRun: StageRunRecord,
    issue: TrackedIssueRecord,
    linear: NonNullable<Awaited<ReturnType<LinearClientProvider["forProject"]>>>,
    linearIssue: { delegateId?: string },
  ): Promise<{ allowed: true } | { allowed: false; reason: string }> {
    const actorProfile = await linear.getActorProfile().catch(() => undefined);
    if (actorProfile?.actorId && linearIssue.delegateId && linearIssue.delegateId !== actorProfile.actorId) {
      return {
        allowed: false,
        reason: "The issue is no longer delegated to PatchRelay.",
      };
    }

    return { allowed: true };
  }

  private resolveTransitionTarget(
    project: AppConfig["projects"][number],
    stageRun: StageRunRecord,
    workflowDefinitionId: string | undefined,
    handoff: ReturnType<typeof parseStageHandoff>,
  ): WorkflowTransitionTarget {
    if (!handoff) {
      return "human_needed";
    }

    const requestedTarget = handoff.resolvedNextStage;
    if (requestedTarget) {
      return transitionTargetAllowed(project, stageRun.stage, requestedTarget, workflowDefinitionId) ? requestedTarget : "human_needed";
    }

    if (handoff.suggestsHumanNeeded) {
      return "human_needed";
    }

    return resolveDefaultTransitionTarget(project, stageRun.stage, workflowDefinitionId) ?? "human_needed";
  }

  private isTransitionAlreadyInFlight(stageRun: StageRunRecord, nextTarget: WorkflowStage): boolean {
    const refreshedIssue = this.stores.issueWorkflows.getTrackedIssue(stageRun.projectId, stageRun.linearIssueId);
    if (!refreshedIssue) {
      return false;
    }

    if (refreshedIssue.desiredStage === nextTarget) {
      return true;
    }

    const activeStageRun = this.resolveActiveStageRun(refreshedIssue);
    return activeStageRun !== undefined && activeStageRun.id !== stageRun.id && activeStageRun.stage === nextTarget;
  }

  private async routeStageToHumanNeeded(
    project: AppConfig["projects"][number],
    stageRun: StageRunRecord,
    linearIssue: { stateName?: string; workflowStates: Array<{ name: string; type?: string }> },
    reason: string,
  ): Promise<void> {
    const linear = await this.linearProvider.forProject(stageRun.projectId);
    if (!linear) {
      return;
    }
    const trackedIssue = this.stores.issueWorkflows.getTrackedIssue(stageRun.projectId, stageRun.linearIssueId);

    const fallbackState =
      resolveFallbackLinearState(
        project,
        stageRun.stage,
        trackedIssue?.selectedWorkflowId,
      ) ??
      linearIssue.workflowStates.find((state) => normalizeLinearState(state.name) === "human needed")?.name;
    if (fallbackState) {
      await linear.setIssueState(stageRun.linearIssueId, fallbackState);
    }

    this.stores.workflowCoordinator.setIssueDesiredStage(stageRun.projectId, stageRun.linearIssueId, undefined, {
      lifecycleStatus: "paused",
    });
    this.stores.workflowCoordinator.upsertTrackedIssue({
      projectId: stageRun.projectId,
      linearIssueId: stageRun.linearIssueId,
      ...(fallbackState ? { currentLinearState: fallbackState } : linearIssue.stateName ? { currentLinearState: linearIssue.stateName } : {}),
      lifecycleStatus: "paused",
    });
    this.feed?.publish({
      level: "warn",
      kind: "workflow",
      issueKey: trackedIssue?.issueKey,
      projectId: stageRun.projectId,
      stage: stageRun.stage,
      ...(trackedIssue?.selectedWorkflowId ? { workflowId: trackedIssue.selectedWorkflowId } : {}),
      status: "transition_suppressed",
      summary: `Paused after ${stageRun.stage}`,
      detail: reason,
    });
  }

  private finishLedgerRun(
    projectId: string,
    linearIssueId: string,
    status: "completed" | "failed" | "released",
    params: {
      stageRunId?: number;
      threadId?: string;
      turnId?: string;
      failureReason?: string;
      nextLifecycleStatus: TrackedIssueRecord["lifecycleStatus"];
    },
  ): void {
    const issueControl = this.stores.issueControl.getIssueControl(projectId, linearIssueId);
    const targetRunLeaseId = params.stageRunId ?? issueControl?.activeRunLeaseId;
    if (!targetRunLeaseId) {
      return;
    }
    const targetRunLease = this.stores.runLeases.getRunLease(targetRunLeaseId);
    if (!targetRunLease) {
      return;
    }

    this.stores.runLeases.finishRunLease({
      runLeaseId: targetRunLeaseId,
      status,
      ...(params.threadId ? { threadId: params.threadId } : {}),
      ...(params.turnId ? { turnId: params.turnId } : {}),
      ...(params.failureReason ? { failureReason: params.failureReason } : {}),
    });

    if (targetRunLease.workspaceOwnershipId !== undefined) {
      const workspace = this.stores.workspaceOwnership.getWorkspaceOwnership(targetRunLease.workspaceOwnershipId);
      if (workspace) {
        const workspaceOwnedByTargetRun =
          workspace.currentRunLeaseId === targetRunLeaseId ||
          (issueControl?.activeWorkspaceOwnershipId === workspace.id && issueControl.activeRunLeaseId === targetRunLeaseId);
        this.stores.workspaceOwnership.upsertWorkspaceOwnership({
          projectId,
          linearIssueId,
          branchName: workspace.branchName,
          worktreePath: workspace.worktreePath,
          status:
            workspaceOwnedByTargetRun
              ? status === "released"
                ? "released"
                : status === "completed"
                  ? "active"
                  : "paused"
              : workspace.status,
          ...(workspaceOwnedByTargetRun
            ? { currentRunLeaseId: null }
            : workspace.currentRunLeaseId !== undefined
              ? { currentRunLeaseId: workspace.currentRunLeaseId }
              : {}),
        });
      }
    }

    if (!issueControl?.activeRunLeaseId || issueControl.activeRunLeaseId !== targetRunLeaseId) {
      return;
    }

    this.stores.issueControl.upsertIssueControl({
      projectId,
      linearIssueId,
      activeRunLeaseId: null,
      ...(status === "released"
        ? { activeWorkspaceOwnershipId: null }
        : issueControl.activeWorkspaceOwnershipId !== undefined
          ? { activeWorkspaceOwnershipId: issueControl.activeWorkspaceOwnershipId }
        : {}),
      ...(issueControl.serviceOwnedCommentId ? { serviceOwnedCommentId: issueControl.serviceOwnedCommentId } : {}),
      ...(issueControl.activeAgentSessionId ? { activeAgentSessionId: issueControl.activeAgentSessionId } : {}),
      lifecycleStatus: params.nextLifecycleStatus,
    });
  }

  private async deliverPendingObligations(
    projectId: string,
    linearIssueId: string,
    threadId: string,
    turnId?: string,
  ): Promise<void> {
    if (!turnId) {
      return;
    }
    await this.inputDispatcher.flush(
      {
        id: 0,
        projectId,
        linearIssueId,
        threadId,
        turnId,
      },
      {
        retryInProgress: true,
      },
    );
  }

  private async reconcileRunLease(runLeaseId: number): Promise<void> {
    const snapshot = await buildReconciliationSnapshot({
      config: this.config,
      stores: {
        issueControl: this.stores.issueControl,
        runLeases: this.stores.runLeases,
        workspaceOwnership: this.stores.workspaceOwnership,
        obligations: this.stores.obligations,
      },
      codex: this.codex,
      linearProvider: this.linearProvider,
      runLeaseId,
    });
    if (!snapshot) {
      return;
    }

    if (await this.restartInterruptedRun(snapshot)) {
      return;
    }

    const decision = reconcileIssue(snapshot.input);

    if (decision.outcome === "hydrate_live_state") {
      throw new Error(
        `Startup reconciliation requires live state hydration for ${snapshot.runLease.projectId}:${snapshot.runLease.linearIssueId}: ${decision.reasons.join("; ")}`,
      );
    }

    await this.actionApplier.apply({
      snapshot,
      decision,
    });
  }

  private async restartInterruptedRun(snapshot: ReconciliationSnapshot): Promise<boolean> {
    const liveCodex = snapshot.input.live?.codex;
    const latestTurn = liveCodex?.status === "found" ? liveCodex.thread?.turns.at(-1) : undefined;
    if (latestTurn?.status !== "interrupted") {
      return false;
    }

    if (snapshot.runLease.turnId && latestTurn.id !== snapshot.runLease.turnId) {
      return true;
    }

    if (!snapshot.runLease.threadId || !snapshot.workspaceOwnership?.worktreePath) {
      return false;
    }

    const stageRun = this.findStageRunForIssue(snapshot.runLease.projectId, snapshot.runLease.linearIssueId, snapshot.runLease.threadId);
    if (!stageRun) {
      return false;
    }

    const issue = this.stores.issueWorkflows.getTrackedIssue(stageRun.projectId, stageRun.linearIssueId);
    const turn = await this.codex.startTurn({
      threadId: snapshot.runLease.threadId,
      cwd: snapshot.workspaceOwnership.worktreePath,
      input: buildRestartRecoveryPrompt(stageRun.stage),
    });

    this.stores.workflowCoordinator.updateStageRunThread({
      stageRunId: stageRun.id,
      threadId: snapshot.runLease.threadId,
      turnId: turn.turnId,
    });

    this.inputDispatcher.routePendingInputs(stageRun, snapshot.runLease.threadId, turn.turnId);
    await this.inputDispatcher.flush(
      {
        id: stageRun.id,
        projectId: stageRun.projectId,
        linearIssueId: stageRun.linearIssueId,
        threadId: snapshot.runLease.threadId,
        turnId: turn.turnId,
      },
      {
        logFailures: true,
        failureMessage: "Failed to deliver queued Linear comment during interrupted-turn recovery",
        ...(issue?.issueKey ? { issueKey: issue.issueKey } : {}),
      },
    );

    this.logger.info(
      {
        issueKey: issue?.issueKey,
        stage: stageRun.stage,
        threadId: snapshot.runLease.threadId,
        turnId: turn.turnId,
      },
      "Restarted interrupted Codex stage run during startup reconciliation",
    );
    this.feed?.publish({
      level: "info",
      kind: "stage",
      issueKey: issue?.issueKey,
      projectId: stageRun.projectId,
      stage: stageRun.stage,
      ...(issue?.selectedWorkflowId ? { workflowId: issue.selectedWorkflowId } : {}),
      status: "running",
      summary: `Recovered ${stageRun.stage} workflow after restart`,
      detail: `Turn ${turn.turnId} resumed on the existing thread.`,
    });
    return true;
  }

  private completeReconciledRun(
    projectId: string,
    linearIssueId: string,
    thread: CodexThreadSummary,
    params: { threadId: string; turnId?: string; nextLifecycleStatus?: TrackedIssueRecord["lifecycleStatus"] },
  ): void {
    const stageRun = this.findStageRunForIssue(projectId, linearIssueId, params.threadId);
    const issue = this.stores.issueWorkflows.getTrackedIssue(projectId, linearIssueId);
    if (!stageRun || !issue) {
      this.finishLedgerRun(projectId, linearIssueId, "completed", {
        threadId: params.threadId,
        ...(params.turnId ? { turnId: params.turnId } : {}),
        nextLifecycleStatus: params.nextLifecycleStatus ?? "completed",
      });
      return;
    }
    this.completeStageRun(stageRun, issue, thread, "completed", params);
  }

  private async failRunLeaseDuringReconciliation(
    projectId: string,
    linearIssueId: string,
    threadId: string,
    message: string,
    options?: { turnId?: string },
  ): Promise<void> {
    const stageRun = this.findStageRunForIssue(projectId, linearIssueId, threadId);
    if (!stageRun) {
      this.finishLedgerRun(projectId, linearIssueId, "failed", {
        threadId,
        ...(options?.turnId ? { turnId: options.turnId } : {}),
        failureReason: message,
        nextLifecycleStatus: "failed",
      });
      return;
    }
    await this.failStageRunDuringReconciliation(stageRun, threadId, message, options);
  }

  private async releaseRunDuringReconciliation(
    projectId: string,
    linearIssueId: string,
    params: {
      runId: number | string;
      threadId?: string;
      turnId?: string;
      nextLifecycleStatus?: TrackedIssueRecord["lifecycleStatus"];
      currentLinearState?: string;
    },
  ): Promise<void> {
    const runId = typeof params.runId === "number" ? params.runId : Number(params.runId);
    if (!Number.isFinite(runId)) {
      return;
    }

    this.runAtomically(() => {
      this.finishLedgerRun(projectId, linearIssueId, "released", {
        stageRunId: runId,
        ...(params.threadId ? { threadId: params.threadId } : {}),
        ...(params.turnId ? { turnId: params.turnId } : {}),
        nextLifecycleStatus: params.nextLifecycleStatus ?? "completed",
      });

      const existingIssue = this.stores.issueWorkflows.getTrackedIssue(projectId, linearIssueId);
      this.stores.workflowCoordinator.upsertTrackedIssue({
        projectId,
        linearIssueId,
        ...(params.currentLinearState
          ? { currentLinearState: params.currentLinearState }
          : existingIssue?.currentLinearState
            ? { currentLinearState: existingIssue.currentLinearState }
            : {}),
        lifecycleStatus: params.nextLifecycleStatus ?? "completed",
      });
    });

    const issue = this.stores.issueWorkflows.getTrackedIssue(projectId, linearIssueId);
    this.feed?.publish({
      level: "info",
      kind: "workflow",
      issueKey: issue?.issueKey,
      projectId,
      ...(issue?.selectedWorkflowId ? { workflowId: issue.selectedWorkflowId } : {}),
      status: params.nextLifecycleStatus === "paused" ? "transition_suppressed" : "completed",
      summary:
        params.nextLifecycleStatus === "paused"
          ? "Released stale run after terminal Linear pause"
          : "Released stale run after terminal Linear completion",
      detail: params.currentLinearState ? `Live Linear state is already ${params.currentLinearState}.` : undefined,
    });
  }

  private findStageRunForIssue(projectId: string, linearIssueId: string, threadId?: string): StageRunRecord | undefined {
    return (threadId ? this.stores.issueWorkflows.getStageRunByThreadId(threadId) : undefined) ??
      this.stores.issueWorkflows.getLatestStageRunForIssue(projectId, linearIssueId);
  }

  private resolveActiveStageRun(issue: TrackedIssueRecord): StageRunRecord | undefined {
    const issueControl = this.stores.issueControl.getIssueControl(issue.projectId, issue.linearIssueId);
    if (issueControl?.activeRunLeaseId !== undefined) {
      const directStageRun = this.stores.issueWorkflows.getStageRun(issueControl.activeRunLeaseId);
      if (directStageRun) {
        return directStageRun;
      }

      const runLease = this.stores.runLeases.getRunLease(issueControl.activeRunLeaseId);
      if (runLease) {
        return {
          id: runLease.id,
          pipelineRunId: runLease.id,
          projectId: runLease.projectId,
          linearIssueId: runLease.linearIssueId,
          workspaceId: runLease.workspaceOwnershipId,
          stage: runLease.stage,
          status: runLease.status === "failed" ? "failed" : runLease.status === "completed" || runLease.status === "released" ? "completed" : "running",
          triggerWebhookId: "ledger-trigger",
          workflowFile: runLease.workflowFile,
          promptText: runLease.promptText,
          ...(runLease.threadId ? { threadId: runLease.threadId } : {}),
          ...(runLease.parentThreadId ? { parentThreadId: runLease.parentThreadId } : {}),
          ...(runLease.turnId ? { turnId: runLease.turnId } : {}),
          startedAt: runLease.startedAt,
          ...(runLease.endedAt ? { endedAt: runLease.endedAt } : {}),
        };
      }
    }
    return undefined;
  }
}

function consoleLogger(): Logger {
  const noop = () => undefined;
  return {
    fatal: noop,
    error: noop,
    warn: noop,
    info: noop,
    debug: noop,
    trace: noop,
    silent: noop,
    child: () => consoleLogger(),
    level: "silent",
  } as unknown as Logger;
}

function buildRestartRecoveryPrompt(stage: StageRunRecord["stage"]): string {
  return [
    `PatchRelay restarted while the ${stage} workflow was mid-turn.`,
    "Resume the existing work from the current worktree state on this same thread.",
    "Inspect any uncommitted changes you already made before continuing.",
    "Continue from the interrupted point instead of restarting the task from scratch.",
    "When the work is actually complete, finish the normal workflow handoff for this stage.",
  ].join("\n");
}

function normalizeLinearState(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed.toLowerCase() : undefined;
}
