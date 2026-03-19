import type { Logger } from "pino";
import {
  buildAwaitingHandoffSessionPlan,
  buildCompletedSessionPlan,
  buildPreparingSessionPlan,
  buildRunningSessionPlan,
} from "./agent-session-plan.ts";
import { buildAgentSessionExternalUrls } from "./agent-session-presentation.ts";
import type { CodexAppServerClient, CodexNotification } from "./codex-app-server.ts";
import type { PatchRelayDatabase } from "./db.ts";
import type { IssueRecord, RunRecord, StageRunRecord, TrackedIssueRecord } from "./db-types.ts";
import {
  resolveActiveLinearState,
  resolveAuthoritativeLinearStopState,
  resolveDoneLinearState,
  resolveFallbackLinearState,
  resolveWorkflowLabelCleanup,
  resolveWorkflowLabelNames,
} from "./linear-workflow.ts";
import type { OperatorEventFeed } from "./operator-feed.ts";
import { buildStageLaunchPlan, isCodexThreadId } from "./stage-launch.ts";
import { syncFailedStageToLinear } from "./stage-failure.ts";
import { parseStageHandoff } from "./stage-handoff.ts";
import {
  buildFailedStageReport,
  buildStageReport,
  countEventMethods,
  extractStageSummary,
  extractTurnId,
  resolveStageRunStatus,
  summarizeCurrentThread,
} from "./stage-reporting.ts";
import { resolveDefaultTransitionTarget, transitionTargetAllowed, type WorkflowTransitionTarget } from "./workflow-policy.ts";
import { WorktreeManager } from "./worktree-manager.ts";
import type {
  AppConfig,
  CodexThreadSummary,
  LinearClient,
  LinearClientProvider,
  StageReport,
  WorkflowStage,
} from "./types.ts";
import { sanitizeDiagnosticText } from "./utils.ts";

export class StageExecutor {
  private readonly worktreeManager: WorktreeManager;

  constructor(
    private readonly config: AppConfig,
    private readonly db: PatchRelayDatabase,
    private readonly codex: CodexAppServerClient,
    private readonly linearProvider: LinearClientProvider,
    private readonly enqueueIssue: (projectId: string, issueId: string) => void,
    private readonly logger: Logger,
    private readonly feed?: OperatorEventFeed,
  ) {
    this.worktreeManager = new WorktreeManager(config);
  }

  // ─── Launch ───────────────────────────────────────────────────────

