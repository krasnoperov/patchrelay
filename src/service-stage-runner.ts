import type { Logger } from "pino";
import type { CodexAppServerClient } from "./codex-app-server.ts";
import type { StageEventQueryStoreProvider, StageTurnInputStoreProvider } from "./stage-event-ports.ts";
import type { IssueWorkflowExecutionStoreProvider, IssueWorkflowLifecycleStoreProvider } from "./workflow-ports.ts";
import { buildStageLaunchPlan, isCodexThreadId } from "./stage-launch.ts";
import { syncFailedStageToLinear } from "./stage-failure.ts";
import { buildFailedStageReport } from "./stage-reporting.ts";
import { StageLifecyclePublisher } from "./stage-lifecycle-publisher.ts";
import { StageTurnInputDispatcher } from "./stage-turn-input-dispatcher.ts";
import type { AppConfig, LinearClientProvider, StageRunRecord, TrackedIssueRecord } from "./types.ts";
import { WorktreeManager } from "./worktree-manager.ts";

export interface IssueQueueItem {
  projectId: string;
  issueId: string;
}

export class ServiceStageRunner {
  private readonly worktreeManager: WorktreeManager;
  private readonly inputDispatcher: StageTurnInputDispatcher;
  private readonly lifecyclePublisher: StageLifecyclePublisher;

  constructor(
    private readonly config: AppConfig,
    private readonly stores: IssueWorkflowExecutionStoreProvider &
      IssueWorkflowLifecycleStoreProvider &
      StageTurnInputStoreProvider &
      StageEventQueryStoreProvider,
    private readonly codex: CodexAppServerClient,
    private readonly linearProvider: LinearClientProvider,
    private readonly logger: Logger,
  ) {
    this.worktreeManager = new WorktreeManager(config);
    this.inputDispatcher = new StageTurnInputDispatcher(stores, codex, logger);
    this.lifecyclePublisher = new StageLifecyclePublisher(config, stores, linearProvider, logger);
  }

  async run(item: IssueQueueItem): Promise<void> {
    const project = this.config.projects.find((candidate) => candidate.id === item.projectId);
    if (!project) {
      return;
    }

    const issue = this.stores.issueWorkflows.getTrackedIssue(item.projectId, item.issueId);
    if (!issue || !issue.desiredStage || !issue.desiredWebhookId || issue.activeStageRunId) {
      return;
    }

    const plan = buildStageLaunchPlan(project, issue, issue.desiredStage);
    const claim = this.stores.issueWorkflows.claimStageRun({
      projectId: item.projectId,
      linearIssueId: item.issueId,
      stage: issue.desiredStage,
      triggerWebhookId: issue.desiredWebhookId,
      branchName: plan.branchName,
      worktreePath: plan.worktreePath,
      workflowFile: plan.workflowFile,
      promptText: plan.prompt,
    });
    if (!claim) {
      return;
    }

    let threadLaunch;
    let turn;
    try {
      await this.worktreeManager.ensureIssueWorktree(project.repoPath, project.worktreeRoot, plan.worktreePath, plan.branchName);
      await this.lifecyclePublisher.markStageActive(project, claim.issue, claim.stageRun);

      threadLaunch = await this.launchStageThread(item.projectId, item.issueId, claim.stageRun.id, plan.worktreePath, issue.issueKey);
      turn = await this.codex.startTurn({
        threadId: threadLaunch.threadId,
        cwd: plan.worktreePath,
        input: plan.prompt,
      });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      await this.markLaunchFailed(project, claim.issue, claim.stageRun, err.message, threadLaunch?.threadId);
      this.logger.error(
        {
          issueKey: issue.issueKey,
          stage: claim.stageRun.stage,
          worktreePath: plan.worktreePath,
          branchName: plan.branchName,
          error: err.message,
          stack: err.stack,
        },
        "Failed to launch Codex stage run",
      );
      throw err;
    }

    this.stores.issueWorkflows.updateStageRunThread({
      stageRunId: claim.stageRun.id,
      threadId: threadLaunch.threadId,
      ...(threadLaunch.parentThreadId ? { parentThreadId: threadLaunch.parentThreadId } : {}),
      turnId: turn.turnId,
    });

    this.inputDispatcher.routePendingInputs(claim.stageRun.id, threadLaunch.threadId, turn.turnId);
    const pendingLaunchInput = this.stores.issueWorkflows.consumeIssuePendingLaunchInput(item.projectId, item.issueId);
    if (pendingLaunchInput) {
      this.stores.stageEvents.enqueueTurnInput({
        stageRunId: claim.stageRun.id,
        threadId: threadLaunch.threadId,
        turnId: turn.turnId,
        source: "linear-agent-launch",
        body: pendingLaunchInput,
      });
    }
    await this.inputDispatcher.flush(
      { id: claim.stageRun.id, threadId: threadLaunch.threadId, turnId: turn.turnId },
      {
        logFailures: true,
        failureMessage: "Failed to deliver queued Linear comment during stage startup",
        ...(claim.issue.issueKey ? { issueKey: claim.issue.issueKey } : {}),
      },
    );
    await this.lifecyclePublisher.refreshRunningStatusComment(item.projectId, item.issueId, claim.stageRun.id, issue.issueKey);
    await this.lifecyclePublisher.publishStageStarted(claim.issue, claim.stageRun.stage);

    this.logger.info(
      {
        issueKey: issue.issueKey,
        stage: claim.stageRun.stage,
        worktreePath: plan.worktreePath,
        branchName: plan.branchName,
        threadId: threadLaunch.threadId,
        turnId: turn.turnId,
      },
      "Started Codex stage run",
    );
  }

  private async launchStageThread(
    projectId: string,
    issueId: string,
    stageRunId: number,
    worktreePath: string,
    issueKey?: string,
  ): Promise<{ threadId: string; parentThreadId?: string }> {
    const previousStageRun = this.stores.issueWorkflows
      .listStageRunsForIssue(projectId, issueId)
      .filter((stageRun) => stageRun.id !== stageRunId)
      .at(-1);
    const parentThreadId =
      previousStageRun?.status === "completed" && isCodexThreadId(previousStageRun.threadId)
        ? previousStageRun.threadId
        : undefined;

    if (parentThreadId) {
      try {
        const thread = await this.codex.forkThread(parentThreadId, worktreePath);
        return {
          threadId: thread.id,
          parentThreadId,
        };
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        this.logger.warn(
          {
            issueKey,
            parentThreadId,
            error: err.message,
          },
          "Falling back to a fresh Codex thread after parent thread fork failed",
        );
      }
    }

    const thread = await this.codex.startThread({ cwd: worktreePath });
    return {
      threadId: thread.id,
    };
  }

  private async markLaunchFailed(
    project: AppConfig["projects"][number],
    issue: TrackedIssueRecord,
    stageRun: StageRunRecord,
    message: string,
    threadId?: string,
  ): Promise<void> {
    const failureThreadId = threadId ?? `launch-failed-${stageRun.id}`;
    this.stores.issueWorkflows.finishStageRun({
      stageRunId: stageRun.id,
      status: "failed",
      threadId: failureThreadId,
      summaryJson: JSON.stringify({ message }),
      reportJson: JSON.stringify(buildFailedStageReport(stageRun, "failed", { threadId: failureThreadId })),
    });

    await syncFailedStageToLinear({
      stores: this.stores,
      linearProvider: this.linearProvider,
      project,
      issue,
      stageRun: {
        ...stageRun,
        threadId: failureThreadId,
      },
      message,
      mode: "launch",
    });
  }
}