  async run(item: { projectId: string; issueId: string }): Promise<void> {
    const project = this.config.projects.find((p) => p.id === item.projectId);
    if (!project) {
      this.logger.info({ projectId: item.projectId }, "Stage executor: no matching project config");
      return;
    }

    const issue = this.db.getIssue(item.projectId, item.issueId);
    if (!issue?.desiredStage || issue.activeRunId !== undefined) {
      this.logger.info(
        { projectId: item.projectId, issueId: item.issueId, desiredStage: issue?.desiredStage, activeRunId: issue?.activeRunId, issueFound: !!issue },
        "Stage executor: skipping issue (no desired stage or active run exists)",
      );
      return;
    }

    const desiredStage = issue.desiredStage;

    // Verify issue still active via Linear
    const trackedIssue = this.db.issueToTrackedIssue(issue);
    const liveIssue = await this.linearProvider
      .forProject(project.id)
      .then((linear) => linear?.getIssue(item.issueId))
      .catch(() => undefined);

    const authoritativeStopState = liveIssue ? resolveAuthoritativeLinearStopState(liveIssue) : undefined;
    if (authoritativeStopState) {
      this.db.upsertIssue({
        projectId: item.projectId,
        linearIssueId: item.issueId,
        desiredStage: null,
        currentLinearState: authoritativeStopState.stateName,
        lifecycleStatus: authoritativeStopState.lifecycleStatus,
      });
      return;
    }

    if (issue.lifecycleStatus === "completed" || issue.lifecycleStatus === "paused") {
      this.feed?.publish({
        level: "info",
        kind: "workflow",
        issueKey: issue.issueKey,
        projectId: item.projectId,
        stage: desiredStage,
        status: issue.lifecycleStatus === "completed" ? "completed" : "transition_suppressed",
        summary: `Skipped ${desiredStage} because the issue is already ${issue.lifecycleStatus}`,
      });
      return;
    }

    // Build launch plan
    const stageHistory = this.db.listStageRunsForIssue(item.projectId, item.issueId);
    const previousStageRun = stageHistory.at(-1);
    const plan = buildStageLaunchPlan(project, trackedIssue, desiredStage, {
      ...(previousStageRun ? { previousStageRun } : {}),
      ...(issue.branchName && issue.worktreePath
        ? { workspace: { branchName: issue.branchName, worktreePath: issue.worktreePath } }
        : {}),
      stageHistory,
    });
    const branchName = issue.branchName ?? plan.branchName;
    const worktreePath = issue.worktreePath ?? plan.worktreePath;

    // Claim the run atomically
    const run = this.db.transaction(() => {
      const freshIssue = this.db.getIssue(item.projectId, item.issueId);
      if (!freshIssue?.desiredStage || freshIssue.activeRunId !== undefined) return undefined;

      const created = this.db.createRun({
        issueId: freshIssue.id,
        projectId: item.projectId,
        linearIssueId: item.issueId,
        stage: desiredStage,
        workflowFile: plan.workflowFile,
        promptText: plan.prompt,
      });
      this.db.upsertIssue({
        projectId: item.projectId,
        linearIssueId: item.issueId,
        desiredStage: null,
        activeRunId: created.id,
        branchName,
        worktreePath,
        lifecycleStatus: "running",
      });
      return created;
    });
    if (!run) return;

    this.feed?.publish({
      level: "info",
      kind: "stage",
      issueKey: issue.issueKey,
      projectId: item.projectId,
      stage: desiredStage,
      status: "starting",
      summary: `Starting ${desiredStage} workflow`,
    });

    let threadId: string;
    let parentThreadId: string | undefined;
    let turnId: string;
    try {
      await this.worktreeManager.ensureIssueWorktree(
        project.repoPath,
        project.worktreeRoot,
        worktreePath,
        branchName,
        { allowExistingOutsideRoot: issue.branchName !== undefined },
      );

      // Set Linear state to active
      await this.markStageActive(project, trackedIssue, desiredStage);

      // Start Codex thread
      const prevCompleted = previousStageRun?.status === "completed" && isCodexThreadId(previousStageRun.threadId)
        ? previousStageRun.threadId
        : undefined;
      parentThreadId = prevCompleted;
      const thread = await this.codex.startThread({ cwd: worktreePath });
      threadId = thread.id;

      const turn = await this.codex.startTurn({ threadId, cwd: worktreePath, input: plan.prompt });
      turnId = turn.turnId;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      await this.markLaunchFailed(project, trackedIssue, run, err.message);
      this.logger.error(
        { issueKey: issue.issueKey, stage: desiredStage, error: err.message },
        "Failed to launch Codex stage run",
      );
      this.feed?.publish({
        level: "error",
        kind: "stage",
        issueKey: issue.issueKey,
        projectId: item.projectId,
        stage: desiredStage,
        status: "failed",
        summary: `Failed to launch ${desiredStage} workflow`,
        detail: err.message,
      });
      throw err;
    }

    this.db.updateRunThread(run.id, {
      threadId,
      ...(parentThreadId ? { parentThreadId } : {}),
      turnId,
    });
    this.db.upsertIssue({
      projectId: item.projectId,
      linearIssueId: item.issueId,
      threadId,
    });

    // Publish started to agent session
    const refreshedIssue = this.db.issueToTrackedIssue(this.db.getIssue(item.projectId, item.issueId)!);
    await this.publishStageStarted(refreshedIssue, desiredStage);

    this.logger.info(
      { issueKey: issue.issueKey, stage: desiredStage, threadId, turnId },
      "Started Codex stage run",
    );
    this.feed?.publish({
      level: "info",
      kind: "stage",
      issueKey: issue.issueKey,
      projectId: item.projectId,
      stage: desiredStage,
      status: "running",
      summary: `Started ${desiredStage} workflow`,
      detail: `Turn ${turnId} is running in ${branchName}.`,
    });
  }

  // ─── Notification handler ─────────────────────────────────────────

  async handleCodexNotification(notification: CodexNotification): Promise<void> {
    const threadId = typeof notification.params.threadId === "string" ? notification.params.threadId : undefined;
    if (!threadId) return;

    const run = this.db.getRunByThreadId(threadId);
    if (!run) return;

    const turnId = typeof notification.params.turnId === "string" ? notification.params.turnId : undefined;
    if (this.config.runner.codex.persistExtendedHistory) {
      this.db.saveThreadEvent({
        runId: run.id,
        threadId,
        ...(turnId ? { turnId } : {}),
        method: notification.method,
        eventJson: JSON.stringify(notification.params),
      });
    }

    if (notification.method !== "turn/completed") return;

    const thread = await this.codex.readThread(threadId, true);
    const issue = this.db.getIssue(run.projectId, run.linearIssueId);
    if (!issue) return;

    const completedTurnId = extractTurnId(notification.params);
    const status = resolveStageRunStatus(notification.params);
    const trackedIssue = this.db.issueToTrackedIssue(issue);
    const stageRun = this.db.runToStageRun(run);

    if (status === "failed") {
      this.feed?.publish({
        level: "error",
        kind: "turn",
        issueKey: issue.issueKey,
        projectId: run.projectId,
        stage: run.stage,
        status: "failed",
        summary: `Turn failed for ${run.stage}`,
      });
      await this.failStageRunAndSync(stageRun, trackedIssue, threadId, "Codex reported the turn completed in a failed state", {
        ...(completedTurnId ? { turnId: completedTurnId } : {}),
      });
      return;
    }

    this.feed?.publish({
      level: "info",
      kind: "turn",
      issueKey: issue.issueKey,
      projectId: run.projectId,
      stage: run.stage,
      status: "completed",
      summary: `Turn completed for ${run.stage}`,
      detail: summarizeCurrentThread(thread).latestAgentMessage,
    });

    this.completeStageRun(stageRun, trackedIssue, thread, status, {
      threadId,
      ...(completedTurnId ? { turnId: completedTurnId } : {}),
    });
  }

  // ─── Active status for query ──────────────────────────────────────

  async getActiveStageStatus(issueKey: string) {
    const issue = this.db.getIssueByKey(issueKey);
    if (!issue?.activeRunId) return undefined;

    const run = this.db.getRun(issue.activeRunId);
    if (!run?.threadId) return undefined;

    const stageRun = this.db.runToStageRun(run);
    const trackedIssue = this.db.issueToTrackedIssue(issue);
    const thread = await this.codex.readThread(run.threadId, true).catch(() => undefined);

    return {
      issue: trackedIssue,
      stageRun,
      ...(thread ? { liveThread: summarizeCurrentThread(thread) } : {}),
    };
  }

  // ─── Reconciliation ───────────────────────────────────────────────

  async reconcileActiveStageRuns(): Promise<void> {
    for (const run of this.db.listRunningRuns()) {
      await this.reconcileRun(run);
    }
  }

  private async reconcileRun(run: RunRecord): Promise<void> {
    if (!run.threadId) {
      this.failRunAndClear(run, "Run has no thread ID during reconciliation");
      return;
    }

    const issue = this.db.getIssue(run.projectId, run.linearIssueId);
    if (!issue) return;

    // Read Codex state
    let thread: CodexThreadSummary | undefined;
    try {
      thread = await this.codex.readThread(run.threadId, true);
    } catch {
      // Thread missing - fail the run
      this.failRunAndClear(run, "Codex thread not found during reconciliation");
      const project = this.config.projects.find((p) => p.id === run.projectId);
      if (project) {
        await syncFailedStageToLinear({
          stores: { linearInstallations: this.db.linearInstallations, issueWorkflows: this.db as any, workflowCoordinator: this.db as any },
          linearProvider: this.linearProvider,
          project,
          issue: this.db.issueToTrackedIssue(issue),
          stageRun: this.db.runToStageRun(run),
          message: "Codex thread not found during reconciliation",
          mode: "failed",
        });
      }
      return;
    }

    const latestTurn = thread.turns.at(-1);

    // Check Linear state
    const linear = await this.linearProvider.forProject(run.projectId);
    if (linear) {
      const linearIssue = await linear.getIssue(run.linearIssueId).catch(() => undefined);
      if (linearIssue) {
        const stopState = resolveAuthoritativeLinearStopState(linearIssue);
        if (stopState) {
          this.db.transaction(() => {
            this.db.finishRun(run.id, { status: "released" });
            this.db.upsertIssue({
              projectId: run.projectId,
              linearIssueId: run.linearIssueId,
              activeRunId: null,
              currentLinearState: stopState.stateName,
              lifecycleStatus: stopState.lifecycleStatus,
            });
          });
          return;
        }
      }
    }

    // Handle interrupted turn - restart
    if (latestTurn?.status === "interrupted") {
      if (!issue.worktreePath) return;
      try {
        const turn = await this.codex.startTurn({
          threadId: run.threadId,
          cwd: issue.worktreePath,
          input: buildRestartRecoveryPrompt(run.stage),
        });
        this.db.updateRunTurnId(run.id, turn.turnId);
        this.logger.info(
          { issueKey: issue.issueKey, stage: run.stage, threadId: run.threadId, turnId: turn.turnId },
          "Restarted interrupted Codex stage run during reconciliation",
        );
        this.feed?.publish({
          level: "info",
          kind: "stage",
          issueKey: issue.issueKey,
          projectId: run.projectId,
          stage: run.stage,
          status: "running",
          summary: `Recovered ${run.stage} workflow after restart`,
        });
      } catch (error) {
        this.failRunAndClear(run, `Failed to restart interrupted turn: ${error instanceof Error ? error.message : String(error)}`);
      }
      return;
    }

    // Handle completed turn discovered during reconciliation
    if (latestTurn?.status === "completed") {
      const trackedIssue = this.db.issueToTrackedIssue(issue);
      const stageRun = this.db.runToStageRun(run);
      this.completeStageRun(stageRun, trackedIssue, thread, "completed", {
        threadId: run.threadId,
        ...(latestTurn.id ? { turnId: latestTurn.id } : {}),
      });
    }
  }

  // ─── Internal helpers ─────────────────────────────────────────────

  private completeStageRun(
    stageRun: StageRunRecord,
    issue: TrackedIssueRecord,
    thread: CodexThreadSummary,
    status: StageRunRecord["status"],
    params: { threadId: string; turnId?: string },
  ): void {
    const report = buildStageReport(
      { ...stageRun, status, threadId: params.threadId, ...(params.turnId ? { turnId: params.turnId } : {}) },
      issue,
      thread,
      countEventMethods(this.db.listThreadEvents(stageRun.id)),
    );

    this.db.transaction(() => {
      this.db.finishRun(stageRun.id, {
        status: "completed",
        threadId: params.threadId,
        ...(params.turnId ? { turnId: params.turnId } : {}),
        summaryJson: JSON.stringify(extractStageSummary(report)),
        reportJson: JSON.stringify(report),
      });
      this.db.upsertIssue({
        projectId: stageRun.projectId,
        linearIssueId: stageRun.linearIssueId,
        activeRunId: null,
        lifecycleStatus: issue.desiredStage ? "queued" : "completed",
      });
    });

    void this.advanceAfterStageCompletion(stageRun, issue, report);
  }

  private async failStageRunAndSync(
    stageRun: StageRunRecord,
    issue: TrackedIssueRecord,
    threadId: string,
    message: string,
    options?: { turnId?: string },
  ): Promise<void> {
    this.db.transaction(() => {
      this.db.finishRun(stageRun.id, {
        status: "failed",
        threadId,
        ...(options?.turnId ? { turnId: options.turnId } : {}),
        failureReason: message,
        summaryJson: JSON.stringify({ message }),
        reportJson: JSON.stringify(buildFailedStageReport(stageRun, "failed", { threadId, ...(options?.turnId ? { turnId: options.turnId } : {}) })),
      });
      this.db.upsertIssue({
        projectId: stageRun.projectId,
        linearIssueId: stageRun.linearIssueId,
        activeRunId: null,
        lifecycleStatus: "failed",
      });
    });

    const project = this.config.projects.find((p) => p.id === stageRun.projectId);
    if (project) {
      await syncFailedStageToLinear({
        stores: { linearInstallations: this.db.linearInstallations, issueWorkflows: this.db as any, workflowCoordinator: this.db as any },
        linearProvider: this.linearProvider,
        project,
        issue,
        stageRun: { ...stageRun, threadId, ...(options?.turnId ? { turnId: options.turnId } : {}) },
        message,
        mode: "failed",
      });
    }
  }

  private failRunAndClear(run: RunRecord, message: string): void {
    this.db.transaction(() => {
      this.db.finishRun(run.id, { status: "failed", failureReason: message });
      this.db.upsertIssue({
        projectId: run.projectId,
        linearIssueId: run.linearIssueId,
        activeRunId: null,
        lifecycleStatus: "failed",
      });
    });
  }

  private async markLaunchFailed(
    project: AppConfig["projects"][number],
    issue: TrackedIssueRecord,
    run: RunRecord,
    message: string,
  ): Promise<void> {
    const failureThreadId = `launch-failed-${run.id}`;
    const stageRun = this.db.runToStageRun(run);
    this.db.transaction(() => {
      this.db.finishRun(run.id, {
        status: "failed",
        threadId: failureThreadId,
        failureReason: message,
        summaryJson: JSON.stringify({ message }),
        reportJson: JSON.stringify(buildFailedStageReport(stageRun, "failed", { threadId: failureThreadId })),
      });
      this.db.upsertIssue({
        projectId: run.projectId,
        linearIssueId: run.linearIssueId,
        activeRunId: null,
        lifecycleStatus: "failed",
      });
    });

    await syncFailedStageToLinear({
      stores: { linearInstallations: this.db.linearInstallations, issueWorkflows: this.db as any, workflowCoordinator: this.db as any },
      linearProvider: this.linearProvider,
      project,
      issue,
      stageRun: { ...stageRun, threadId: failureThreadId },
      message,
      mode: "launch",
    });
  }

  // ─── Automatic transitions ────────────────────────────────────────

  private async advanceAfterStageCompletion(stageRun: StageRunRecord, issue: TrackedIssueRecord, report: StageReport): Promise<void> {
    await this.maybeQueueAutomaticTransition(stageRun, report);
    await this.publishStageCompletion(stageRun);
  }

  private async maybeQueueAutomaticTransition(stageRun: StageRunRecord, report: StageReport): Promise<void> {
    const freshIssue = this.db.getIssue(stageRun.projectId, stageRun.linearIssueId);
    if (!freshIssue) return;
    const trackedIssue = this.db.issueToTrackedIssue(freshIssue);

    const project = this.config.projects.find((p) => p.id === stageRun.projectId);
    if (!project) return;

    const handoff = parseStageHandoff(project, report.assistantMessages, trackedIssue.selectedWorkflowId);

    const linear = await this.linearProvider.forProject(stageRun.projectId);
    if (!linear) return;

    const linearIssue = await linear.getIssue(stageRun.linearIssueId).catch(() => undefined);
    if (!linearIssue) return;

    const authoritativeStopState = resolveAuthoritativeLinearStopState(linearIssue);
    if (authoritativeStopState) {
      this.db.upsertIssue({
        projectId: stageRun.projectId,
        linearIssueId: stageRun.linearIssueId,
        desiredStage: null,
        currentLinearState: authoritativeStopState.stateName,
        lifecycleStatus: authoritativeStopState.lifecycleStatus,
      });
      return;
    }

    // Check continuation preconditions
    const precondition = await this.checkContinuationPreconditions(stageRun, freshIssue, linear, linearIssue);
    if (!precondition.allowed) {
      this.feed?.publish({
        level: "info",
        kind: "workflow",
        issueKey: freshIssue.issueKey,
        projectId: stageRun.projectId,
        stage: stageRun.stage,
        status: "transition_suppressed",
        summary: `Suppressed automatic continuation after ${stageRun.stage}`,
        detail: precondition.reason,
      });
      return;
    }

    const nextTarget = this.resolveTransitionTarget(project, stageRun, trackedIssue.selectedWorkflowId, handoff);
    if (nextTarget === "done") {
      const doneState = resolveDoneLinearState(linearIssue);
      if (!doneState) {
        await this.routeToHumanNeeded(project, stageRun, linearIssue, "PatchRelay could not determine the repo's done state.");
        return;
      }
      await linear.setIssueState(stageRun.linearIssueId, doneState);
      this.db.upsertIssue({
        projectId: stageRun.projectId,
        linearIssueId: stageRun.linearIssueId,
        desiredStage: null,
        currentLinearState: doneState,
        lifecycleStatus: "completed",
      });
      return;
    }

    if (nextTarget === "human_needed") {
      await this.routeToHumanNeeded(project, stageRun, linearIssue,
        handoff?.nextLikelyStageText
          ? `PatchRelay could not safely continue from "${handoff.nextLikelyStageText}".`
          : handoff?.suggestsHumanNeeded
            ? "PatchRelay needs human input before the next stage is clear."
            : `PatchRelay could not map the ${stageRun.stage} result to an allowed next transition.`,
      );
      return;
    }

    if (nextTarget === stageRun.stage) {
      await this.routeToHumanNeeded(project, stageRun, linearIssue,
        `PatchRelay received ${nextTarget} as the next stage again and needs a human to confirm the intended loop.`,
      );
      return;
    }

    // Check if already in flight
    if (freshIssue.desiredStage === nextTarget || (freshIssue.activeRunId && this.db.getRun(freshIssue.activeRunId)?.stage === nextTarget)) {
      return;
    }

    this.feed?.publish({
      level: "info",
      kind: "workflow",
      issueKey: freshIssue.issueKey,
      projectId: stageRun.projectId,
      stage: stageRun.stage,
      nextStage: nextTarget,
      status: "transition_chosen",
      summary: `Chose ${stageRun.stage} -> ${nextTarget}`,
    });

    this.db.upsertIssue({
      projectId: stageRun.projectId,
      linearIssueId: stageRun.linearIssueId,
      desiredStage: nextTarget,
      lifecycleStatus: "queued",
    });
  }

  private async checkContinuationPreconditions(
    stageRun: StageRunRecord,
    issue: IssueRecord,
    linear: LinearClient,
    linearIssue: { delegateId?: string },
  ): Promise<{ allowed: true } | { allowed: false; reason: string }> {
    // Check delegation
    const actorProfile = await linear.getActorProfile().catch(() => undefined);
    if (actorProfile?.actorId && linearIssue.delegateId && linearIssue.delegateId !== actorProfile.actorId) {
      return { allowed: false, reason: "The issue is no longer delegated to PatchRelay." };
    }

    // Check active run ownership
    if (issue.activeRunId !== undefined && issue.activeRunId !== stageRun.id) {
      return { allowed: false, reason: "Another stage run already owns the issue." };
    }

    // Check desired stage conflicts
    if (issue.desiredStage) {
      return { allowed: false, reason: `The issue is already queued for ${issue.desiredStage}.` };
    }

    // Check continuation barrier
    const run = this.db.getRun(stageRun.id);
    if (issue.continuationBarrierAt && run?.startedAt && issue.continuationBarrierAt > run.startedAt) {
      return { allowed: false, reason: "A newer human or operator interrupt arrived after the stage started." };
    }

    return { allowed: true };
  }

  private resolveTransitionTarget(
    project: AppConfig["projects"][number],
    stageRun: StageRunRecord,
    workflowId: string | undefined,
    handoff: ReturnType<typeof parseStageHandoff>,
  ): WorkflowTransitionTarget {
    if (!handoff) return resolveDefaultTransitionTarget(project, stageRun.stage, workflowId) ?? "human_needed";
    const requested = handoff.resolvedNextStage;
    if (requested) {
      return transitionTargetAllowed(project, stageRun.stage, requested, workflowId) ? requested : "human_needed";
    }
    if (handoff.suggestsHumanNeeded) return "human_needed";
    return resolveDefaultTransitionTarget(project, stageRun.stage, workflowId) ?? "human_needed";
  }

  private async routeToHumanNeeded(
    project: AppConfig["projects"][number],
    stageRun: StageRunRecord,
    linearIssue: { stateName?: string; workflowStates: Array<{ name: string; type?: string }> },
    reason: string,
  ): Promise<void> {
    const linear = await this.linearProvider.forProject(stageRun.projectId);
    if (!linear) return;

    const issue = this.db.getIssue(stageRun.projectId, stageRun.linearIssueId);
    const fallbackState = resolveFallbackLinearState(project, stageRun.stage, issue?.selectedWorkflowId) ??
      linearIssue.workflowStates.find((s) => s.name.trim().toLowerCase() === "human needed")?.name;
    if (fallbackState) await linear.setIssueState(stageRun.linearIssueId, fallbackState);

    this.db.upsertIssue({
      projectId: stageRun.projectId,
      linearIssueId: stageRun.linearIssueId,
      desiredStage: null,
      ...(fallbackState ? { currentLinearState: fallbackState } : linearIssue.stateName ? { currentLinearState: linearIssue.stateName } : {}),
      lifecycleStatus: "paused",
    });

    this.feed?.publish({
      level: "warn",
      kind: "workflow",
      issueKey: issue?.issueKey,
      projectId: stageRun.projectId,
      stage: stageRun.stage,
      status: "transition_suppressed",
      summary: `Paused after ${stageRun.stage}`,
      detail: reason,
    });
  }

  // ─── Linear lifecycle ─────────────────────────────────────────────

  private async markStageActive(
    project: AppConfig["projects"][number],
    issue: TrackedIssueRecord,
    stage: WorkflowStage,
  ): Promise<void> {
    const activeState = resolveActiveLinearState(project, stage, issue.selectedWorkflowId);
    const linear = await this.linearProvider.forProject(issue.projectId);
    if (!activeState || !linear) return;

    await linear.setIssueState(issue.linearIssueId, activeState);
    const labels = resolveWorkflowLabelNames(project, "working");
    if (labels.add.length > 0 || labels.remove.length > 0) {
      await linear.updateIssueLabels({
        issueId: issue.linearIssueId,
        ...(labels.add.length > 0 ? { addNames: labels.add } : {}),
        ...(labels.remove.length > 0 ? { removeNames: labels.remove } : {}),
      });
    }
    this.db.upsertIssue({
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      currentLinearState: activeState,
      lifecycleStatus: "running",
    });
  }

  private async publishStageStarted(issue: TrackedIssueRecord, stage: WorkflowStage): Promise<boolean> {
    if (!issue.activeAgentSessionId) return false;
    const linear = await this.linearProvider.forProject(issue.projectId);
    if (!linear) return false;
    try {
      const externalUrls = buildAgentSessionExternalUrls(this.config, issue.issueKey);
      await linear.updateAgentSession?.({
        agentSessionId: issue.activeAgentSessionId,
        ...(externalUrls ? { externalUrls } : {}),
        plan: buildRunningSessionPlan(stage),
      });
      await linear.createAgentActivity({
        agentSessionId: issue.activeAgentSessionId,
        content: { type: "response", body: `PatchRelay started the ${stage} workflow.` },
      });
      return true;
    } catch {
      return false;
    }
  }


  private async publishStageCompletion(stageRun: StageRunRecord): Promise<void> {
    const issue = this.db.getIssue(stageRun.projectId, stageRun.linearIssueId);
    if (!issue) return;
    const trackedIssue = this.db.issueToTrackedIssue(issue);

    if (issue.desiredStage) {
      const linear = await this.linearProvider.forProject(stageRun.projectId);
      if (trackedIssue.activeAgentSessionId && linear) {
        await this.updateAgentSession(linear, trackedIssue, buildPreparingSessionPlan(issue.desiredStage));
      }
      this.feed?.publish({
        level: "info",
        kind: "stage",
        issueKey: issue.issueKey,
        projectId: issue.projectId,
        stage: stageRun.stage,
        nextStage: issue.desiredStage,
        status: "queued",
        summary: `Completed ${stageRun.stage} workflow and queued ${issue.desiredStage}`,
      });
      await this.publishAgentCompletion(trackedIssue, {
        type: "thought",
        body: `The ${stageRun.stage} workflow finished. PatchRelay is preparing the ${issue.desiredStage} workflow next.`,
      });
      this.enqueueIssue(stageRun.projectId, stageRun.linearIssueId);
      return;
    }

    const project = this.config.projects.find((p) => p.id === stageRun.projectId);
    const activeState = project ? resolveActiveLinearState(project, stageRun.stage, issue.selectedWorkflowId) : undefined;
    const linear = project ? await this.linearProvider.forProject(stageRun.projectId) : undefined;

    if (linear && project && activeState) {
      try {
        const linearIssue = await linear.getIssue(stageRun.linearIssueId);
        if (linearIssue.stateName?.trim().toLowerCase() === activeState.trim().toLowerCase()) {
          const labels = resolveWorkflowLabelNames(project, "awaitingHandoff");
          if (labels.add.length > 0 || labels.remove.length > 0) {
            await linear.updateIssueLabels({
              issueId: stageRun.linearIssueId,
              ...(labels.add.length > 0 ? { addNames: labels.add } : {}),
              ...(labels.remove.length > 0 ? { removeNames: labels.remove } : {}),
            });
          }
          this.db.upsertIssue({ projectId: stageRun.projectId, linearIssueId: stageRun.linearIssueId, lifecycleStatus: "paused" });

          let deliveredToSession = false;
          if (trackedIssue.activeAgentSessionId) {
            deliveredToSession = await this.updateAgentSession(linear, trackedIssue, buildAwaitingHandoffSessionPlan(stageRun.stage));
          }
          this.feed?.publish({
            level: "info",
            kind: "stage",
            issueKey: issue.issueKey,
            projectId: issue.projectId,
            stage: stageRun.stage,
            status: "handoff",
            summary: `Completed ${stageRun.stage} workflow`,
            detail: `Waiting for a Linear state change while issue remains in ${activeState}.`,
          });
          await this.publishAgentCompletion(trackedIssue, {
            type: "elicitation",
            body: `PatchRelay finished the ${stageRun.stage} workflow. Move the issue or leave a follow-up prompt to continue.`,
          });
          return;
        }
        const cleanup = resolveWorkflowLabelCleanup(project);
        if (cleanup.remove.length > 0) {
          await linear.updateIssueLabels({ issueId: stageRun.linearIssueId, removeNames: cleanup.remove });
        }
      } catch (error) {
        this.logger.warn(
          { issueKey: issue.issueKey, error: sanitizeDiagnosticText(error instanceof Error ? error.message : String(error)) },
          "Stage completed but PatchRelay could not finish the final Linear sync",
        );
      }
    }

    // Final fallback completion path
    let deliveredToSession = false;
    if (trackedIssue.activeAgentSessionId && linear) {
      deliveredToSession = await this.updateAgentSession(
        linear,
        trackedIssue,
        trackedIssue.lifecycleStatus === "paused"
          ? buildAwaitingHandoffSessionPlan(stageRun.stage)
          : buildCompletedSessionPlan(stageRun.stage),
      );
    }
    this.feed?.publish({
      level: "info",
      kind: "stage",
      issueKey: issue.issueKey,
      projectId: issue.projectId,
      stage: stageRun.stage,
      status: "completed",
      summary: `Completed ${stageRun.stage} workflow`,
    });
    await this.publishAgentCompletion(trackedIssue, {
      type: trackedIssue.lifecycleStatus === "paused" ? "elicitation" : "response",
      body: trackedIssue.lifecycleStatus === "paused"
        ? `PatchRelay finished the ${stageRun.stage} workflow and now needs human input.`
        : `PatchRelay finished the ${stageRun.stage} workflow.`,
    });
  }

  private async updateAgentSession(
    linear: NonNullable<Awaited<ReturnType<LinearClientProvider["forProject"]>>>,
    issue: TrackedIssueRecord,
    plan: ReturnType<typeof buildRunningSessionPlan>,
  ): Promise<boolean> {
    if (!issue.activeAgentSessionId || !linear.updateAgentSession) return false;
    try {
      const externalUrls = buildAgentSessionExternalUrls(this.config, issue.issueKey);
      await linear.updateAgentSession({
        agentSessionId: issue.activeAgentSessionId,
        ...(externalUrls ? { externalUrls } : {}),
        plan,
      });
      return true;
    } catch {
      return false;
    }
  }

  private async publishAgentCompletion(
    issue: TrackedIssueRecord,
    content: { type: "thought" | "elicitation" | "response"; body: string },
  ): Promise<boolean> {
    if (!issue.activeAgentSessionId) return false;
    const linear = await this.linearProvider.forProject(issue.projectId);
    if (!linear) return false;
    try {
      await linear.createAgentActivity({ agentSessionId: issue.activeAgentSessionId, content });
      return true;
    } catch {
      return false;
    }
  }
}

function buildRestartRecoveryPrompt(stage: string): string {
  return [
    `PatchRelay restarted while the ${stage} workflow was mid-turn.`,
    "Resume the existing work from the current worktree state on this same thread.",
    "Inspect any uncommitted changes you already made before continuing.",
    "Continue from the interrupted point instead of restarting the task from scratch.",
    "When the work is actually complete, finish the normal workflow handoff for this stage.",
  ].join("\n");
}
